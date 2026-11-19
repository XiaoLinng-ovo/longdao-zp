import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'
import { legacySelection, legacyBaseline, readCutover, companyIntegrity, sameSnapshot, companySchema } from './company-data-model.mjs'

export async function inspectCompanySchemas(pool, options = {}) {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='60s'")
    await client.query("SET LOCAL lock_timeout='5s'")
    await client.query("SET LOCAL timezone='UTC'")
    const report = await inspectCompanyData(client, options)
    await client.query('COMMIT')
    return report
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { broken = true }
    throw error
  } finally { client.release(broken) }
}

// The caller owns the transaction so a maintenance plan can bind all reads to one snapshot.
export async function inspectCompanyData(client, { compareLegacy = false, classifyKeys = false, includeEntries = false, maxEntries = 5000, organizationId, respectCutovers = true } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid difference entry budget')
  if (organizationId) companySchema(organizationId)
    const installed = (await client.query("SELECT to_regprocedure('public.organization_schema_structure_ready(uuid)') IS NOT NULL AS installed")).rows[0].installed
    if (!installed) throw new Error('Missing migration 0093; schema inspection is unavailable')
    const companies = (await client.query("SELECT organization_id,schema_name,status,public.organization_schema_structure_ready(organization_id) AS structure_ready FROM public.organization_schemas WHERE ($1::uuid IS NULL OR organization_id=$1) ORDER BY organization_id", [organizationId || null])).rows
    const tables = (await client.query('SELECT unnest(public.organization_business_tables()) AS name')).rows.map(row => row.name)
    for (const company of companies) {
      const expected = 'company_' + company.organization_id.replaceAll('-', '').toLowerCase()
      company.validName = company.schema_name === expected && /^company_[a-f0-9]{32}$/.test(expected)
      company.differences = []
      if (!compareLegacy || !company.validName || !company.structure_ready) continue
      company.phase = 'pre-cutover'
      const cutover = respectCutovers ? await readCutover(client, company.organization_id) : null
      if (cutover) {
        company.phase = 'company-authoritative'
        company.cutoverPlanSha256 = cutover.planSha256
        company.legacyUnchanged = sameSnapshot(await legacyBaseline(client, company.organization_id, tables), cutover.legacyBaseline)
        company.integrity = await companyIntegrity(client, company.organization_id, company.schema_name, tables)
        if (!company.legacyUnchanged) company.differences.push({ table: null, code: 'LEGACY_SNAPSHOT_CHANGED', entries: [] })
        if (!company.integrity.ready) company.differences.push({ table: null, code: 'COMPANY_INTEGRITY_FAILED', entries: [], issues: company.integrity.issues })
        continue
      }
      for (const table of tables) {
        if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid business table name')
        const qualified = '"' + company.schema_name + '"."' + table + '"'
        const selection = await legacySelection(client, table)
        const counts = (await client.query('WITH legacy AS (' + selection + '), old_rows AS (SELECT to_jsonb(s) AS row FROM legacy s), new_rows AS (SELECT to_jsonb(s) AS row FROM ' + qualified + ' s) SELECT (SELECT count(*) FROM (SELECT row FROM old_rows EXCEPT ALL SELECT row FROM new_rows) x)::integer AS missing, (SELECT count(*) FROM (SELECT row FROM new_rows EXCEPT ALL SELECT row FROM old_rows) x)::integer AS extra', [company.organization_id])).rows[0]
        if (counts.missing || counts.extra) {
          const detail = { table, ...counts }
          if (classifyKeys || includeEntries) {
            const keys = (await client.query(
              'SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY a.attnum',
              ['public.' + table],
            )).rows.map(row => row.attname)
            if (!keys.length || keys.some(key => !/^[a-z_]+$/.test(key))) throw new Error('Missing/invalid primary key: ' + table)
            const key = 'jsonb_build_array(' + keys.map(name => 's."' + name + '"').join(',') + ')'
            const matched = 'WITH legacy AS (' + selection + '), old_rows AS (SELECT ' + key + ' AS k,to_jsonb(s) AS row FROM legacy s), new_rows AS (SELECT ' + key + ' AS k,to_jsonb(s) AS row FROM ' + qualified + ' s) '
            Object.assign(detail, (await client.query(matched + 'SELECT (SELECT count(*)::int FROM old_rows o WHERE NOT EXISTS(SELECT 1 FROM new_rows n WHERE n.k=o.k)) AS "legacyOnly", (SELECT count(*)::int FROM new_rows n WHERE NOT EXISTS(SELECT 1 FROM old_rows o WHERE o.k=n.k)) AS "companyOnly", (SELECT count(*)::int FROM old_rows o JOIN new_rows n USING(k) WHERE o.row<>n.row) AS conflicting', [company.organization_id])).rows[0])
            detail.changedFields = (await client.query(matched + 'SELECT DISTINCT f.key FROM old_rows o JOIN new_rows n USING(k) CROSS JOIN LATERAL jsonb_each(o.row) f WHERE f.value IS DISTINCT FROM n.row->f.key ORDER BY f.key', [company.organization_id])).rows.map(row => row.key)
            if (includeEntries) {
              if (detail.legacyOnly + detail.companyOnly + detail.conflicting > maxEntries)
                throw new Error('DATA_DIFF_BUDGET: Split the maintenance scope before exporting entries')
              const entries = (await client.query(matched + `
                SELECT COALESCE(o.k,n.k) AS "primaryKey",
                  CASE WHEN o.k IS NULL THEN 'company-only' WHEN n.k IS NULL THEN 'legacy-only' ELSE 'conflict' END AS kind,
                  CASE WHEN o.row IS NOT NULL THEN encode(sha256(convert_to(o.row::text,'UTF8')),'hex') END AS "legacyHash",
                  CASE WHEN n.row IS NOT NULL THEN encode(sha256(convert_to(n.row::text,'UTF8')),'hex') END AS "companyHash",
                  ARRAY(SELECT f.key FROM jsonb_each(COALESCE(o.row,n.row)) f
                    WHERE o.row->f.key IS DISTINCT FROM n.row->f.key ORDER BY f.key) AS "changedFields"
                FROM old_rows o FULL JOIN new_rows n USING(k) WHERE o.row IS DISTINCT FROM n.row
                ORDER BY COALESCE(o.k,n.k)::text LIMIT $2
              `, [company.organization_id, maxEntries + 1])).rows
              if (entries.length > maxEntries) throw new Error('DATA_DIFF_BUDGET: Difference export exceeded the entry budget')
              detail.primaryKeyColumns = keys
              detail.entries = entries
            }
          }
          company.differences.push(detail)
        }
      }
    }
    return { compareLegacy, ready: companies.length > 0 && companies.every(c => c.validName && c.structure_ready && ['ready','disabled'].includes(c.status) && !c.differences.length), companies }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(import.meta.dirname, '..')
  const load = file => import(pathToFileURL(join(root,'apps/api/dist/src',file+'.js')).href)
  await load('env')
  const { loadDatabaseConfig } = await load('db/config')
  const { target, ...config } = loadDatabaseConfig()
  const require = createRequire(join(root, 'apps/api/package.json'))
  const { Pool } = require('pg')
  const pool = new Pool(config)
  try {
    const report = await inspectCompanySchemas(pool, { compareLegacy: process.argv.includes('--compare-legacy') })
    console.log(JSON.stringify(report, null, 2))
    if (!report.ready) process.exitCode = 1
  } catch (error) { console.error('Company schema inspection failed: ' + error.message); process.exitCode = 1 }
  finally { await pool.end() }
}
