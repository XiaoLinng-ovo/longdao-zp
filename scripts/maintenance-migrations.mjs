import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeConfig } from './runtime-config.mjs'
import { verifyRelease } from './runtime-release.mjs'
import { migrationPlan, validateMigrationPlan, snapshotDigest } from './migration-approval.mjs'

export function parseMaintenanceArgs(args) {
  const [action, ...rest] = args
  if (!['plan', 'check', 'apply'].includes(action) || rest.length % 2) throw new Error('Usage: maintenance-migrations.mjs plan|check|apply --profile <absolute.env> --plan <absolute.json> [--release <absolute candidate>] [--sha256 <approved plan file hash>]')
  const options = { action }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2)
    if (!['--profile', '--plan', '--release', '--sha256'].includes(rest[i]) || options[key] !== undefined) throw new Error('Invalid or duplicate maintenance option')
    options[key] = rest[i + 1]
  }
  for (const key of ['profile', 'plan']) if (!isAbsolute(options[key] || '')) throw new Error('Maintenance requires an explicit absolute ' + key + ' path')
  if (options.release && !isAbsolute(options.release)) throw new Error('Maintenance release must be absolute')
  if (action === 'apply' && (!options.release || !/^[a-f0-9]{64}$/.test(options.sha256 || ''))) throw new Error('Apply requires a verified candidate --release and --sha256 of the reviewed plan file')
  return options
}

export async function maintenanceMigrations(options, root = resolve(import.meta.dirname, '..')) {
  const source = options.release || root
  const release = options.release ? await verifyRelease(source) : undefined
  const configuration = readRuntimeConfig(root, { ...process.env, ENV_FILE_PATH: options.profile })
  const { loadDatabaseConfig } = await import(pathToFileURL(join(source, 'apps/api/dist/src/db/config.js')).href)
  const { inspectMigrationApproval, runMigrations } = await import(pathToFileURL(join(source, 'apps/api/dist/src/db/migrations.js')).href)
  if (!inspectMigrationApproval) throw new Error('MAINTENANCE_BUILD_REQUIRED: Build a candidate containing the approved migration guard')
  const { target, ...connection } = loadDatabaseConfig(configuration.env)
  const require = createRequire(join(source, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const effective = Object.fromEntries(Object.entries(configuration.env).filter(([key]) => /^(?:AUTH_|PG|DATABASE_|TENANT_|WORKER_|INTERVIEW_|RECRUITING_|S3_|SMTP_|OPENAI_|RUNTIME_|WEB_|HOST$|PORT$|NODE_ENV$|SMARTRECRUIT_)/u.test(key)))
  const context = { profileSha256: createHash('sha256').update(await readFile(options.profile)).digest('hex'),
    effectiveSha256: snapshotDigest(effective), release: release ? { id: release.id, sha256: release.sha256 } : null }
  let approval
  if (options.action !== 'plan') {
    const bytes = await readFile(options.plan)
    if (options.action === 'apply' && createHash('sha256').update(bytes).digest('hex') !== options.sha256) throw new Error('MIGRATION_APPROVAL_FILE_CHANGED: Reviewed plan bytes differ')
    const plan = JSON.parse(bytes.toString('utf8'))
    approval = validateMigrationPlan(plan)
    if (snapshotDigest(context) !== snapshotDigest(plan.context)) throw new Error('MIGRATION_APPROVAL_CONTEXT_CHANGED: Candidate or effective configuration changed')
  }
  const pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 60000,
    options: '-c search_path=public -c lock_timeout=5s' + (options.action === 'apply' ? '' : ' -c default_transaction_read_only=on'),
    application_name: 'smartrecruit-maintenance-' + options.action })
  try {
    if (options.action === 'apply') {
      const result = await runMigrations(pool, join(source, 'db/migrations'), { approval })
      return { target, release: release.id, ...result, businessRecoveryVerified: false }
    }
    const snapshot = await inspectMigrationApproval(pool, join(source, 'db/migrations'))
    if (options.action === 'check') {
      if (JSON.stringify(snapshot) !== JSON.stringify(approval)) throw new Error('MIGRATION_APPROVAL_SNAPSHOT_CHANGED: Database or candidate changed')
      return { target, approvedSnapshotMatches: true, readOnly: true, businessRecoveryVerified: false }
    }
    const plan = migrationPlan(snapshot, new Date(), context)
    await writeFile(options.plan, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    return { target, plan: options.plan, pending: snapshot.pending, snapshotSha256: plan.snapshotSha256, approvalRequired: true, readOnly: true }
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await maintenanceMigrations(parseMaintenanceArgs(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(error.code || String(error.message).split(':')[0]); process.exitCode = 1 }
}
