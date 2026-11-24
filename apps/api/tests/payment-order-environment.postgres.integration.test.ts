import { assertDisposableTestDatabase } from './helpers/disposable-database.js';
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createDatabasePool } from '../src/db/connection.js'

// Opt in explicitly: all fixtures and DDL live in a transaction that is rolled back.
test('payment environment repair backfills missing snapshots without rewriting existing ones', {
  skip: process.env.PAYMENT_MIGRATION_PROBE !== 'true',
}, async () => {
  assertDisposableTestDatabase();
  const pool = createDatabasePool()
  const db = await pool.connect()
  const schema = 'payment_repair_' + randomUUID().replaceAll('-', '')
  try {
    await db.query('BEGIN')
    await db.query('SET LOCAL lock_timeout = \'3s\'')
    await db.query(`CREATE SCHEMA ${schema}`)
    await db.query(`CREATE TABLE ${schema}.payment_providers (id integer PRIMARY KEY, environment text NOT NULL)`)
    await db.query(`CREATE TABLE ${schema}.payment_orders (id integer PRIMARY KEY, provider_id integer NOT NULL)`)
    await db.query(`INSERT INTO ${schema}.payment_providers VALUES (1, 'production'), (2, 'sandbox')`)
    await db.query(`INSERT INTO ${schema}.payment_orders VALUES (1, 1), (2, 2)`)
    const source = await readFile(new URL('../../../../db/migrations/0087_repair_payment_order_environment.sql', import.meta.url), 'utf8')
    const sql = source.replaceAll('public.', schema + '.').replaceAll("table_schema = 'public'", `table_schema = '${schema}'`)
    await db.query(sql)
    assert.deepEqual((await db.query(`SELECT id, environment FROM ${schema}.payment_orders ORDER BY id`)).rows,
      [{ id: 1, environment: 'production' }, { id: 2, environment: 'sandbox' }])

    await db.query(`INSERT INTO ${schema}.payment_orders(id, provider_id) VALUES (3, 1)`)
    assert.equal((await db.query(`SELECT environment FROM ${schema}.payment_orders WHERE id = 3`)).rows[0].environment, 'production')
    for (const value of ['invalid', null]) {
      await db.query('SAVEPOINT invalid_environment')
      await assert.rejects(db.query(`INSERT INTO ${schema}.payment_orders VALUES (4, 1, $1)`, [value]),
        (error: { code?: string }) => error.code === (value === null ? '23502' : '23514'))
      await db.query('ROLLBACK TO SAVEPOINT invalid_environment')
    }

    // A channel may have changed since the snapshot; rerunning must preserve the order.
    await db.query(`UPDATE ${schema}.payment_orders SET environment = 'sandbox' WHERE id = 1`)
    await db.query(sql)
    assert.equal((await db.query(`SELECT environment FROM ${schema}.payment_orders WHERE id = 1`)).rows[0].environment, 'sandbox')
  } finally {
    await db.query('ROLLBACK')
    db.release()
    await pool.end()
  }
})
