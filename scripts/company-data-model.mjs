import { snapshotDigest } from './migration-approval.mjs'

export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const owners = {
  ai_resume_scoring_skill_jobs: ['jobs', 'job_id', 'id'],
  department_approval_policies: ['departments', 'department_id', 'id'],
  interview_audio_recordings: ['interview_live_sessions', 'session_id', 'id'],
  interview_audio_transcription_jobs: ['interview_live_sessions', 'session_id', 'id'],
  interview_question_preparations: ['interviews', 'interview_id', 'id'],
  interview_transcript_versions: ['interview_live_sessions', 'session_id', 'id'],
  interview_transcript_postprocess_jobs: ['interview_live_sessions', 'session_id', 'id'],
}
export const workflowSubjects = { recruitment_request: 'recruitment_requests', job: 'jobs', candidate: 'candidates', application: 'applications', interview: 'interviews', offer: 'offers', onboarding: 'onboarding_records', onboarding_record: 'onboarding_records', resume: 'resumes' }
export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('DATA_IDENTIFIER_INVALID')
  return '"' + value + '"'
}
export const qualified = (schema, table) => identifier(schema) + '.' + identifier(table)
export function companySchema(id) {
  if (!uuidPattern.test(id || '')) throw new Error('DATA_ORGANIZATION_INVALID')
  return 'company_' + id.replaceAll('-', '')
}
export async function legacySelection(client, table) {
  const source = qualified('public', table)
  const direct = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='organization_id'", [table])).rowCount > 0
  if (direct) return 'SELECT s.* FROM ' + source + ' s WHERE s.organization_id=$1'
  const owner = owners[table]
  if (owner) return 'SELECT s.* FROM ' + source + ' s JOIN ' + qualified('public', owner[0]) + ' p ON p.' + identifier(owner[2]) + '=s.' + identifier(owner[1]) + ' WHERE p.organization_id=$1'
  // These legacy integration tables are globally scoped, not company-owned snapshots.
  if (['external_entity_mappings', 'external_event_receipts'].includes(table)) return 'SELECT s.* FROM ' + source + ' s WHERE false AND $1::uuid IS NOT NULL'
  throw new Error('DATA_OWNERSHIP_UNKNOWN: ' + table)
}
export async function fingerprintSelection(client, selection, values = []) {
  return (await client.query("SELECT count(*)::text AS rows,encode(sha256(convert_to(COALESCE(string_agg(digest,'' ORDER BY digest),''),'UTF8')),'hex') AS sha256 FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM (" + selection + ') t) hashes', values)).rows[0]
}
export async function legacyBaseline(client, organizationId, tables) {
  const baseline = []
  for (const table of [...tables].sort()) baseline.push({ table, ...await fingerprintSelection(client, await legacySelection(client, table), [organizationId]) })
  return baseline
}
export async function legacyBaselineMatches(client, organizationId, tables, expected) {
  const current = await legacyBaseline(client, organizationId, tables)
  if (sameSnapshot(current, expected)) return true
  if (!tables.includes('enterprise_ai_settings')) return false
  // 0107 adds only default false to frozen rows; preserve pre-0107 receipts without hiding enabled settings or other changes.
  const selection = await legacySelection(client, 'enterprise_ai_settings')
  const previous = (await client.query("SELECT count(*)::text AS rows,encode(sha256(convert_to(COALESCE(string_agg(digest,'' ORDER BY digest),''),'UTF8')),'hex') AS sha256 FROM (SELECT encode(sha256(convert_to((CASE WHEN to_jsonb(t)->'self_service_enabled'='false'::jsonb THEN to_jsonb(t)-'self_service_enabled' ELSE to_jsonb(t) END)::text,'UTF8')),'hex') AS digest FROM (" + selection + ') t) hashes', [organizationId])).rows[0]
  return sameSnapshot(current.map(entry => entry.table === 'enterprise_ai_settings' ? { table: entry.table, ...previous } : entry), expected)
}
export async function readCutover(client, organizationId) {
  const installed = (await client.query("SELECT to_regprocedure('public.read_company_data_cutover(uuid)') IS NOT NULL AS installed")).rows[0].installed
  return installed ? (await client.query('SELECT public.read_company_data_cutover($1) AS cutover', [organizationId])).rows[0].cutover : null
}
export async function companyIntegrity(client, organizationId, schema, tables) {
  if (schema !== companySchema(organizationId)) throw new Error('DATA_SCHEMA_MISMATCH')
  const issues = []
  for (const table of tables) {
    const direct = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='organization_id'", [schema, table])).rowCount > 0
    if (direct && (await client.query('SELECT 1 FROM ' + qualified(schema, table) + ' WHERE organization_id IS DISTINCT FROM $1::uuid LIMIT 1', [organizationId])).rowCount) issues.push({ code: 'COMPANY_OWNER_MISMATCH', table })
    const owner = owners[table]
    if (!direct && owner) {
      const parentSchema = tables.includes(owner[0]) ? schema : 'public'
      const selection = 'SELECT 1 FROM ' + qualified(schema, table) + ' s JOIN ' + qualified(parentSchema, owner[0]) + ' p ON p.' + identifier(owner[2]) + '=s.' + identifier(owner[1]) + ' WHERE p.organization_id IS DISTINCT FROM $1::uuid LIMIT 1'
      if ((await client.query(selection, [organizationId])).rowCount) issues.push({ code: 'COMPANY_OWNER_MISMATCH', table })
    }
  }
  // Check actual relationships too: a historical row can predate a validated FK.
  const foreignKeys = (await client.query(`SELECT c.conname AS name,t.relname AS table,pn.nspname AS parent_schema,p.relname AS parent_table,
    array_agg(a.attname::text ORDER BY u.ord) AS columns,array_agg(b.attname::text ORDER BY u.ord) AS parent_columns
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class p ON p.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY u(a,b,ord)
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.a JOIN pg_attribute b ON b.attrelid=p.oid AND b.attnum=u.b
    WHERE c.contype='f' AND n.nspname=$1 AND t.relname=ANY($2::text[]) GROUP BY c.oid,t.relname,pn.nspname,p.relname ORDER BY t.relname,c.conname`, [schema, tables])).rows
  for (const fk of foreignKeys) {
    if (fk.parent_schema !== schema && tables.includes(fk.parent_table)) { issues.push({ code: 'CROSS_SCHEMA_BUSINESS_REFERENCE', table: fk.table, constraint: fk.name }); continue }
    const nonNull = fk.columns.map(column => 's.' + identifier(column) + ' IS NOT NULL').join(' AND ')
    const match = fk.columns.map((column, i) => 'p.' + identifier(fk.parent_columns[i]) + '=s.' + identifier(column)).join(' AND ')
    if ((await client.query('SELECT 1 FROM ' + qualified(schema, fk.table) + ' s WHERE ' + nonNull + ' AND NOT EXISTS(SELECT 1 FROM ' + qualified(fk.parent_schema, fk.parent_table) + ' p WHERE ' + match + ') LIMIT 1')).rowCount) issues.push({ code: 'REFERENCE_MISSING', table: fk.table, constraint: fk.name })
  }
  // Existing workflow history may intentionally outlive a deleted subject. Import checks are separate.
  return { ready: !issues.length, issues }
}
export const sameSnapshot = (a, b) => snapshotDigest(a) === snapshotDigest(b)
