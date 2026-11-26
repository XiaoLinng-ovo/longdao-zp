import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createWorkerTenantPool } from '../src/db/pool.js'

const schema = 'company_' + 'a'.repeat(32)
function fixture(failAt = '') {
  const calls: string[] = []
  const released: unknown[] = []
  let ended = false
  const base = {
    async connect() {
      return {
        async query(sql: string, values?: unknown[]) {
          calls.push(sql)
          if (sql === failAt) throw new Error('database failure')
          if (sql.startsWith('SELECT set_config')) assert.deepEqual(values, ['search_path', '"' + schema + '",public'])
          return { rows: [{ value: 1 }] }
        },
        release(error?: unknown) { released.push(error) },
      }
    },
    async end() { ended = true },
  } as unknown as Pool
  return { pool: createWorkerTenantPool({}, schema, base), calls, released, ended: () => ended }
}
test('tenant queries set and reset the path, without ending the shared connection pool', async () => {
  const f = fixture()
  const result = await f.pool.query('SELECT 1')
  assert.equal(result.rows[0].value, 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, ['SELECT set_config($1,$2,false)', 'SELECT 1', 'RESET search_path'])
  assert.deepEqual(f.released, [undefined])
  await f.pool.end()
  assert.equal(f.ended(), false)
})
test('reset failures destroy the leased connection and initialization failures never leak a client', async () => {
  for (const sql of ['RESET search_path', 'SELECT set_config($1,$2,false)']) {
    const f = fixture(sql)
    if (sql.startsWith('SELECT')) await assert.rejects(f.pool.query('SELECT 1'))
    else await f.pool.query('SELECT 1')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.released, [true])
  }
})
test('callback leases and query failures release the connection exactly once', async () => {
  const f = fixture('BROKEN')
  await assert.rejects(f.pool.query('BROKEN'))
  await new Promise(resolve => setImmediate(resolve))
  await new Promise<void>((resolve, reject) => f.pool.connect((error, client, release) => {
    if (error) { reject(error); return }
    assert.ok(client)
    release()
    assert.throws(() => client.release(), /already been released/)
    resolve()
  }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.released.length, 2)
})
test('untrusted company paths are rejected before acquiring connections', () => {
  assert.throws(() => createWorkerTenantPool({}, 'public; DROP SCHEMA public'), /INVALID_TENANT_SCHEMA/)
})
