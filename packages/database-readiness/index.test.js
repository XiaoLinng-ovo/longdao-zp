import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertReleaseReady, listMigrationFiles, validateMigrationLedger } from './index.js'
import { compareStructure } from './structure-contract.js'

const location = 'a'.repeat(64)
const migrationsDirectory = fileURLToPath(new URL('../../db/migrations/', import.meta.url))
const contract = JSON.parse(await readFile(new URL('./structure-contract.json', import.meta.url), 'utf8'))

test('compatibility tolerates audited line endings and constraint ordering, not changed definitions', () => {
  const before = contract.public.filter(row => ['set_updated_at()', 'organization_schemas', 'guard_object_reference()'].includes(row.name))
  const actual = structuredClone(before)
  const [audited, guard, relation] = ['set_updated_at()', 'guard_object_reference()', 'organization_schemas'].map(name => actual.find(row => row.name === name))
  audited.detail.source = audited.detail.source.replace(/\r?\n/g, audited.detail.source.includes('\r\n') ? '\n' : '\r\n')
  relation.detail.constraints.reverse()
  compareStructure(actual, before, 'public')
  guard.detail.source += '\r\n'
  assert.throws(() => compareStructure(actual, before, 'public'), /guard_object_reference/)
  guard.detail.source = before.find(row => row.name === guard.name).detail.source
  relation.detail.constraints[0].validated = false
  assert.throws(() => compareStructure(actual, before, 'public'), /organization_schemas/)
  audited.detail.source = audited.detail.source.replace('now()', 'clock_timestamp()')
  assert.throws(() => compareStructure(actual, before, 'public'), /set_updated_at/)
})
const required = {
  organization_schemas: ['organization_id', 'schema_name', 'status'],
  stored_object_locations: ['organization_id', 'storage_kind', 'storage_key', 'location_id'],
  object_cleanup_tasks: ['status', 'storage_location_id', 'lease_token'],
  object_write_intents: ['attempt_id', 'status', 'location_id', 'lease_until'],
  object_deletion_fences: ['storage_kind', 'storage_key', 'location_id'],
  full_audio_transcription_tasks: ['status', 'lease_token'],
  offer_email_deliveries: ['status', 'message_id', 'schema_name'],
}
async function withFiles(names, action) {
  const directory = await mkdtemp(join(tmpdir(), 'readonly-release-'))
  try {
    for (const name of names) await writeFile(join(directory, name), 'SELECT 1;')
    await action(directory)
  } finally { await rm(directory, { recursive: true, force: true }) }
}
function fixture(overrides = {}) {
  const queries = [], releases = []
  const defaults = {
    ledger: true, rows: contract.migrations.map(({ version, name }) => ({ version, name })), installed: true,
    columns: Object.entries(required).flatMap(([table_name, names]) => names.map(column_name => ({ table_name, column_name }))),
    companies: [], mismatches: [], ...overrides,
  }
  const pool = { connect: async () => ({
    query: async sql => {
      queries.push(sql)
      assert.match(sql, /^(SELECT |\/\* schema-contract \*\/ SELECT |BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$|SET LOCAL |COMMIT$|ROLLBACK$)/)
      if (sql.startsWith('/* schema-contract */')) return { rows: defaults.catalogRows ?? [...contract.public.map(row => ({ ...row, schema: 'public' })), ...(contract.control || []).map(row => ({ ...row, schema: 'recovery_control' }))] }
      if (sql === 'ROLLBACK' && defaults.rollbackFails) throw new Error('rollback failed')
      if (sql.includes('to_regclass')) return { rows: [{ ledger: defaults.ledger ? 'schema_migrations' : null }] }
      if (sql.includes('FROM public.schema_migrations')) return { rows: defaults.rows }
      if (sql.includes('information_schema.columns')) return { rows: defaults.columns }
      if (sql.includes('to_regprocedure')) return { rows: [{ installed: defaults.installed }] }
      if (sql.includes('FROM public.organizations')) return { rows: defaults.companies }
      if (sql.includes('FROM public.stored_object_locations')) return { rows: defaults.mismatches }
      return { rows: [] }
    },
    release: broken => releases.push(broken),
  }) }
  return { pool, queries, releases, options: { migrationsDirectory, tenantRouting: true, storageLocations: { resume: location, interview: location } } }
}

test('migration manifest sorts numerically and rejects ambiguous, invalid or duplicate versions', async () => {
  await withFiles(['10_ten.sql', '2_two.sql'], async directory => {
    assert.deepEqual((await listMigrationFiles(directory)).map(file => file.version), ['2', '10'])
  })
  for (const names of [['1_first.sql', '0001_alias.sql'], ['bad.sql']]) {
    await withFiles(names, directory => assert.rejects(listMigrationFiles(directory), /Invalid|Duplicate/))
  }
  assert.throws(() => validateMigrationLedger([{ version: '0001', name: '0001_first.sql' }], [{ version: '9999', name: '9999_future.sql' }]), /Unknown database/)
})

test('release gate uses one read-only snapshot, succeeds on empty company list and releases its client', async () => {
    const f = fixture()
    assert.deepEqual(await assertReleaseReady(f.pool, f.options), { migrations: contract.migrations.length, companies: 0, knownStorageLocationsChecked: true })
    assert.equal(f.queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    assert.equal(f.queries.at(-1), 'COMMIT')
    assert.deepEqual(f.releases, [false])
})

test('overlapping readiness checks share one snapshot but never reuse a completed result', async () => {
  const f = fixture()
  const results = await Promise.all(Array.from({ length: 8 }, () => assertReleaseReady(f.pool, { ...f.options })))
  assert.deepEqual(f.releases, [false])
  assert.deepEqual(results[0], results[1])
  assert.notEqual(results[0], results[1])
  await assertReleaseReady(f.pool, f.options)
  assert.deepEqual(f.releases, [false, false])
})

test('concurrent callers all see rejection; subsequent readiness checks can succeed', async () => {
  const failing = fixture({ ledger: false }), healthy = fixture()
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => assertReleaseReady(failing.pool, failing.options)))
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected')
    assert.match(outcome.reason.message, /缺少迁移记录/)
  }
  assert.deepEqual(failing.releases, [false])
  failing.pool.connect = healthy.pool.connect
  await assertReleaseReady(failing.pool, failing.options)
  assert.deepEqual(healthy.releases, [false])
})

test('different pools, migration directories or storage locations do not share checks', async () => {
  const f = fixture(), other = fixture()
  await withFiles(['0001_changed.sql'], async directory => {
    const options = f.options
    await Promise.all([
      assertReleaseReady(f.pool, options),
      assertReleaseReady(f.pool, { ...options, storageLocations: { ...options.storageLocations, resume: 'b'.repeat(64) } }),
      assertReleaseReady(f.pool, { ...options, storageLocations: { ...options.storageLocations, interview: 'c'.repeat(64) } }),
      assertReleaseReady(other.pool, options),
      assert.rejects(assertReleaseReady(f.pool, { ...options, migrationsDirectory: directory }), /结构契约与工作区迁移 SQL 不一致/),
    ])
  })
  assert.deepEqual(f.releases, [false, false, false])
  assert.deepEqual(other.releases, [false])
})

test('a completed check does not hide later drift in the same migration directory', async () => {
  const f = fixture()
  await withFiles([], async directory => {
    await cp(migrationsDirectory, directory, { recursive: true })
    const options = { ...f.options, migrationsDirectory: directory }
    await assertReleaseReady(f.pool, options)
    await writeFile(join(directory, contract.migrations[0].name), 'SELECT 0;')
    await assert.rejects(assertReleaseReady(f.pool, options), /结构契约与工作区迁移 SQL 不一致/)
  })
  assert.deepEqual(f.releases, [false])
})

for (const [name, overrides, pattern] of [
  ['missing ledger', { ledger: false }, /缺少迁移记录/],
  ['pending migration', { rows: [] }, /待迁移/],
  ['future version', { rows: [{ version: '9999', name: '9999_future.sql' }] }, /Unknown database/],
  ['renamed applied file', { rows: [{ version: '0001', name: '0001_changed.sql' }] }, /is recorded as/],
  ['missing required column', { columns: [] }, /缺少必要结构/],
  ['missing checker', { installed: false }, /校验函数缺失/],
  ['missing company mapping', { companies: [{ organization_id: '1'.repeat(32), schema_name: null }] }, /Schema 未就绪/],
  ['broken company', { companies: [{ organization_id: '1'.repeat(32), schema_name: 'company_' + '1'.repeat(32), status: 'ready', structure_ready: false }] }, /Schema 未就绪/],
  ['relocated storage', { mismatches: [{ storage_kind: 'resume', count: 1 }] }, /存储位置不一致/],
]) test('release gate rejects ' + name + ' without mutations', async () => {
    const f = fixture(overrides)
    await assert.rejects(assertReleaseReady(f.pool, f.options), pattern)
    assert.equal(f.queries.at(-1), 'ROLLBACK')
    assert.deepEqual(f.releases, [false])
})

test('rollback failure destroys the connection and invalid routing or identity never connects', async () => {
    const f = fixture({ ledger: false, rollbackFails: true })
    await assert.rejects(assertReleaseReady(f.pool, f.options), /缺少迁移记录/)
    assert.deepEqual(f.releases, [true])
    for (const options of [{ ...f.options, tenantRouting: false }, { ...f.options, storageLocations: {} }]) {
      const before = f.queries.length
      await assert.rejects(assertReleaseReady(f.pool, options), /发布门禁/)
      assert.equal(f.queries.length, before)
    }
})

test('workspace SQL signature drift and damaged catalog objects fail closed', async () => {
  await withFiles(['0001_changed.sql'], async directory => {
    const f = fixture()
    await assert.rejects(assertReleaseReady(f.pool, { ...f.options, migrationsDirectory: directory }), /结构契约与工作区迁移 SQL 不一致/)
    assert.equal(f.queries.length, 0)
  })
  const f = fixture({ catalogRows: [] })
  await assert.rejects(assertReleaseReady(f.pool, f.options), /结构契约不匹配 public/)
  assert.equal(f.queries.at(-1), 'ROLLBACK')
  assert.deepEqual(f.releases, [false])
})
