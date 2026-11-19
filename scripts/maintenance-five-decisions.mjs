import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeConfig } from './runtime-config.mjs'
import { verifyRelease } from './runtime-release.mjs'
import { snapshotDigest } from './migration-approval.mjs'
import { companySchema } from './company-data-model.mjs'
import { buildConflictPlan, executeConflictPlan, validateConflictPlan } from './company-conflict-repair.mjs'
import { verifyRecoveryPath, writePrivateRecoveryFile } from './private-recovery-files.mjs'
import { listMigrationFiles } from '../packages/database-readiness/index.js'
import { readStructureContract } from '../packages/database-readiness/structure-contract.js'

const root = resolve(import.meta.dirname, '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function parseFiveDecisionArgs(args) {
  const [action, ...rest] = args
  if (!['plan','check','apply'].includes(action) || rest.length % 2) throw Error('REPAIR_ARGS')
  const options = { action }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index].slice(2)
    if (!['--profile','--plan','--backup','--organization','--release','--sha256'].includes(rest[index]) || options[key] !== undefined || !rest[index + 1]) throw Error('REPAIR_ARGS')
    options[key] = rest[index + 1]
  }
  for (const key of ['profile','plan','backup','release']) if (!isAbsolute(options[key] || '')) throw Error('REPAIR_ARGS')
  companySchema(options.organization)
  if ((action !== 'plan' && !/^[a-f0-9]{64}$/.test(options.sha256 || '')) || (action === 'plan' && options.sha256)) throw Error('REPAIR_ARGS')
  return options
}

export async function fiveDecisionMaintenance(input) {
  const options = parseFiveDecisionArgs([input.action, ...Object.entries(input).filter(([key]) => key !== 'action').flatMap(([key,value]) => ['--' + key,value])])
  if (resolve(options.release) !== root) throw Error('REPAIR_CANDIDATE_REQUIRED')
  const release = await verifyRelease(options.release)
  await verifyRecoveryPath(options.profile)
  await verifyRecoveryPath(options.backup)
  const configuration = readRuntimeConfig(root, { ...process.env, ENV_FILE_PATH: options.profile })
  if (!configuration.env.DATABASE_URL?.trim() && !['PGHOST','PGPORT','PGDATABASE','PGUSER'].every(key => configuration.env[key]?.trim())) throw Error('REPAIR_DATABASE_TARGET_REQUIRED')
  const backupDigest = createHash('sha256')
  for await (const bytes of createReadStream(options.backup)) backupDigest.update(bytes)
  const toolFiles = ['scripts/maintenance-five-decisions.mjs','scripts/company-conflict-repair.mjs','scripts/company-data-model.mjs',
    'scripts/check-company-schemas.mjs','scripts/migration-approval.mjs','scripts/recovery-snapshot.mjs','scripts/private-recovery-files.mjs',
    'scripts/runtime-config.mjs','packages/database-readiness/structure-contract.js','packages/database-readiness/structure-contract.json']
  const context = { profileSha256: hash(await readFile(options.profile)), backupSha256: backupDigest.digest('hex'),
    effectiveSha256: snapshotDigest(Object.fromEntries(Object.entries(configuration.env).filter(([key]) => /^(AUTH_|PG|DATABASE_|TENANT_|WORKER_|INTERVIEW_|RECRUITING_|S3_|SMTP_|RUNTIME_|NODE_ENV$|SMARTRECRUIT_)/u.test(key)))),
    toolSha256: snapshotDigest(await Promise.all(toolFiles.map(async name => ({ name, sha256: hash(await readFile(join(root,name))) })))),
    release: { id: release.id, sha256: release.sha256 } }
  let plan
  if (options.action !== 'plan') {
    await verifyRecoveryPath(options.plan)
    const bytes = await readFile(options.plan)
    if (hash(bytes) !== options.sha256) throw Error('REPAIR_PLAN_FILE_CHANGED')
    plan = JSON.parse(bytes.toString('utf8'))
    validateConflictPlan(plan)
    if (plan.snapshot.organizationId !== options.organization || snapshotDigest(plan.context) !== snapshotDigest(context)) throw Error('REPAIR_PLAN_CONTEXT_CHANGED')
  }
  const { loadDatabaseConfig } = await import(pathToFileURL(join(root,'apps/api/dist/src/db/config.js')).href)
  const { target, ...connection } = loadDatabaseConfig(configuration.env)
  const require = createRequire(join(root,'apps/api/package.json')), { Pool } = require('pg')
  const pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 60000,
    options: '-c search_path=pg_catalog,public -c timezone=UTC' + (options.action === 'apply' ? '' : ' -c default_transaction_read_only=on'),
    application_name: 'smartrecruit-five-decisions-' + options.action })
  try {
    const contract = await readStructureContract(await listMigrationFiles(join(root,'db/migrations')))
    if (options.action === 'plan') {
      plan = await buildConflictPlan(pool, { organizationId: options.organization, context, contract })
      const bytes = JSON.stringify(plan,null,2) + '\n'
      await writePrivateRecoveryFile(options.plan,bytes)
      return { target, plan: options.plan, snapshotSha256: plan.snapshotSha256, planFileSha256: hash(bytes), repairedRows: plan.snapshot.entries.length,
        dependenciesToCopy: plan.snapshot.dependencies.filter(row => row.targetHash === null).length, remainingDifferences: plan.snapshot.remaining.length,
        approvalRequired: true, readOnly: true, businessRecoveryVerified: false }
    }
    return { target, ...await executeConflictPlan(pool,plan,{apply:options.action === 'apply',contract}) }
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await fiveDecisionMaintenance(parseFiveDecisionArgs(process.argv.slice(2))),null,2)) }
  catch (error) { console.error(/^REPAIR_[A-Z_]+$/.test(error.message) ? error.message : 'REPAIR_FAILED'); process.exitCode = 1 }
}
