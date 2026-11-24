import { assertDisposableTestDatabase } from './helpers/disposable-database.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Pool } from 'pg'
import { loadDatabaseConfig } from '../src/db/config.js'
import { inspectMigrations, runMigrations } from '../src/db/migrations.js'

for (const emptyLedger of [false, true]) {
  test('isolated PostgreSQL: nonempty database with ' + (emptyLedger ? 'empty' : 'missing') + ' ledger refuses replay without mutations', async () => {
    assertDisposableTestDatabase()
    const config = loadDatabaseConfig()
    const base = new Pool(config)
    const schema = 'migration_probe_' + randomUUID().replaceAll('-', '')
    const directory = await mkdtemp(join(tmpdir(), 'migration-baseline-'))
    let migrations: Pool | undefined
    try {
      await base.query('CREATE SCHEMA "' + schema + '"')
      migrations = new Pool({ ...config, options: '-c search_path=' + schema })
      await migrations.query('CREATE TABLE existing_business_data (id integer PRIMARY KEY); INSERT INTO existing_business_data VALUES (1)')
      if (emptyLedger) await migrations.query('CREATE TABLE schema_migrations (version text PRIMARY KEY, name text NOT NULL UNIQUE, applied_at timestamptz NOT NULL DEFAULT now())')
      const before = (await migrations.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema])).rows
      await writeFile(join(directory, '0001_first.sql'), 'INSERT INTO existing_business_data VALUES (2);')
      await assert.rejects(runMigrations(migrations, directory), /MIGRATION_BASELINE_REQUIRED/)
      assert.deepEqual((await migrations.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema])).rows, before)
      assert.deepEqual((await migrations.query('SELECT id FROM existing_business_data')).rows, [{ id: 1 }])
      if (emptyLedger) assert.equal((await migrations.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 0)
      else assert.equal((await migrations.query("SELECT to_regclass('schema_migrations') AS ledger")).rows[0].ledger, null)
    } finally {
      await migrations?.end()
      await base.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE')
      await base.end()
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('isolated PostgreSQL: concurrent migrations apply once; failures roll back and retries resume', async () => {
  assertDisposableTestDatabase()
  const config = loadDatabaseConfig()
  const base = new Pool(config)
  const schema = 'migration_probe_' + randomUUID().replaceAll('-', '')
  const directory = await mkdtemp(join(tmpdir(), 'migration-postgres-'))
  let migrations: Pool | undefined
  let readonly: Pool | undefined
  try {
    await base.query('CREATE SCHEMA "' + schema + '"')
    migrations = new Pool({...config, options: '-c search_path=' + schema})
    await writeFile(join(directory, '0001_probe.sql'), 'CREATE TABLE migration_probe (id integer PRIMARY KEY); INSERT INTO migration_probe VALUES (1);')
    const results = await Promise.all([runMigrations(migrations, directory), runMigrations(migrations, directory)])
    assert.equal(results.reduce((total, result) => total + result.applied.length, 0), 1)
    assert.equal(results.reduce((total, result) => total + result.alreadyApplied.length, 0), 1)
    assert.equal((await migrations.query('SELECT count(*)::int AS count FROM migration_probe')).rows[0].count, 1)
    await writeFile(join(directory, '0002_retry.sql'), 'INSERT INTO migration_probe VALUES (2); SELECT * FROM missing_migration_probe_table;')
    await assert.rejects(runMigrations(migrations, directory), /Migration 0002_retry.sql failed/)
    assert.deepEqual((await migrations.query('SELECT id FROM migration_probe ORDER BY id')).rows, [{id:1}])
    assert.deepEqual((await migrations.query('SELECT version FROM schema_migrations ORDER BY version')).rows, [{version:'0001'}])
    await writeFile(join(directory, '0002_retry.sql'), 'INSERT INTO migration_probe VALUES (2);')
    assert.deepEqual(await runMigrations(migrations, directory), {applied:['0002_retry.sql'],alreadyApplied:['0001_probe.sql']})
    assert.deepEqual(await runMigrations(migrations, directory), {applied:[],alreadyApplied:['0001_probe.sql','0002_retry.sql']})
    assert.deepEqual((await migrations.query('SELECT id FROM migration_probe ORDER BY id')).rows, [{id:1},{id:2}])
    // The status command checks the public ledger even when a tenant search_path is active.
    await rm(join(directory, '0001_probe.sql'))
    await rm(join(directory, '0002_retry.sql'))
    await writeFile(join(directory, '999901_status_probe.sql'), 'SELECT 1;')
    readonly = new Pool({...config, options:'-c default_transaction_read_only=on -c search_path=' + schema})
    await assert.rejects(inspectMigrations(readonly, directory), /Unknown database migration/)
    const actual = fileURLToPath(new URL('../../../../db/migrations/', import.meta.url))
    // The local manifest must include every recorded public version, not just the probe.
    for (const name of (await readdir(actual)).filter(name => name.endsWith('.sql'))) await writeFile(join(directory, name), 'SELECT 1;')
    const status = await inspectMigrations(readonly, directory)
    assert.deepEqual(status.pending, ['999901_status_probe.sql'])
    assert.equal((await readonly.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on')
  } finally {
    await readonly?.end()
    await migrations?.end()
    await base.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE')
    await base.end()
    await rm(directory, {recursive:true, force:true})
  }
})
