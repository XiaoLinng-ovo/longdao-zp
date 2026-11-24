import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { fingerprintTables, protectRecoveryDirectory, verifyTableFingerprints } from './runtime-recovery-rehearsal.mjs'
import { inspectCompanySchemas } from './check-company-schemas.mjs'
import { captureMigrationBaseline, verifyMigratedRecoverySnapshot, verifyRecoveryMigrationScope } from './recovery-snapshot.mjs'
import { writePrivateRecoveryFile } from './private-recovery-files.mjs'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { readStructureContract } from '../packages/database-readiness/structure-contract.js'

// This command has no source-database connection and never applies decisions to the business database.
const [directory, binaries] = process.argv.slice(2)
assert.ok(isAbsolute(directory || '') && isAbsolute(binaries || ''), 'Explicit absolute backup and PostgreSQL binary paths are required')
const execute = promisify(execFile)
const quote = value => '"' + value.replaceAll('"', '""') + '"'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const reviewBytes = await readFile(join(directory, 'conflict-field-review.json'))
const review = JSON.parse(reviewBytes)
const previous = JSON.parse(await readFile(join(directory, 'rehearsal-report.json'), 'utf8'))
const fingerprints = JSON.parse(await readFile(join(directory, 'table-fingerprints.json'), 'utf8'))
const digest = createHash('sha256')
for await (const bytes of createReadStream(join(directory, 'database.dump'))) digest.update(bytes)
assert.equal(digest.digest('hex'), previous.dumpSha256, 'Backup bytes changed since restore verification')
assert.equal(previous.snapshotRestoreVerified, true)
assert.equal(review.target, previous.target)
const expectedFields = {
  interview_live_sessions: ['corrected_transcript_version_id', 'summary_report', 'summary_revision', 'updated_at'],
  interview_transcript_postprocess_jobs: ['attempts', 'completed_at', 'updated_at', 'warnings'],
  offer_templates: ['updated_at'],
  offers: ['current_version_id', 'updated_at', 'version'],
  resume_import_batches: ['detached_at', 'detached_job_id', 'detached_job_title', 'job_id', 'updated_at'],
}
assert.deepEqual(review.entries.map(row => row.table).sort(), Object.keys(expectedFields).sort())
for (const row of review.entries) {
  assert.equal(row.kind, 'conflict')
  assert.match(row.schema, /^company_[a-f0-9]{32}$/)
  assert.equal(row.schema, 'company_' + row.organizationId.replaceAll('-', ''))
  assert.deepEqual([...row.changedFields].sort(), [...expectedFields[row.table]].sort())
  assert.ok(row.primaryKeyColumns.length === 1 && row.primaryKey.length === 1)
  assert.match(row.primaryKeyColumns[0], /^[a-z_]+$/)
}
const output = join(directory, 'five-decisions-clone-' + randomUUID() + '.json')
const report = { format: 'approved-five-decisions-clone/v1', startedAt: new Date().toISOString(),
  businessDatabaseWritten: false, businessRecoveryVerified: false, sourceConnectionUsed: false,
  reviewSha256: hash(reviewBytes), dumpSha256: previous.dumpSha256, passed: false, checks: [], cleanup: {} }
const instance = await startIsolatedPostgres(binaries)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
let admin, clone
const qualified = (schema, table) => quote(schema) + '.' + quote(table)
const rowHash = async (schema, table, key, id) => (await clone.query('SELECT encode(sha256(convert_to(to_jsonb(t)::text,\'UTF8\')),\'hex\') AS hash FROM ' + qualified(schema, table) + ' t WHERE ' + quote(key) + '=$1::uuid', [id])).rows[0]?.hash
const allowed = new Map()
function allow(schema, table, key, id) {
  const identity = schema + '.' + table
  const item = allowed.get(identity) || { schema, table, key, ids: [] }
  assert.equal(item.key, key)
  if (!item.ids.includes(id)) item.ids.push(id)
  allowed.set(identity, item)
}
async function unselectedFingerprint({ schema, table, key, ids }) {
  return (await clone.query('SELECT count(*)::int AS count,encode(sha256(convert_to(COALESCE(string_agg(digest,\'\' ORDER BY digest),\'\'),\'UTF8\')),\'hex\') AS hash FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,\'UTF8\')),\'hex\') AS digest FROM ' + qualified(schema, table) + ' t WHERE NOT (' + quote(key) + '=ANY($1::uuid[]))) hashes', [ids])).rows[0]
}
try {
  await protectRecoveryDirectory(instance.directory)
  await protectRecoveryDirectory(directory)
  report.isolatedDirectory = instance.directory
  admin = new Pool(instance.connection)
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE ' + quote(instance.database))
  console.log('Restoring protected backup into a dedicated cluster')
  await execute(join(binaries, 'pg_restore' + (process.platform === 'win32' ? '.exe' : '')), ['--no-password', '--no-owner', '--no-acl', '--no-tablespaces', '--exit-on-error', '--single-transaction', '--dbname=' + instance.database, join(directory, 'database.dump')],
    { env: { ...instance.env, PGOPTIONS: '-c timezone=UTC' }, windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 })
  clone = new Pool({ ...instance.connection, database: instance.database, max: 1,
    options: '-c timezone=UTC -c search_path=public -c lock_timeout=5s -c statement_timeout=60s' })
  verifyTableFingerprints(fingerprints, await fingerprintTables(clone))
  report.checks.push('All restored table fingerprints match the verified backup')
  // The reviewed row hashes were serialized in UTC+08; do not round timestamps through JavaScript Date.
  await clone.query("SET timezone='Asia/Shanghai'")
  await clone.query('BEGIN')
  const session = review.entries.find(row => row.table === 'interview_live_sessions')
  const offer = review.entries.find(row => row.table === 'offers')
  report.decisions = []
  for (const entry of review.entries) {
    const key = entry.primaryKeyColumns[0], id = entry.primaryKey[0]
    assert.equal(await rowHash('public', entry.table, key, id), entry.legacyHash, 'Reviewed legacy hash drift')
    assert.equal(await rowHash(entry.schema, entry.table, key, id), entry.companyHash, 'Reviewed company hash drift')
    allow(entry.schema, entry.table, key, id)
    report.decisions.push({ table: entry.table, primaryKey: entry.primaryKey, legacyHash: entry.legacyHash,
      companyHash: entry.companyHash, fields: expectedFields[entry.table], source: 'reviewed-corrected-legacy',
      timestampPolicy: 'greatest-source-and-company-with-full-database-precision' })
  }
  const canonical = (await clone.query('SELECT corrected_transcript_version_id FROM public.interview_live_sessions WHERE id=$1', session.primaryKey)).rows[0].corrected_transcript_version_id
  assert.ok(canonical)
  const dependencyRows = [ { schema: session.schema, table: 'interview_transcript_versions', key: 'id', id: canonical } ]
  report.stage = 'offer-history-continuity'
  const versions = (await clone.query('SELECT id,version FROM public.offer_versions WHERE offer_id=$1 ORDER BY version', offer.primaryKey)).rows
  assert.deepEqual(versions.map(row => row.version), Array.from({ length: versions.length }, (_, i) => i + 1))
  assert.ok(versions.length > 0)
  assert.equal((await clone.query('SELECT current_version_id FROM public.offers WHERE id=$1', offer.primaryKey)).rows[0].current_version_id, versions.at(-1).id)
  for (const version of versions) dependencyRows.push({ schema: offer.schema, table: 'offer_versions', key: 'id', id: version.id })
  const additions = []
  for (const dependency of dependencyRows) {
    report.stage = 'verify-immutable-dependency:' + dependency.table + ':' + dependency.id
    const sourceHash = await rowHash('public', dependency.table, dependency.key, dependency.id)
    assert.ok(sourceHash, 'Missing immutable dependency')
    const targetHash = await rowHash(dependency.schema, dependency.table, dependency.key, dependency.id)
    if (targetHash) assert.equal(targetHash, sourceHash, 'Immutable dependency conflict requires separate review')
    else { additions.push({ ...dependency, sourceHash }); allow(dependency.schema, dependency.table, dependency.key, dependency.id) }
  }
  const beforeTables = await fingerprintTables(clone)
  const outsideAllowedRows = new Map()
  for (const [identity, item] of allowed) outsideAllowedRows.set(identity, await unselectedFingerprint(item))
  for (const dependency of additions) {
    report.stage = 'copy-immutable-dependency:' + dependency.table + ':' + dependency.id
    const result = await clone.query('INSERT INTO ' + qualified(dependency.schema, dependency.table) + ' SELECT * FROM ' + qualified('public', dependency.table) + ' WHERE ' + quote(dependency.key) + '=$1::uuid', [dependency.id])
    assert.equal(result.rowCount, 1)
    assert.equal(await rowHash(dependency.schema, dependency.table, dependency.key, dependency.id), dependency.sourceHash)
  }
  for (const entry of review.entries) {
    report.stage = 'update-reviewed-row:' + entry.table
    await clone.query('SET LOCAL search_path=' + quote(entry.schema) + ',public')
    const relation = qualified(entry.schema, entry.table)
    const timestamps = (await clone.query("SELECT t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal AND n.nspname='public' AND p.proname='set_updated_at'", [relation])).rows
    // Replay source timestamps, not the maintenance clock; no business or isolation trigger is disabled.
    for (const trigger of timestamps) {
      assert.equal(trigger.tgname, entry.table + '_set_updated_at')
      assert.equal(trigger.tgenabled, 'O')
      await clone.query('ALTER TABLE ' + relation + ' DISABLE TRIGGER ' + quote(trigger.tgname))
    }
    const assignments = expectedFields[entry.table].map(field => quote(field) + '=' + (field === 'updated_at' ? 'GREATEST(c.updated_at,s.updated_at)' : 's.' + quote(field))).join(',')
    const key = quote(entry.primaryKeyColumns[0])
    const result = await clone.query('UPDATE ' + qualified(entry.schema, entry.table) + ' c SET ' + assignments + ' FROM ' + qualified('public', entry.table) + ' s WHERE c.' + key + '=s.' + key + ' AND c.' + key + '=$1::uuid', entry.primaryKey)
    assert.equal(result.rowCount, 1)
    for (const trigger of timestamps) {
      await clone.query('ALTER TABLE ' + relation + ' ENABLE TRIGGER ' + quote(trigger.tgname))
      assert.equal((await clone.query('SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2', [relation, trigger.tgname])).rows[0].tgenabled, 'O')
    }
    assert.equal(await rowHash('public', entry.table, entry.primaryKeyColumns[0], entry.primaryKey[0]), entry.legacyHash)
    assert.equal(await rowHash(entry.schema, entry.table, entry.primaryKeyColumns[0], entry.primaryKey[0]), entry.legacyHash, 'Result differs from the reviewed corrected row')
  }
  await clone.query('SET LOCAL search_path=public')
  const afterTables = await fingerprintTables(clone)
  report.stage = 'verify-unselected-table-fingerprints'
  assert.deepEqual(afterTables.filter(row => !allowed.has(row.schema + '.' + row.name)), beforeTables.filter(row => !allowed.has(row.schema + '.' + row.name)))
  for (const [identity, item] of allowed) {
    report.stage = 'verify-unselected-rows:' + identity
    assert.deepEqual(await unselectedFingerprint(item), outsideAllowedRows.get(identity), 'Unexpected row change outside approved keys')
  }
  report.dependencies = additions
  report.offerContentVersion = versions.at(-1).version
  report.checks.push('Five conflict rows resolved; immutable dependencies copied exactly; all other rows unchanged')
  await clone.query('COMMIT')
  const remaining = await inspectCompanySchemas(clone, { compareLegacy: true, includeEntries: true })
  report.stage = 'verify-remaining-differences'
  report.remainingDifferences = remaining.companies.flatMap(company => company.differences.flatMap(table => table.entries.map(entry => ({ schema: company.schema_name, table: table.table, ...entry }))))
  assert.equal(report.remainingDifferences.filter(row => row.kind === 'conflict').length, 0)
  assert.equal(report.remainingDifferences.length, 23)
  console.log('Verifying pending migrations on the reconciled backup copy')
  report.stage = 'verify-pending-migrations'
  await clone.query("SET timezone='UTC'")
  const { inspectMigrationApproval, runMigrations } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/db/migrations.js')).href)
  const migrationsPath = join(projectRoot, 'db/migrations')
  const approval = await inspectMigrationApproval(clone, migrationsPath)
  verifyRecoveryMigrationScope(approval)
  const migrationBaseline = await captureMigrationBaseline(clone)
  const reconciledFingerprints = await fingerprintTables(clone)
  const contract = await readStructureContract(await listMigrationFiles(migrationsPath))
  report.migrations = (await runMigrations(clone, migrationsPath, { approval })).applied
  report.migrationDataChecks = await verifyMigratedRecoverySnapshot(clone, migrationBaseline, reconciledFingerprints, contract)
  assert.deepEqual((await inspectMigrationApproval(clone, migrationsPath)).pending, [])
  const { LiveInterviewSessionRepository } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/interviews/live-session-repository.js')).href)
  report.stage = 'verify-historical-corrected-view'
  await clone.query('SET search_path=' + quote(session.schema) + ',public')
  const view = await new LiveInterviewSessionRepository(clone).get(session.primaryKey[0])
  assert.equal(view.session.status, 'completed')
  assert.equal(view.completionReview.phase, 'completed')
  assert.equal(view.completionReview.versionId, canonical)
  assert.equal(view.completionReview.unresolvedCount, 69)
  report.historicalReview = { completedPreserved: true, unresolvedCount: view.completionReview.unresolvedCount, noHumanConfirmationsFabricated: true }
  report.checks.push('0101-0104 migrate successfully; historical corrected result and genuine 69 unresolved roles retained without reopening')
  report.passed = true
  report.stage = 'verified'
} catch (error) {
  report.failure = { code: typeof error.code === 'string' ? error.code : 'CLONE_VERIFICATION_FAILED' }
  if (clone) await clone.query('ROLLBACK').catch(() => undefined)
  // SQL diagnostics may contain business bodies. Persist neither messages nor stacks.
} finally {
  try { await clone?.end(); await admin?.end(); report.cleanup.connectionsClosed = true }
  finally { await instance.stop(); report.cleanup.postgresStopped = true }
  report.finishedAt = new Date().toISOString()
  await writePrivateRecoveryFile(output, JSON.stringify(report, null, 2) + String.fromCharCode(10))
  console.log(JSON.stringify({ passed: report.passed, businessDatabaseWritten: false, checks: report.checks,
    offerContentVersion: report.offerContentVersion, dependenciesCopied: report.dependencies?.length,
    remainingDifferences: report.remainingDifferences?.length, migrations: report.migrations, cleanup: report.cleanup, output }, null, 2))
  if (!report.passed) process.exitCode = 1
}

