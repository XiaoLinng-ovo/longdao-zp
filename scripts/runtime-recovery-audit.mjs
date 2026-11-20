import { createRequire } from 'node:module'
import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readRuntimeConfig, validateManagedConfig } from './runtime-config.mjs'
import { inspectCompanySchemas } from './check-company-schemas.mjs'
import { migrationPlan } from './migration-approval.mjs'
import { preparePrivateRecoveryDirectory, writePrivateRecoveryFile } from './private-recovery-files.mjs'

export function summarizeRecoveryDifferences(companyData, decisions) {
  return { tableGroups: companyData.companies.reduce((total, company) => total + company.differences.filter(table => table.entries?.length).length, 0),
    rowDifferences: decisions.length,
    byKind: Object.fromEntries(['conflict', 'company-only', 'legacy-only'].map(kind => [kind, decisions.filter(row => row.kind === kind).length])),
    nonRowBlockers: companyData.companies.reduce((total, company) => total + company.differences.filter(table => table.code).length, 0) }
}

export async function locateReference(key, roots) {
  if (!key || isAbsolute(key) || key.includes('\0') || key.split(/[\\/]/u).includes('..')) return { state: 'invalid-key', matches: [] }
  if (!roots.length) return { state: 'roots-not-reviewed', matches: [] }
  const matches = []
  for (const root of roots) {
    const candidate = resolve(root, key), child = relative(root, candidate)
    if (child.startsWith('..') || isAbsolute(child)) continue
    try {
      const canonicalRoot = await realpath(root), canonical = await realpath(candidate)
      const actual = relative(canonicalRoot, canonical)
      if (actual.startsWith('..') || isAbsolute(actual)) throw new Error('OBJECT_PATH_ESCAPE: Object path escapes its declared root')
      const info = await stat(candidate)
      if (!info.isFile()) throw new Error('OBJECT_NOT_FILE: Referenced object is not a file')
      matches.push({ root, bytes: info.size })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { state: matches.length ? 'found' : 'not-found-in-checked-roots', matches }
}

export async function recoveryAudit({ root = resolve(import.meta.dirname, '..'), env = process.env, output, resumeRoots = [], interviewRoots = [] } = {}) {
  if (!isAbsolute(output || '')) throw new Error('AUDIT_OUTPUT: Specify a new absolute --output JSON path')
  await preparePrivateRecoveryDirectory(dirname(output))
  const configuration = readRuntimeConfig(root, env)
  const { loadDatabaseConfig } = await import(pathToFileURL(join(root, 'apps/api/dist/src/db/config.js')).href)
  const { inspectMigrationApproval } = await import(pathToFileURL(join(root, 'apps/api/dist/src/db/migrations.js')).href)
  const { target, ...connection } = loadDatabaseConfig(configuration.env)
  const require = createRequire(join(root, 'apps/api/package.json')), { Pool } = require('pg')
  const pool = new Pool({ ...connection, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 60000,
    options: '-c default_transaction_read_only=on', application_name: 'smartrecruit-recovery-audit' })
  const report = { format: 'recovery-audit/v1', checkedAt: new Date().toISOString(), target,
    readOnly: true, maintenanceQuiescenceVerified: false, businessRecoveryVerified: false, checks: {} }
  try {
    try { validateManagedConfig(configuration.env); report.checks.configuration = { ok: true } }
    catch (error) { report.checks.configuration = { ok: false, message: error.message } }
    report.migrationPlan = migrationPlan(await inspectMigrationApproval(pool, join(root, 'db/migrations')))
    report.companyData = await inspectCompanySchemas(pool, { compareLegacy: true, includeEntries: true })
    const client = await pool.connect(), references = new Map()
    let transaction = false
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true
      await client.query("SET LOCAL statement_timeout='30s'")
      report.authentication = (await client.query("SELECT (SELECT count(*)::int FROM public.user_mfa_credentials) AS mfa_credentials, (SELECT count(*)::int FROM public.mfa_login_challenges WHERE encrypted_secret IS NOT NULL) AS encrypted_mfa_challenges, (SELECT count(*)::int FROM public.email_verification_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL AND expires_at>now()) AS active_email_challenges")).rows[0]
      report.platformOperators = (await client.query('SELECT role,count(*)::int AS count FROM public.platform_operators GROUP BY role ORDER BY role')).rows
      report.connections = (await client.query('SELECT application_name,state,count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() GROUP BY application_name,state ORDER BY application_name,state')).rows
      const schemas = ['public', ...report.companyData.companies.filter(company => company.validName && company.structure_ready).map(company => company.schema_name)]
      for (const schema of schemas) {
        for (const row of (await client.query('SELECT organization_id,storage_key FROM "' + schema + '".resumes WHERE storage_key IS NOT NULL AND storage_key<>\'\'')).rows) {
          const key = JSON.stringify(['resume', row.organization_id, row.storage_key])
          const ref = references.get(key) || { kind: 'resume', organizationId: row.organization_id, key: row.storage_key, schemas: [] }
          ref.schemas.push(schema); references.set(key, ref)
        }
        // Old recordings may exist without a registry row; do not mistake an empty registry for no audio.
        const audio = await client.query('SELECT i.organization_id,COALESCE(o.physical_key,r.object_key) AS storage_key FROM "' + schema + '".interview_audio_recordings r JOIN "' + schema + '".interview_live_sessions s ON s.id=r.session_id JOIN "' + schema + '".interviews i ON i.id=s.interview_id LEFT JOIN public.interview_stored_objects o ON o.organization_id=i.organization_id AND o.schema_name=$1 AND o.session_id=r.session_id AND o.storage_key=r.object_key WHERE r.object_key IS NOT NULL AND r.object_key<>\'\'', [schema])
        for (const row of audio.rows) {
          const key = JSON.stringify(['interview', row.organization_id, row.storage_key])
          const ref = references.get(key) || { kind: 'interview', organizationId: row.organization_id, key: row.storage_key, schemas: [] }
          if (!ref.schemas.includes(schema)) ref.schemas.push(schema)
          references.set(key, ref)
        }
      }
      for (const row of (await client.query('SELECT organization_id,schema_name,COALESCE(physical_key,storage_key) AS storage_key FROM public.interview_stored_objects')).rows) {
        const key = JSON.stringify(['interview', row.organization_id, row.storage_key])
        const ref = references.get(key) || { kind: 'interview', organizationId: row.organization_id, key: row.storage_key, schemas: [] }
        if (!ref.schemas.includes(row.schema_name)) ref.schemas.push(row.schema_name)
        references.set(key, ref)
      }
      report.registeredObjectLocations = (await client.query('SELECT storage_kind,location_id,count(*)::int AS count FROM public.stored_object_locations GROUP BY storage_kind,location_id ORDER BY storage_kind,location_id')).rows
      await client.query('COMMIT'); transaction = false
    } catch (error) { if (transaction) await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    const roots = {
      resume: [...new Set([configuration.env.RECRUITING_QUARANTINE_ROOT, ...resumeRoots].filter(Boolean).map(path => resolve(path)))],
      interview: [...new Set([configuration.env.INTERVIEW_STORAGE_ROOT, ...interviewRoots].filter(Boolean).map(path => resolve(path)))],
    }
    report.objects = { roots, entries: [], existenceOnly: true, backupHashesVerified: false }
    for (const reference of references.values()) report.objects.entries.push({ ...reference, ...await locateReference(reference.key, roots[reference.kind]) })
    report.auditBlockers = report.companyData.companies.flatMap(company => company.differences.filter(item => item.code).map(item => ({ organizationId: company.organization_id, phase: company.phase, ...item })))
    report.decisions = report.companyData.companies.flatMap(company => company.differences.flatMap(table => (table.entries || []).map(entry => ({
      organizationId: company.organization_id, schema: company.schema_name, table: table.table, primaryKeyColumns: table.primaryKeyColumns,
      ...entry, proposedAction: entry.kind === 'company-only' ? 'preserve-company' : entry.kind === 'legacy-only' ? 'review-copy-to-company' : 'business-review-required',
      approvedAction: null, evidenceReference: null,
    }))))
    report.warnings = ['Observational snapshots only; writers were not stopped and database/filesystem reads are not one atomic backup.',
      'Differences, keys and hashes are exported; business row bodies and credentials are not exported.',
      'Not found in the checked roots does not establish permanent loss. Approval is not inferred from this report.',
      'Object coverage: resume storage keys, interview object registry and raw audio recording references; not a complete inventory of all attachment types.']
    report.differenceSummary = summarizeRecoveryDifferences(report.companyData, report.decisions)
    await writePrivateRecoveryFile(output, JSON.stringify(report, null, 2) + '\n')
    return { output, readOnly: true, target, companies: report.companyData.companies.length,
      pending: report.migrationPlan.snapshot.pending, decisions: report.decisions.length, differenceSummary: report.differenceSummary, dataAuditReady: report.companyData.ready, auditBlockers: report.auditBlockers,
      conflicts: report.decisions.filter(item => item.kind === 'conflict').length,
      objectReferences: report.objects.entries.length, unresolvedObjects: report.objects.entries.filter(item => item.state !== 'found').length,
      objectsByKind: Object.fromEntries(['resume', 'interview'].map(kind => {
        const entries = report.objects.entries.filter(item => item.kind === kind)
        return [kind, { total: entries.length, found: entries.filter(item => item.state === 'found').length,
          notFoundInCheckedRoots: entries.filter(item => item.state === 'not-found-in-checked-roots').length,
          rootsNotReviewed: entries.filter(item => item.state === 'roots-not-reviewed').length }]
      })),
      authentication: report.authentication, businessRecoveryVerified: false }
  } finally { await pool.end() }
}

export function parseAuditArgs(args) {
  const options = { resumeRoots: [], interviewRoots: [] }
  if (args.length % 2) throw new Error('AUDIT_ARGS: Options require values')
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = args.slice(index, index + 2)
    if (!isAbsolute(value)) throw new Error('AUDIT_ARGS: All paths must be absolute')
    if (name === '--resume-root') options.resumeRoots.push(value)
    else if (name === '--interview-root') options.interviewRoots.push(value)
    else if (name === '--output' && !options.output) options.output = value
    else throw new Error('AUDIT_ARGS: Invalid or duplicate option')
  }
  if (!options.output) throw new Error('AUDIT_OUTPUT: Specify --output <new absolute JSON path>')
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await recoveryAudit(parseAuditArgs(process.argv.slice(2))), null, 2)) }
  catch (error) { console.error(error.code || String(error.message).split(':')[0]); process.exitCode = 1 }
}
