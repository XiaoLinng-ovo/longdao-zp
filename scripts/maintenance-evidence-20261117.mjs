import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeConfig, parseRuntimeEnv, validateManagedConfig } from './runtime-config.mjs'
import { verifyRelease } from './runtime-release.mjs'
import { writePrivateRecoveryFile, protectRecoveryPath, verifyRecoveryPath } from './private-recovery-files.mjs'
import { captureMigrationBaseline, fingerprintTables, verifyTableFingerprints, verifyMigratedRecoverySnapshot, verifyRecoveryMigrationScope } from './recovery-snapshot.mjs'
import { validateMigrationPlan } from './migration-approval.mjs'
import { validateConflictPlan } from './company-conflict-repair.mjs'
import { validateCompanyPlan } from './company-data-maintenance.mjs'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { readStructureContract } from '../packages/database-readiness/structure-contract.js'

const [action, evidenceInput, releaseInput, detail] = process.argv.slice(2)
const root = resolve(import.meta.dirname, '..'), evidence = resolve(evidenceInput), release = resolve(releaseInput)
const profile = join(evidence, 'business-maintenance.env')
const hash = value => createHash('sha256').update(value).digest('hex')
const read = async name => JSON.parse(await readFile(join(evidence, name), 'utf8'))
const save = (name, value) => writePrivateRecoveryFile(join(evidence, name), JSON.stringify(value, null, 2) + '\n')
await verifyRecoveryPath(evidence)
const { Pool } = createRequire(join(root, 'apps/api/package.json'))('pg')
const { loadDatabaseConfig } = await import(pathToFileURL(join(release, 'apps/api/dist/src/db/config.js')).href)
async function connect() {
  const { target, ...connection } = loadDatabaseConfig(readRuntimeConfig(root, { ...process.env, ENV_FILE_PATH: profile }).env)
  assert.equal(target, '127.0.0.1:5432/smartrecruit')
  return new Pool({ ...connection, max: 1, application_name: 'smartrecruit-maintenance-evidence', options: '-c timezone=UTC -c default_transaction_read_only=on -c statement_timeout=60s' })
}

if (action === 'prepare') {
  const backup = await read('frozen-backup-report.json')
  assert.equal(backup.passed, true)
  const manifest = await verifyRelease(release)
  const bytes = await readFile(join(evidence, 'business-original.env'))
  assert.equal(hash(bytes), hash(await readFile(join(root, '.env'))))
  const original = parseRuntimeEnv(bytes.toString('utf8'))
  assert.ok(!Object.hasOwn(original, 'TENANT_SCHEMA_ROUTING') && !Object.hasOwn(original, 'INTERVIEW_STORAGE_ROOT'))
  const storage = join(root, 'data/resumes/quarantine').replaceAll('\\', '/')
  assert.equal(resolve(original.RECRUITING_QUARANTINE_ROOT), resolve(storage))
  const selected = Buffer.concat([Buffer.from('TENANT_SCHEMA_ROUTING=on\nINTERVIEW_STORAGE_ROOT=' + storage + '\n'), bytes])
  await writePrivateRecoveryFile(profile, selected)
  const effective = readRuntimeConfig(root, { ...process.env, ENV_FILE_PATH: profile }).env
  validateManagedConfig(effective)
  for (const key of Object.keys(original)) assert.equal(effective[key], original[key], 'Existing profile value changed: ' + key)
  const report = { reviewedAt: new Date().toISOString(), passed: true, release: { id: manifest.id, sha256: manifest.sha256, files: manifest.files.length },
    originalProfileSha256: hash(bytes), maintenanceProfileSha256: hash(selected), originalKeysPreserved: true,
    changedKeys: ['TENANT_SCHEMA_ROUTING', 'INTERVIEW_STORAGE_ROOT'], routing: effective.TENANT_SCHEMA_ROUTING,
    recruitingRoot: effective.RECRUITING_QUARANTINE_ROOT, interviewRoot: effective.INTERVIEW_STORAGE_ROOT,
    databaseTarget: '127.0.0.1:5432/smartrecruit', noExternalTestMailAuthorized: true,
    authKeyDigests: Object.fromEntries(['AUTH_OTP_HMAC_SECRET', 'AUTH_MFA_ENCRYPTION_KEY'].map(key => [key, hash(effective[key])])) }
  await save('configuration-candidate-review.json', report)
  console.log(JSON.stringify({ passed: true, profile, release: report.release, originalKeysPreserved: true }))
} else if (action === 'fence') {
  assert.match(detail || '', /^[a-z0-9-]+$/)
  const pool = await connect()
  try {
    const connections = (await pool.query("SELECT pid,application_name,state FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid")).rows
    assert.equal(connections.length, 0, 'Unexpected database connections; inspect writer before continuing')
    const states = []
    const tables = (await pool.query("SELECT table_schema,table_name FROM information_schema.columns WHERE column_name='status' AND (table_schema='public' OR table_schema LIKE 'company\\_%' ESCAPE '\\') AND table_name ~ '(task|_jobs$|outbox|write_intents|email_deliveries)' ORDER BY table_schema,table_name")).rows
    const quote = value => '"' + value.replaceAll('"', '""') + '"'
    for (const row of tables) states.push({ ...row, states: (await pool.query('SELECT status,count(*)::int AS count FROM ' + quote(row.table_schema) + '.' + quote(row.table_name) + ' GROUP BY status ORDER BY status')).rows })
    const active = states.flatMap(row => row.states.filter(s => /^(processing|running|sending|in_progress|uploading|claimed)$/i.test(s.status)).map(s => ({ schema: row.table_schema, table: row.table_name, ...s })))
    assert.equal(active.length, 0, 'Active task rows require review; do not reset or acknowledge them')
    const report = { checkedAt: new Date().toISOString(), passed: true, connections, states, activeTaskStates: active, taskRowsModified: false, scope: 'Contemporaneous database writer and task inspection; each apply independently takes transactional locks. Initial OS-process audit is in writer-fence-and-task-inventory.json.' }
    await save('writers-' + detail + '.json', report)
    console.log(JSON.stringify({ passed: true, otherConnections: 0, activeTaskStates: 0, report: 'writers-' + detail + '.json' }))
  } finally { await pool.end() }
} else if (action === 'baseline' || action === 'migrated') {
  const pool = await connect()
  try {
    const original = JSON.parse(await readFile(join(evidence, 'database-rehearsal/table-fingerprints.json')))
    if (action === 'baseline') {
      verifyTableFingerprints(original, await fingerprintTables(pool))
      await save('source-migration-baseline.json', await captureMigrationBaseline(pool))
      console.log(JSON.stringify({ passed: true, tablesUnchangedSinceBackup: original.length }))
    } else {
      const contract = await readStructureContract(await listMigrationFiles(join(release, 'db/migrations')))
      const checks = await verifyMigratedRecoverySnapshot(pool, await read('source-migration-baseline.json'), original, contract)
      const report = { checkedAt: new Date().toISOString(), passed: true, originalTableCount: original.length, ...checks }
      await save('source-migration-verification.json', report)
      console.log(JSON.stringify(report))
    }
  } finally { await pool.end() }
} else if (action === 'run') {
  const match = /^(migrations|five-decisions|reconcile|seal)-(check|apply)$/.exec(detail || '')
  assert.ok(match)
  const [, kind, operation] = match, planPath = join(evidence, kind + '-approved.json')
  const bytes = await readFile(planPath), plan = JSON.parse(bytes)
  assert.ok(plan.approval)
  const resultName = detail + '-result.json'
  try { await access(join(evidence, resultName)); throw Error('Evidence already exists; inspect state instead of repeating maintenance') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const script = kind === 'migrations' ? 'maintenance-migrations.mjs' : kind === 'five-decisions' ? 'maintenance-five-decisions.mjs' : 'maintenance-company-data.mjs'
  const args = [join(release, 'scripts', script), operation, '--release', release, '--profile', profile, '--plan', planPath, '--sha256', hash(bytes)]
  if (kind !== 'migrations') args.push('--backup', join(evidence, 'database-rehearsal/database.dump'), '--organization', plan.snapshot.organizationId)
  if (kind === 'reconcile' || kind === 'seal') args.push('--intent', kind)
  const { stdout } = await promisify(execFile)(process.execPath, args, { windowsHide: true, timeout: 900000, maxBuffer: 2 * 1024 * 1024 })
  const result = JSON.parse(stdout)
  await save(resultName, result)
  console.log(JSON.stringify(result))
} else if (action === 'approve') {
  assert.ok(['migrations', 'five-decisions', 'reconcile', 'seal'].includes(detail))
  const authorization = await read('authorization.json')
  assert.equal(authorization.source, 'Explicit user instruction in this Codex conversation on 2026-11-17')
  assert.ok(authorization.authorizedScope.includes('Back up and restore-verify before writes'))
  assert.ok(authorization.authorizedScope.includes('Repair the five previously confirmed business decisions'))
  const backup = await read('frozen-backup-report.json'), owners = await read('owner-acl-restore-report.json')
  const config = await read('configuration-candidate-review.json'), writers = await read('writers-' + detail + '.json')
  for (const result of [backup, owners, config, writers]) assert.equal(result.passed, true)
  const { readdir } = await import('node:fs/promises')
  const matches = (await readdir(join(evidence, 'database-rehearsal'))).filter(name => /^formal-five-decisions-clone-.*\.json$/.test(name))
  assert.equal(matches.length, 1)
  const rehearsalPath = join(evidence, 'database-rehearsal', matches[0]), rehearsal = JSON.parse(await readFile(rehearsalPath))
  assert.equal(rehearsal.passed, true); assert.equal(rehearsal.businessDatabaseWritten, false)
  assert.equal(rehearsal.dumpSha256, backup.dumpSha256)
  const plan = await read(detail + '-unapproved.json')
  assert.equal(plan.approval, null)
  assert.equal(plan.context.release.id, config.release.id); assert.equal(plan.context.release.sha256, config.release.sha256)
  assert.equal(plan.context.profileSha256, config.maintenanceProfileSha256)
  if (detail === 'migrations') verifyRecoveryMigrationScope(plan.snapshot)
  else {
    assert.equal(plan.snapshot.organizationId, 'abb8445c-d068-47ee-b2f0-45010a886629')
    assert.equal(plan.context.backupSha256, backup.dumpSha256)
    if (detail === 'five-decisions') {
      assert.equal(plan.snapshot.entries.length, 5); assert.equal(plan.snapshot.dependencies.filter(row => row.targetHash === null).length, 6)
      assert.equal(plan.snapshot.remaining.length, 23); assert.equal(plan.snapshot.offerContentVersion, 6)
    } else {
      assert.equal(plan.intent, detail)
      assert.ok(plan.snapshot.entries.every(row => row.action === 'preserve-company' || (detail === 'reconcile' && row.action === 'copy-original-event' && row.importCheck?.ready === true)))
      assert.equal(plan.snapshot.entries.filter(row => row.action === 'preserve-company').length, 14)
      assert.equal(plan.snapshot.entries.filter(row => row.action === 'copy-original-event').length, detail === 'reconcile' ? 9 : 0)
      assert.equal(plan.snapshot.entries.length, detail === 'reconcile' ? 23 : 14)
    }
  }
  const references = Object.fromEntries(Object.entries({ writersDrained: 'writers-' + detail + '.json', backupRestored: 'owner-acl-restore-report.json', objectsReviewed: 'objects-manifest.json', configReviewed: 'configuration-candidate-review.json', rehearsalPassed: 'database-rehearsal/' + matches[0] }).map(([key, value]) => [key, join(evidence, value)]))
  if (detail === 'migrations') references.dataReconciled = rehearsalPath + ' (current-backup clone scope validated; source reconciliation follows migration)'
  if (detail === 'seal') {
    const smoke = await read('business-smoke-report.json'), reconciled = await read('reconcile-apply-result.json')
    assert.equal(smoke.passed, true); assert.equal(smoke.sourceDatabaseReadOnly, true)
    assert.equal(reconciled.copied, 9); assert.equal(reconciled.preserved, 14)
    references.businessSmokePassed = join(evidence, 'business-smoke-report.json')
    references.dataReconciled = join(evidence, 'reconcile-apply-result.json')
  }
  plan.approval = { reviewedBy: 'Codex automated technical review, executing explicit user authorization recorded in authorization.json; not an independent human signature', snapshotSha256: plan.snapshotSha256,
    approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 2 * 3600000).toISOString(), evidenceReferences: references }
  if (detail === 'migrations') validateMigrationPlan(plan)
  else if (detail === 'five-decisions') validateConflictPlan(plan)
  else validateCompanyPlan(plan)
  const bytes = JSON.stringify(plan, null, 2) + '\n', destination = join(evidence, detail + '-approved.json')
  await writePrivateRecoveryFile(destination, bytes)
  await protectRecoveryPath(destination)
  console.log(JSON.stringify({ reviewed: detail, plan: destination, sha256: hash(bytes), snapshotSha256: plan.snapshotSha256, attribution: plan.approval.reviewedBy }))
} else throw Error('Unknown maintenance evidence action')
