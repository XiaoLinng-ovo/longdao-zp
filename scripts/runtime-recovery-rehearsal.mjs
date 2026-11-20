import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { isolatedEnvironment, startIsolatedPostgres } from './isolated-environment.mjs'
import { readRuntimeConfig } from './runtime-config.mjs'
import { inspectCompanySchemas } from './check-company-schemas.mjs'
import { protectRecoveryPath, writePrivateRecoveryFile } from './private-recovery-files.mjs'
import { fingerprintTables, verifyTableFingerprints, captureMigrationBaseline, verifyMigratedRecoverySnapshot, verifyRecoveryMigrationScope } from './recovery-snapshot.mjs'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { readStructureContract } from '../packages/database-readiness/structure-contract.js'

export { fingerprintTables, verifyTableFingerprints } from './recovery-snapshot.mjs'
export { protectRecoveryPath as protectRecoveryDirectory } from './private-recovery-files.mjs'

const execute = promisify(execFile)
const quote = value => '"' + value.replaceAll('"', '""') + '"'

export function parseRehearsalArgs(args) {
  const options = {}
  if (args.length % 2) throw new Error('REHEARSAL_ARGS: Options require values')
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2)
    if (!['--profile', '--postgres-bin', '--output-dir', '--expect-target'].includes(args[i]) || options[key] !== undefined)
      throw new Error('REHEARSAL_ARGS: Invalid or duplicate option')
    options[key] = args[i + 1]
  }
  for (const key of ['profile', 'postgres-bin', 'output-dir'])
    if (!isAbsolute(options[key] || '')) throw new Error('REHEARSAL_ARGS: Explicit absolute paths are required')
  if (!options['expect-target']) throw new Error('REHEARSAL_ARGS: An explicit expected source target is required')
  return options
}

async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function recoveryRehearsal(options, root = resolve(import.meta.dirname, '..')) {
  const configuration = readRuntimeConfig(root, { ...process.env, ENV_FILE_PATH: options.profile })
  const { loadDatabaseConfig } = await import(pathToFileURL(join(root, 'apps/api/dist/src/db/config.js')).href)
  const { inspectMigrationApproval, runMigrations } = await import(pathToFileURL(join(root, 'apps/api/dist/src/db/migrations.js')).href)
  const { target, ...connection } = loadDatabaseConfig(configuration.env)
  if (target !== options['expect-target']) throw new Error('REHEARSAL_TARGET: Configured source differs from the explicitly reviewed target')
  const directory = options['output-dir'], binary = name => join(options['postgres-bin'], name + (process.platform === 'win32' ? '.exe' : ''))
  await mkdir(directory, { recursive: false, mode: 0o700 })
  await protectRecoveryPath(directory)
  const output = join(directory, 'rehearsal-report.json'), dump = join(directory, 'database.dump')
  const report = { format: 'business-db-rehearsal/v1', startedAt: new Date().toISOString(), target,
    sourceReadOnly: true, writersDrained: false, frozenObjectBackupVerified: false,
    businessRecoveryVerified: false, passed: false, cleanup: {},
    limitations: ['Database snapshot and isolated migration rehearsal only; no business cutover or reconciliation.',
      'Writers were not drained or fenced. Sequence state and external objects are not one frozen atomic backup.',
      'Roles/ACLs, tablespaces, external objects and independently held keys are not restore-verified.',
      'Only database row counts and sorted row hashes are compared; no application or external side effects are executed.'] }
  const require = createRequire(join(root, 'apps/api/package.json')), { Pool } = require('pg')
  const source = new Pool({ ...connection, max: 1, options: '-c default_transaction_read_only=on -c search_path=public -c timezone=UTC -c statement_timeout=60s -c idle_in_transaction_session_timeout=15min', application_name: 'smartrecruit-readonly-backup' })
  let client, transaction = false, instance, admin, clone
  let failed = false
  try {
    report.stage = 'backup-profile'
    const profile = await readFile(options.profile)
    await writePrivateRecoveryFile(join(directory, 'source-profile.env'), profile)
    report.profileSha256 = createHash('sha256').update(profile).digest('hex')
    client = await source.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true
    const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot
    report.identity = (await client.query("SELECT current_database() AS database,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('server_version') AS version")).rows[0]
    const parameters = client.connectionParameters
    if (parameters.ssl) throw new Error('REHEARSAL_TLS: Explicit CLI TLS mapping requires review; refuse silently downgrading TLS')
    const cliEnv = isolatedEnvironment({ PGHOST: parameters.host, PGPORT: String(parameters.port),
      PGDATABASE: parameters.database, PGUSER: parameters.user, PGPASSWORD: parameters.password || '',
      PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'disable', PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=60s' })
    console.log('Creating read-only exported-snapshot dump')
    report.stage = 'database-dump'
    await execute(binary('pg_dump'), ['--format=custom', '--no-password', '--lock-wait-timeout=5s', '--snapshot=' + snapshot, '--file=' + dump], {
      env: cliEnv, windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024,
    })
    await protectRecoveryPath(dump)
    report.dumpSha256 = await fileHash(dump)
    console.log('Fingerprinting source tables in the same snapshot')
    report.stage = 'source-fingerprints'
    const original = await fingerprintTables(client)
    report.tables = original.length
    await writePrivateRecoveryFile(join(directory, 'table-fingerprints.json'), JSON.stringify(original, null, 2) + '\n')
    await client.query('COMMIT'); transaction = false; client.release(); client = undefined
    await source.end()
    report.cleanup.sourceClosed = true
    console.log('Restoring into a fresh private PostgreSQL cluster')
    report.stage = 'private-cluster'
    instance = await startIsolatedPostgres(options['postgres-bin'])
    await protectRecoveryPath(instance.directory)
    report.isolatedDirectory = instance.directory
    admin = new Pool(instance.connection)
    const database = 'recovery_' + randomUUID().replaceAll('-', '')
    await admin.query('CREATE DATABASE ' + quote(database))
    assert.notEqual(instance.port, Number(parameters.port), 'REHEARSAL_BOUNDARY: Isolated port must differ from source')
    report.stage = 'database-restore'
    await execute(binary('pg_restore'), ['--no-password', '--no-owner', '--no-acl', '--no-tablespaces', '--exit-on-error', '--single-transaction', '--dbname=' + database, dump], {
      env: { ...instance.env, PGOPTIONS: '-c timezone=UTC' }, windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024,
    })
    clone = new Pool({ ...instance.connection, database, max: 1,
      options: '-c search_path=public -c timezone=UTC -c lock_timeout=5s -c statement_timeout=60s' })
    report.stage = 'restore-fingerprints'
    verifyTableFingerprints(original, await fingerprintTables(clone))
    report.snapshotRestoreVerified = true
    const directorySql = join(root, 'db/migrations'), approval = await inspectMigrationApproval(clone, directorySql)
    verifyRecoveryMigrationScope(approval, { allowAlreadyApplied: true })
    const before = await inspectCompanySchemas(clone, { compareLegacy: true, includeEntries: true })
    await writePrivateRecoveryFile(join(directory, 'restored-company-differences.json'), JSON.stringify(before, null, 2) + '\n')
    if (approval.pending.length) {
      const baseline = await captureMigrationBaseline(clone)
      const contract = await readStructureContract(await listMigrationFiles(directorySql))
      console.log('Rehearsing exactly 0101-0104 on the restored copy')
      report.stage = 'approved-clone-migrations'
      report.migrations = await runMigrations(clone, directorySql, { approval })
      report.migrationDataChecks = await verifyMigratedRecoverySnapshot(clone, baseline, original, contract)
    } else {
      console.log('No pending migrations; verifying restored data without schema changes')
      verifyTableFingerprints(original, await fingerprintTables(clone))
      report.migrations = { applied: [] }
      report.migrationDataChecks = { noPendingMigrations: true, businessRowsUnchanged: true }
    }
    const after = await inspectMigrationApproval(clone, directorySql)
    assert.deepEqual(after.pending, [])
    report.companyConflicts = before.companies.flatMap(company => company.differences.flatMap(table => table.entries)).filter(entry => entry.kind === 'conflict').length
    report.migrationRehearsalVerified = true
    report.businessRowsUnchangedByMigrations = true
    report.stage = 'verified'
    report.passed = true
  } catch (error) {
    failed = true
    // Database errors can contain row bodies; never persist message/detail/stack.
    report.failure = { code: typeof error.code === 'string' ? error.code : 'REHEARSAL_FAILED' }
  } finally {
    const clean = async (name, action) => {
      try { await action(); report.cleanup[name] = true }
      catch { report.cleanup[name] = false; failed = true }
    }
    if (client) {
      if (transaction) await clean('snapshotRolledBack', () => client.query('ROLLBACK'))
      client.release(true)
    }
    if (!source.ended) await clean('sourceClosed', () => source.end())
    if (clone) await clean('cloneClosed', () => clone.end())
    if (admin) await clean('adminClosed', () => admin.end())
    if (instance) await clean('isolatedPostgresStopped', () => instance.stop())
    report.passed = report.passed && !failed
    report.finishedAt = new Date().toISOString()
    await writePrivateRecoveryFile(output, JSON.stringify(report, null, 2) + '\n')
  }
  if (!report.passed) throw new Error('REHEARSAL_FAILED: Inspect protected report: ' + output)
  return { output, passed: true, tables: report.tables, snapshotRestoreVerified: true,
    migrations: report.migrations.applied, businessRecoveryVerified: false, writersDrained: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await recoveryRehearsal(parseRehearsalArgs(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(error.message?.startsWith('REHEARSAL_') ? error.message : 'REHEARSAL_FAILED'); process.exitCode = 1 }
}
