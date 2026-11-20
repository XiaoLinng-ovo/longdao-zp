import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { Pool } from 'pg'
import { inspectMigrations, inspectMigrationApproval, runMigrations } from './migrations.js'
import type { MigrationApprovalSnapshot } from './migrations.js'

test('upstream migrations follow the saved local audio and candidate migrations without changing their ledger', async () => {
  const directory = fileURLToPath(new URL('../../../../../db/migrations/', import.meta.url))
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  const existing = names.filter(name => name < '0056_').map(name => ({ version: name.split('_')[0]!, name }))
  assert.ok(existing.some(row => row.name === '0050_live_audio_transcription_queue.sql'))
  assert.ok(existing.some(row => row.name === '0051_candidate_manual_name.sql'))
  const recorded: unknown[][] = []
  let released = false
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('to_regclass')) return { rows: [{ ledger: 'schema_migrations' }] }
      if (sql === 'SELECT version, name FROM schema_migrations ORDER BY version') return { rows: existing }
      if (sql.startsWith('INSERT INTO schema_migrations')) recorded.push(values!)
      return { rows: [] }
    },
    release() { released = true },
  }
  const pool = { connect: async () => client } as unknown as Pool
  const result = await runMigrations(pool, directory)
  assert.deepEqual(result.alreadyApplied, existing.map(row => row.name))
  const pending = names.filter(name => name >= '0056_')
  assert.ok(pending.includes('0057_interview_question_preparations.sql'))
  assert.ok(pending.includes('0058_interview_question_preparation_diagnostics.sql'))
  assert.deepEqual(result.applied, pending)
  assert.deepEqual(recorded, result.applied.map(name => [name.split('_')[0], name]))
  assert.equal(released, true)
})

async function withMigrationFiles(names: string[], action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'migration-status-'))
  try {
    for (const name of names) await writeFile(join(directory, name), 'SELECT 1;')
    await action(directory)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

function inspectionPool(ledgerExists: boolean, rows: {version: string; name: string}[] = []) {
  const queries: string[] = []
  let released = false
  const pool = { connect: async () => ({
    async query(sql: string) {
      assert.match(sql, /^SELECT /)
      queries.push(sql)
      return { rows: sql.includes('to_regclass') ? [{ledger: ledgerExists ? 'schema_migrations' : null}] : rows }
    },
    release() { released = true },
  }) } as unknown as Pool
  return { pool, queries, get released() { return released } }
}

test('migration inspection without a ledger reports pending SQL without creating anything', async () => {
  await withMigrationFiles(['0001_first.sql', '0002_second.sql'], async directory => {
    const fixture = inspectionPool(false)
    assert.deepEqual(await inspectMigrations(fixture.pool, directory), {
      applied: [], pending: ['0001_first.sql','0002_second.sql'], ledgerExists: false,
    })
    assert.equal(fixture.queries.length, 1)
    assert.equal(fixture.released, true)
  })
})

test('migration inspection separates applied and pending files and releases its connection', async () => {
  await withMigrationFiles(['0001_first.sql', '0002_second.sql'], async directory => {
    const fixture = inspectionPool(true, [{version:'0001',name:'0001_first.sql'}])
    assert.deepEqual(await inspectMigrations(fixture.pool, directory), {
      applied:['0001_first.sql'], pending:['0002_second.sql'], ledgerExists:true,
    })
    assert.equal(fixture.queries.length, 2)
    assert.equal(fixture.released, true)
  })
})

test('migration inspection rejects a conflicting recorded version and releases its connection', async () => {
  await withMigrationFiles(['0001_first.sql'], async directory => {
    const fixture = inspectionPool(true, [{version:'0001',name:'0001_different.sql'}])
    await assert.rejects(inspectMigrations(fixture.pool, directory), /is recorded as/)
    assert.equal(fixture.released, true)
  })
})

test('migration inspection rejects invalid names or duplicate versions before connecting', async () => {
  for (const names of [['broken.sql'],['0001_first.sql','0001_duplicate.sql'],['1_first.sql','0001_alias.sql']]) {
    await withMigrationFiles(names, async directory => {
      const pool = {connect:async()=>{throw Error('Must not connect')}} as unknown as Pool
      await assert.rejects(inspectMigrations(pool, directory), /Invalid migration filename|Duplicate migration version/)
    })
  }
})

test('migration inspection rejects unknown database versions instead of accepting a downgrade', async () => {
  await withMigrationFiles(['0001_first.sql'], async directory => {
    const fixture = inspectionPool(true, [{ version: '9999', name: '9999_future.sql' }])
    await assert.rejects(inspectMigrations(fixture.pool, directory), /Unknown database migration/)
    assert.equal(fixture.released, true)
  })
})

for (const ledgerExists of [false, true]) {
  test('migration refuses populated schema with ' + (ledgerExists ? 'empty' : 'missing') + ' ledger before mutation', async () => {
    await withMigrationFiles(['0001_first.sql'], async directory => {
      const queries: string[] = []
      let released = false
      const pool = { connect: async () => ({
        async query(sql: string) {
          queries.push(sql)
          if (sql.includes('to_regclass')) return { rows: [{ ledger: ledgerExists ? 'schema_migrations' : null }] }
          if (sql.includes('pg_catalog.pg_class c')) return { rows: [{ relname: 'existing_business_data' }] }
          return { rows: [] }
        },
        release() { released = true },
      }) } as unknown as Pool
      await assert.rejects(runMigrations(pool, directory), /MIGRATION_BASELINE_REQUIRED/)
      assert.equal(queries.some(sql => /CREATE|INSERT|BEGIN|COMMIT/.test(sql)), false)
      assert.match(queries.at(-1)!, /pg_advisory_unlock/)
      assert.equal(released, true)
    })
  })
}

test('failed ledger writes roll back the wrapped migration and a failed rollback discards its connection', async () => {
  await withMigrationFiles(['0001_first.sql'], async directory => {
    await writeFile(join(directory, '0001_first.sql'), 'BEGIN; CREATE TABLE synthetic_table(id int); COMMIT;')
    for (const rollbackFails of [false, true]) {
      const queries: string[] = [], releases: boolean[] = []
      const pool = { connect: async () => ({
        async query(sql: string) {
          queries.push(sql)
          if (sql.includes('to_regclass')) return { rows: [{ ledger: null }] }
          if (sql.startsWith('INSERT INTO schema_migrations')) throw new Error('synthetic ledger failure')
          if (sql === 'ROLLBACK' && rollbackFails) throw new Error('synthetic rollback failure')
          return { rows: [] }
        },
        release(broken: boolean) { releases.push(broken) },
      }) } as unknown as Pool
      await assert.rejects(runMigrations(pool, directory), /synthetic ledger failure/)
      assert.equal(queries.includes('COMMIT'), false)
      const ddl = queries.find(sql => sql.includes('CREATE TABLE synthetic_table'))!
      assert.ok(ddl.includes('CREATE TABLE synthetic_table'))
      assert.doesNotMatch(ddl, /BEGIN|COMMIT/)
      assert.equal(queries.at(-2), 'ROLLBACK')
      assert.deepEqual(releases, [rollbackFails])
    }
  })
})

function approvalFixture() {
  const identity = { database: 'synthetic', databaseOid: '123', serverAddress: '127.0.0.1', serverPort: 55432 }
  const state = { identity, ledger: [{ version: '0001', name: '0001_first.sql' }], queries: [] as string[], released: false }
  const pool = { connect: async () => ({
    async query(sql: string) {
      state.queries.push(sql)
      if (sql.includes('to_regclass')) return { rows: [{ ledger: 'schema_migrations' }] }
      if (sql.includes('pg_catalog.pg_database')) return { rows: [state.identity] }
      if (/SELECT version, ?name FROM (public\.)?schema_migrations/.test(sql)) return { rows: state.ledger.map(row => ({ ...row })) }
      return { rows: [] }
    },
    release() { state.released = true },
  }) } as unknown as Pool
  return { pool, state }
}

test('maintenance approval inspection is read-only and fingerprints every SQL file', async () => {
  await withMigrationFiles(['0001_first.sql', '0002_second.sql'], async directory => {
    const { pool, state } = approvalFixture()
    const approval = await inspectMigrationApproval(pool, directory)
    assert.deepEqual(approval.identity, state.identity)
    assert.deepEqual(approval.pending, ['0002_second.sql'])
    assert.equal(approval.files.length, 2)
    assert.match(approval.files[0]!.sha256, /^[a-f0-9]{64}$/)
    assert.equal(state.queries.some(sql => /CREATE|INSERT|UPDATE|DELETE/.test(sql)), false)
    assert.equal(state.released, true)
  })
})

for (const mutation of ['target', 'ledger', 'file', 'extra-file', 'pending']) {
  test('approved maintenance rejects changed ' + mutation + ' under the migration lock before DDL', async () => {
    await withMigrationFiles(['0001_first.sql', '0002_second.sql'], async directory => {
      const { pool, state } = approvalFixture()
      const approval = await inspectMigrationApproval(pool, directory)
      state.queries.length = 0; state.released = false
      if (mutation === 'target') state.identity = { ...state.identity, databaseOid: '999' }
      if (mutation === 'ledger') state.ledger.push({ version: '0002', name: '0002_second.sql' })
      if (mutation === 'file') await writeFile(join(directory, '0001_first.sql'), 'SELECT 2;')
      if (mutation === 'extra-file') await writeFile(join(directory, '0003_extra.sql'), 'SELECT 3;')
      if (mutation === 'pending') approval.pending = []
      const reason = mutation === 'target' ? 'TARGET' : mutation === 'ledger' ? 'LEDGER' : mutation === 'pending' ? 'PENDING' : 'FILES'
      await assert.rejects(runMigrations(pool, directory, { approval }), new RegExp('MIGRATION_APPROVAL_' + reason + '_CHANGED'))
      assert.equal(state.queries.some(sql => /CREATE|INSERT|BEGIN|COMMIT/.test(sql)), false)
      assert.match(state.queries[0]!, /pg_advisory_lock/)
      assert.match(state.queries.at(-1)!, /pg_advisory_unlock/)
      assert.equal(state.released, true)
    })
  })
}

test('matching maintenance approval executes only its pending SQL and ledger write', async () => {
  await withMigrationFiles(['0001_first.sql', '0002_second.sql'], async directory => {
    const { pool, state } = approvalFixture()
    const approval: MigrationApprovalSnapshot = await inspectMigrationApproval(pool, directory)
    state.queries.length = 0
    const result = await runMigrations(pool, directory, { approval })
    assert.deepEqual(result, { applied: ['0002_second.sql'], alreadyApplied: ['0001_first.sql'] })
    assert.equal(state.queries.filter(sql => sql === 'SELECT 1;').length, 1)
    assert.equal(state.queries.filter(sql => sql.startsWith('INSERT INTO schema_migrations')).length, 1)
  })
})
