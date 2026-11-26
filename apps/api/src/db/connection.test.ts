import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { bindTenantSearchPath } from './connection.js'
import { currentTenantContext, organizationSchemaName, runWithTenantContext } from './tenant-context.js'

const organizationId = '11111111-1111-4111-8111-111111111111'
const schemaName = organizationSchemaName(organizationId)

function fixture(failure?: 'set' | 'reset' | 'query') {
  const calls: unknown[][] = []
  const releases: unknown[] = []
  const pool = bindTenantSearchPath({
    async connect() {
      return {
        async query(sql: string, values?: unknown[]) {
          calls.push([sql, values])
          if ((failure === 'set' && sql.includes('set_config')) || (failure === 'reset' && sql === 'RESET search_path') || (failure === 'query' && sql === 'work')) throw new Error(failure)
          return { rows: [{ schema: values?.[1] }] }
        },
        release(error?: unknown) { releases.push(error) },
      }
    },
  } as unknown as Pool)
  return { pool, calls, releases }
}

test('concurrent enterprise and public queries bind their own context before executing', async () => {
  const { pool, calls, releases } = fixture()
  await Promise.all([
    runWithTenantContext({ organizationId, schemaName }, () => pool.query('tenant work')),
    pool.query('public work'),
  ])
  assert.deepEqual(calls.filter(([sql]) => String(sql).includes('set_config')).map(([, values]) => values), [
    ['search_path', `"${schemaName}",public`], ['search_path', 'public'],
  ])
  assert.equal(releases.length, 2)
  assert.equal(currentTenantContext(), undefined)
})

test('schema setup failure and reset failure both evict the connection', async () => {
  const setup = fixture('set')
  await assert.rejects(setup.pool.query('work'), /set/)
  assert.deepEqual(setup.releases, [true])
  const reset = fixture('reset')
  await reset.pool.query('work')
  assert.deepEqual(reset.releases, [true])
})

test('query failures release the connection and callback query mode remains supported', async () => {
  const broken = fixture('query')
  await assert.rejects(broken.pool.query('work'), /query/)
  assert.equal(broken.releases.length, 1)
  const { pool, calls } = fixture()
  await new Promise<void>((resolve, reject) => pool.query('callback work', (error) => error ? reject(error) : resolve()))
  assert.equal(calls[1]?.[0], 'callback work')
})

test('explicitly broken clients are destroyed without attempting another query', async () => {
  const { pool, calls, releases } = fixture()
  const client = await pool.connect()
  client.release(true)
  assert.deepEqual(releases, [true])
  assert.equal(calls.length, 1)
  assert.throws(() => client.release(), /already been released/)
})

test('schema context rejects names that do not belong to the enterprise', () => {
  assert.throws(() => runWithTenantContext({ organizationId, schemaName: 'public' }, () => undefined), /INVALID_TENANT_SCHEMA/)
  assert.throws(() => runWithTenantContext({ organizationId, schemaName: 'company_' + '2'.repeat(32) }, () => undefined), /INVALID_TENANT_SCHEMA/)
})
