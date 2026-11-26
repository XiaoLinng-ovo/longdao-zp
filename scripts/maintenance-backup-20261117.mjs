import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readRuntimeConfig } from './runtime-config.mjs'
import { preparePrivateRecoveryDirectory, protectRecoveryPath, writePrivateRecoveryFile } from './private-recovery-files.mjs'
import { recoveryRehearsal } from './runtime-recovery-rehearsal.mjs'
import { recoveryAudit } from './runtime-recovery-audit.mjs'
import { fingerprintTables, verifyTableFingerprints } from './recovery-snapshot.mjs'
import { isolatedEnvironment } from './isolated-environment.mjs'
import { loadDatabaseConfig } from '../apps/api/dist/src/db/config.js'

const root = resolve(import.meta.dirname, '..'), evidence = resolve(process.argv[2] || '')
assert.ok(evidence.startsWith(join(root, 'backups') + sep))
const resume = process.argv[3] === '--resume-verified-objects'
assert.ok(process.argv[3] === undefined || resume, 'Unknown maintenance option')
const execute = promisify(execFile), binaryRoot = 'D:/software/pgsql/bin'
const { Pool } = createRequire(join(root, 'apps/api/package.json'))('pg')
const configuration = readRuntimeConfig(root), { target, ...connection } = loadDatabaseConfig(configuration.env)
assert.equal(target, '127.0.0.1:5432/smartrecruit')
const pool = new Pool({ ...connection, max: 2, application_name: 'smartrecruit-maintenance-backup', options: '-c timezone=UTC -c statement_timeout=60s -c lock_timeout=5s -c idle_in_transaction_session_timeout=30min' })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = async path => { const h = createHash('sha256'); for await (const b of createReadStream(path)) h.update(b); return h.digest('hex') }
const quote = value => '"' + value.replaceAll('"', '""') + '"'
const report = { format: 'authorized-frozen-business-backup/v1', startedAt: new Date().toISOString(), target, passed: false, recovered: [], cleanup: {} }
const evidencePath = name => join(evidence, resume ? 'resumed-' + name : name)
const save = (name, value) => writePrivateRecoveryFile(evidencePath(name), JSON.stringify(value, null, 2) + '\n')
let fence, frozen = false

async function recoverOriginals() {
  const audit = JSON.parse(await readFile(join(evidence, 'current-audit.json'), 'utf8'))
  const storage = configuration.env.RECRUITING_QUARANTINE_ROOT
  for (const entry of audit.objects.entries.filter(e => e.kind === 'resume')) {
    const destination = join(storage, entry.key)
    assert.ok(relative(storage, destination) && !relative(storage, destination).startsWith('..'))
    try { await access(destination); continue } catch (error) { if (error.code !== 'ENOENT') throw error }
    const records = (await pool.query('SELECT id,size_bytes,content_hash FROM public.resumes WHERE storage_key=$1', [entry.key])).rows
    assert.ok(records.length > 0)
    const record = records[0]
    assert.ok(records.every(r => Number(r.size_bytes) === Number(record.size_bytes) && r.content_hash === record.content_hash))
    let bytes, provenance
    if (entry.matches.length) {
      bytes = await readFile(join(entry.matches[0].root, entry.key))
      provenance = { kind: 'historical-original-file', root: entry.matches[0].root }
    } else {
      const rows = (await pool.query('SELECT id,result FROM public.analysis_results WHERE resume_id=$1', [record.id])).rows
      const matching = rows.filter(r => typeof r.result?.parsedResume?.originalText === 'string').map(r => ({ id: r.id, bytes: Buffer.from(r.result.parsedResume.originalText, 'utf8') })).filter(r => r.bytes.length === Number(record.size_bytes) && hash(r.bytes) === record.content_hash)
      assert.ok(matching.length > 0, 'No exact original byte recovery source')
      bytes = matching[0].bytes; provenance = { kind: 'retained-parsedResume-originalText', analysisId: matching[0].id, resumeId: record.id }
    }
    assert.equal(bytes.length, Number(record.size_bytes)); assert.equal(hash(bytes), record.content_hash)
    await writeFile(destination, bytes, { flag: 'wx' }); assert.equal(await fileHash(destination), record.content_hash)
    report.recovered.push({ key: entry.key, bytes: bytes.length, sha256: record.content_hash, provenance, readBackVerified: true })
  }
  await save('original-object-recovery.json', { recoveredAt: new Date().toISOString(), objects: report.recovered, substituteBytesUsed: false })
}

async function inventory(directory) {
  const entries = []
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name), info = await lstat(file)
      assert.ok(!info.isSymbolicLink(), 'Object symlinks require independent review')
      if (info.isDirectory()) await walk(file)
      else { assert.ok(info.isFile()); entries.push({ path: relative(directory, file), bytes: info.size, sha256: await fileHash(file) }) }
    }
  }
  await walk(directory)
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

async function copyVerified(source, destination, manifest) {
  await mkdir(destination)
  for (const entry of manifest) {
    const path = join(destination, entry.path)
    await mkdir(dirname(path), { recursive: true })
    await copyFile(join(source, entry.path), path, constants.COPYFILE_EXCL)
    assert.equal(await fileHash(path), entry.sha256)
  }
}

try {
  await preparePrivateRecoveryDirectory(evidence)
  if (resume) {
    const previous = JSON.parse(await readFile(join(evidence, 'frozen-backup-report.json'), 'utf8'))
    assert.equal(previous.passed, false)
    assert.equal(previous.target, target)
    assert.ok(previous.writersFencedDuringBackup !== true)
    assert.ok(previous.fenceAcquiredAt && previous.cleanup.fenceReleased)
    assert.equal(await fileHash(configuration.env.ENV_FILE_PATH), previous.profileSha256)
    report.previousAttempt = { startedAt: previous.startedAt, finishedAt: previous.finishedAt, failure: previous.failure }
    await save('previous-frozen-backup-report.json', previous)
  }
  console.log('Recovering exact original object bytes'); await recoverOriginals()
  await recoveryAudit({ root, output: evidencePath('recovered-object-audit.json'), resumeRoots: [configuration.env.RECRUITING_QUARANTINE_ROOT], interviewRoots: [configuration.env.RECRUITING_QUARANTINE_ROOT] })
  const audit = JSON.parse(await readFile(evidencePath('recovered-object-audit.json')))
  assert.ok(audit.objects.entries.every(e => e.state === 'found'))
  report.objectReferences = Object.fromEntries([...new Set(audit.objects.entries.map(e => e.kind))].map(k => [k, audit.objects.entries.filter(e => e.kind === k).length]))
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$p=Get-CimInstance Win32_Process; @($p | Where-Object { $_.Name -match 'node|python' } | ForEach-Object { [PSCustomObject]@{pid=$_.ProcessId;name=$_.Name;thisProject=($_.CommandLine -like '*20260829*');appWriter=($_.CommandLine -match 'runtime-role|apps[\\/]api[\\/]dist|apps[\\/]worker[\\/]dist|serve-web-production') } }) | ConvertTo-Json -Compress"], { windowsHide: true })
  report.processInventory = JSON.parse(stdout)
  assert.ok(!report.processInventory.some(p => p.thisProject && p.appWriter), 'Business writers must be stopped')
  fence = await pool.connect(); await fence.query('BEGIN')
  const tables = (await fence.query("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND c.relpersistence='p' AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY n.nspname,c.relname")).rows
  await fence.query('LOCK TABLE ' + tables.map(t => quote(t.nspname) + '.' + quote(t.relname)).join(',') + ' IN SHARE MODE')
  frozen = true; report.fenceAcquiredAt = new Date().toISOString(); report.lockedTables = tables.length
  report.otherConnections = (await fence.query('SELECT usename,application_name,state FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND application_name<>$1', ['smartrecruit-maintenance-backup'])).rows
  assert.equal(report.otherConnections.length, 0)
  report.taskStates = []
  for (const t of tables.filter(t => /task|_jobs$|outbox|write_intents|email_deliveries/.test(t.relname))) {
    const hasStatus = (await fence.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', [t.nspname, t.relname, 'status'])).rowCount
    if (hasStatus) report.taskStates.push({ schema: t.nspname, table: t.relname, states: (await fence.query('SELECT status,count(*)::int AS count FROM ' + quote(t.nspname) + '.' + quote(t.relname) + ' GROUP BY status ORDER BY status')).rows })
  }
  report.activeTaskStates = report.taskStates.flatMap(t => t.states.filter(s => /^(processing|running|sending|in_progress|uploading|claimed)$/i.test(s.status)).map(s => ({ schema: t.schema, table: t.table, ...s })))
  report.taskRowsModified = false
  await save('writer-fence-and-task-inventory.json', { ...report, writersFenced: true })
  const profileBackup = evidencePath('business-original.env')
  await writePrivateRecoveryFile(profileBackup, await readFile(configuration.env.ENV_FILE_PATH))
  report.profileSha256 = await fileHash(profileBackup)
  const parameters = fence.connectionParameters
  const cliEnv = isolatedEnvironment({ PGHOST: parameters.host, PGPORT: String(parameters.port || 5432), PGDATABASE: parameters.database, PGUSER: parameters.user, PGPASSWORD: parameters.password || '', PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'disable' })
  report.rolesDump = evidencePath('roles-without-passwords.sql')
  await execute(join(binaryRoot, 'pg_dumpall.exe'), ['--roles-only', '--no-role-passwords', '--no-password', '--file=' + report.rolesDump], { env: cliEnv, windowsHide: true, timeout: 60000 })
  await protectRecoveryPath(report.rolesDump)
  report.ownership = (await fence.query("SELECT n.nspname AS schema,c.relname AS name,c.relkind,pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','S','v','m') ORDER BY n.nspname,c.relname")).rows
  console.log('Copying and read-back verifying all business objects')
  const data = join(root, 'data'), manifest = await inventory(data)
  if (resume) {
    const previousObjects = JSON.parse(await readFile(join(evidence, 'objects-manifest.json'), 'utf8'))
    assert.equal(previousObjects.backupReadBackVerified, true)
    assert.equal(previousObjects.independentRestoreReadBackVerified, true)
    assert.equal(previousObjects.frozenSourceRechecked, true)
    assert.deepEqual(manifest, previousObjects.files)
    console.log('Rehashing existing backup and independently restored objects before reuse')
    assert.deepEqual(await inventory(join(evidence, 'objects-backup')), manifest)
    assert.deepEqual(await inventory(join(evidence, 'objects-restored')), manifest)
    report.previouslyVerifiedObjectsFullyRehashed = true
  } else {
    await copyVerified(data, join(evidence, 'objects-backup'), manifest)
    console.log('Restoring all backed-up objects into a separate directory')
    await copyVerified(join(evidence, 'objects-backup'), join(evidence, 'objects-restored'), manifest)
  }
  assert.deepEqual(await inventory(data), manifest)
  await save('objects-manifest.json', { root: data, files: manifest, totalBytes: manifest.reduce((s, e) => s + e.bytes, 0), backupReadBackVerified: true, independentRestoreReadBackVerified: true, frozenSourceRechecked: true })
  console.log('Taking frozen database snapshot and rehearsing restored migrations')
  const rehearsalDirectory = join(evidence, resume ? 'database-rehearsal-resumed' : 'database-rehearsal')
  await recoveryRehearsal({ profile: profileBackup, 'postgres-bin': binaryRoot, 'output-dir': rehearsalDirectory, 'expect-target': target }, root)
  const rehearsal = JSON.parse(await readFile(join(rehearsalDirectory, 'rehearsal-report.json')))
  assert.equal(rehearsal.passed, true)
  verifyTableFingerprints(JSON.parse(await readFile(join(rehearsalDirectory, 'table-fingerprints.json'))), await fingerprintTables(fence))
  assert.equal(await fileHash(configuration.env.ENV_FILE_PATH), report.profileSha256)
  report.limitations = ['Administrator password verifiers are intentionally not exported. Roles without passwords are backed up; original ownership/ACL restoration requires separate verification.', 'Historical queued/orphaned task rows are preserved unchanged; no task is acknowledged, replayed, or reset by backup.']
  report.frozenObjectBackupVerified = true; report.snapshotRestoreVerified = true; report.migrationRehearsalVerified = true
  report.profileAndOriginalKeysRestoredByteForByte = true
  report.dump = join(rehearsalDirectory, 'database.dump'); report.dumpSha256 = rehearsal.dumpSha256
  report.databaseRehearsalDirectory = rehearsalDirectory
  report.objectFiles = manifest.length; report.objectBytes = manifest.reduce((s, e) => s + e.bytes, 0)
  report.writersFencedDuringBackup = true; report.passed = true
} catch (error) {
  report.failure = { code: typeof error.code === 'string' ? error.code : 'MAINTENANCE_BACKUP_FAILED' }
  console.error('MAINTENANCE_BACKUP_FAILED', report.failure.code)
  process.exitCode = 1
} finally {
  if (fence) { if (frozen) await fence.query('ROLLBACK'); fence.release(); report.cleanup.fenceReleased = true }
  await pool.end(); report.finishedAt = new Date().toISOString()
  await save('frozen-backup-report.json', report)
  console.log(JSON.stringify({ passed: report.passed, recovered: report.recovered.length, objectFiles: report.objectFiles, activeTaskStates: report.activeTaskStates, report: evidencePath('frozen-backup-report.json') }))
}
