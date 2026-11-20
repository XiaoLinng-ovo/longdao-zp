import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeConfig } from './runtime-config.mjs'
import { verifyRelease } from './runtime-release.mjs'
import { snapshotDigest } from './migration-approval.mjs'
import { companySchema } from './company-data-model.mjs'
import { buildCompanyPlan, executeCompanyPlan, validateCompanyPlan } from './company-data-maintenance.mjs'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { readStructureContract } from '../packages/database-readiness/structure-contract.js'

const root = resolve(import.meta.dirname, '..')
const hash = value => createHash('sha256').update(value).digest('hex')
export function parseCompanyMaintenanceArgs(args) {
  const [action, ...rest] = args
  if (!['plan','check','apply'].includes(action) || rest.length % 2) throw new Error('DATA_ARGS: Expected plan|check|apply with explicit paths')
  const options = { action }
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2)
    if (!['--profile','--plan','--backup','--organization','--intent','--release','--sha256'].includes(rest[i]) || options[key] !== undefined || !rest[i + 1]) throw new Error('DATA_ARGS: Unknown or duplicate option')
    options[key] = rest[i + 1]
  }
  for (const key of ['profile','plan','backup']) if (!isAbsolute(options[key] || '')) throw new Error('DATA_ARGS: An explicit absolute ' + key + ' is required')
  companySchema(options.organization)
  if (!['reconcile','seal'].includes(options.intent)) throw new Error('DATA_ARGS: Explicit --intent reconcile|seal is required')
  if (options.release && !isAbsolute(options.release)) throw new Error('DATA_ARGS: Release must be absolute')
  if (action === 'apply' && (!options.release || !/^[a-f0-9]{64}$/.test(options.sha256 || ''))) throw new Error('DATA_ARGS: Apply requires --release and the reviewed plan file --sha256')
  return options
}

export async function companyDataMaintenance(options) {
  const release = options.release ? await verifyRelease(options.release) : null
  if (options.release && resolve(options.release) !== root) throw new Error('DATA_CANDIDATE_REQUIRED: Invoke this command from the selected verified release')
  const configuration = readRuntimeConfig(root, { ...process.env, ENV_FILE_PATH: options.profile })
  const backupDigest = createHash('sha256')
  for await (const bytes of createReadStream(options.backup)) backupDigest.update(bytes)
  const toolFiles = ['scripts/maintenance-company-data.mjs','scripts/company-data-maintenance.mjs','scripts/company-data-model.mjs',
    'scripts/check-company-schemas.mjs','scripts/migration-approval.mjs','packages/database-readiness/structure-contract.json']
  const context = { profileSha256: hash(await readFile(options.profile)), backupSha256: backupDigest.digest('hex'),
    effectiveSha256: snapshotDigest(Object.fromEntries(Object.entries(configuration.env).filter(([key]) => /^(AUTH_|PG|DATABASE_|TENANT_|WORKER_|INTERVIEW_|RECRUITING_|S3_|SMTP_|RUNTIME_|NODE_ENV$|SMARTRECRUIT_)/u.test(key)))),
    toolSha256: snapshotDigest(await Promise.all(toolFiles.map(async name => ({ name, sha256: hash(await readFile(join(root, name))) })))),
    release: release ? { id: release.id, sha256: release.sha256 } : null }
  let plan
  if (options.action !== 'plan') {
    const bytes = await readFile(options.plan)
    if (options.sha256 && hash(bytes) !== options.sha256) throw new Error('DATA_PLAN_FILE_CHANGED')
    plan = JSON.parse(bytes.toString('utf8'))
    validateCompanyPlan(plan)
    if (plan.intent !== options.intent || plan.snapshot.organizationId !== options.organization || snapshotDigest(plan.context) !== snapshotDigest(context)) throw new Error('DATA_PLAN_CONTEXT_CHANGED')
  }
  const { loadDatabaseConfig } = await import(pathToFileURL(join(root, 'apps/api/dist/src/db/config.js')).href)
  const { target, ...connection } = loadDatabaseConfig(configuration.env)
  const require = createRequire(join(root, 'apps/api/package.json')), { Pool } = require('pg')
  const pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 60000,
    options: '-c search_path=pg_catalog,public -c timezone=UTC' + (options.action === 'apply' ? '' : ' -c default_transaction_read_only=on'),
    application_name: 'smartrecruit-company-data-' + options.action })
  try {
    const contract = await readStructureContract(await listMigrationFiles(join(root, 'db/migrations')))
    if (options.action === 'plan') {
      plan = await buildCompanyPlan(pool, { organizationId: options.organization, intent: options.intent, context, contract })
      await writeFile(options.plan, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      return { target, plan: options.plan, snapshotSha256: plan.snapshotSha256, entries: plan.snapshot.entries.length,
        reviewRequired: plan.snapshot.entries.filter(e => !e.action || e.importCheck?.ready === false).map(e => ({ table: e.table, primaryKey: e.primaryKey, code: e.importCheck?.code || 'BUSINESS_REVIEW_REQUIRED' })),
        approvalRequired: true, readOnly: true, businessRecoveryVerified: false }
    }
    return { target, ...await executeCompanyPlan(pool, plan, { apply: options.action === 'apply', contract }) }
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await companyDataMaintenance(parseCompanyMaintenanceArgs(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(String(error.message).split(':')[0]); process.exitCode = 1 }
}
