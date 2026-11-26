import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeConfig, validateManagedConfig } from './runtime-config.mjs'
import { inspectCompanySchemas } from './check-company-schemas.mjs'
import { verifyReleaseOriginPolicy } from './runtime-origin-check.mjs'

export async function diagnose(root, { audit = false, env = process.env, requireSameOrigin = false } = {}) {
  const report = { checkedAt: new Date().toISOString(), ready: false, readOnly: true, checks: [] }
  const check = async (name, operation) => {
    try { const detail = await operation(); report.checks.push({ name, ok: true, detail }); return detail }
    catch (error) { report.checks.push({ name, ok: false, message: error.message }); return undefined }
  }
  const configuration = await check('configuration', () => readRuntimeConfig(root, env))
  if (!configuration) return report
  if (requireSameOrigin) await check('sameOriginPolicy', () => verifyReleaseOriginPolicy(root))
  // Never include the environment or credentials in a report.
  report.checks[0].detail = { profile: configuration.env.ENV_FILE_PATH, ports: configuration.ports }
  await check('configurationContract', () => { validateManagedConfig(configuration.env); return 'Explicit database, tenant routing and object roots configured' })
  const prior = process.env
  process.env = configuration.env
  let pool
  try {
    const require = createRequire(join(root, 'apps/api/package.json'))
    const { Pool } = require('pg')
    const module = file => import(pathToFileURL(join(root, 'apps/api/dist/src', file + '.js')).href)
    const database = await check('databaseTarget', async () => {
      const { loadDatabaseConfig } = await module('db/config')
      const { target, ...connection } = loadDatabaseConfig(configuration.env)
      pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 60000, options: '-c default_transaction_read_only=on', application_name: 'smartrecruit-runtime-doctor' })
      await pool.query('SELECT 1')
      return target
    })
    if (database) {
      await check('migrations', async () => {
        const { inspectMigrations } = await module('db/migrations')
        const status = await inspectMigrations(pool, join(root, 'db/migrations'))
        report.migrations = status
        if (status.pending.length) throw new Error('MIGRATIONS_PENDING: ' + status.pending.join(', ') + '. Apply only in the approved maintenance window; startup never migrates.')
        return status
      })
      await check('releaseReadiness', async () => {
        const { checkReleaseReadiness } = await module('db/release-readiness')
        await checkReleaseReadiness(pool)
        return 'Database structure, company routes and registered storage locations match'
      })
      {
        report.dataAudit = await check('companyData', async () => inspectCompanySchemas(pool, { compareLegacy: true, classifyKeys: audit }))
        const dataCheck = report.checks.find(item => item.name === 'companyData')
        if (report.dataAudit) dataCheck.detail = { companies: report.dataAudit.companies.length, companiesWithDifferences: report.dataAudit.companies.filter(item => item.differences.length).length }
        if (report.dataAudit && !report.dataAudit.ready) {
          const companies = report.dataAudit.companies
          const codes = [...new Set(companies.flatMap(company => [
            ...(!company.validName || !company.structure_ready || !['ready','disabled'].includes(company.status) ? ['COMPANY_SCHEMA_NOT_READY'] : []),
            ...company.differences.map(item => item.code || 'DATA_PATH_CONFLICT'),
          ]))]
          if (!companies.length) codes.push('DATA_COMPANY_NOT_FOUND')
          report.checks.push({ name: 'companyDataConsistency', ok: false, message: codes.join(', ') + ': Inspect the audit phase and blockers; startup never repairs or overwrites data.' })
        }
      }
      if (audit) {
        report.activity = await check('inFlightSummary', async () => {
          const client = await pool.connect()
          try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
            await client.query("SET LOCAL statement_timeout='30s'")
            const schemas = (await client.query("SELECT schema_name FROM public.organization_schemas WHERE status='ready'")).rows.map(row => row.schema_name)
            const tables = ['analysis_tasks', 'interview_audio_transcription_jobs', 'interview_transcript_postprocess_jobs', 'interview_question_preparations', 'full_audio_transcription_tasks', 'object_cleanup_tasks', 'object_write_intents', 'offer_email_deliveries']
            const tasks = []
            for (const schema of ['public', ...schemas]) {
              if (schema !== 'public' && !/^company_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid company schema')
              for (const table of tables) {
                const present = (await client.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3', [schema, table, 'status'])).rowCount
                if (!present) continue
                const counts = (await client.query('SELECT status,count(*)::int AS count FROM "' + schema + '"."' + table + '" GROUP BY status ORDER BY status')).rows
                if (counts.length) tasks.push({ schema, table, counts })
              }
            }
            const storage = (await client.query('SELECT storage_kind,location_id,count(*)::int AS count FROM public.stored_object_locations GROUP BY storage_kind,location_id')).rows
            const operators = (await client.query('SELECT role,count(*)::int AS count FROM public.platform_operators GROUP BY role')).rows
            const connections = (await client.query("SELECT application_name,state,count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() GROUP BY application_name,state")).rows
            await client.query('COMMIT')
            return { tasks, storage, operators, connections, maintenanceQuiescenceVerified: false }
          } catch (error) { await client.query('ROLLBACK'); throw error }
          finally { client.release() }
        })
        const activityCheck = report.checks.find(item => item.name === 'inFlightSummary')
        if (report.activity) activityCheck.detail = { taskGroups: report.activity.tasks.length, maintenanceQuiescenceVerified: false }
      }
    }
  } finally { await pool?.end(); process.env = prior }
  report.ready = report.checks.every(item => item.ok)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const report = await diagnose(root, { audit: process.argv.includes('--audit') })
  console.log(JSON.stringify(report, null, 2))
  if (!report.ready) process.exitCode = 1
}
