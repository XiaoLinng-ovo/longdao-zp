import assert from 'node:assert/strict'
import { assertStructureContract } from '../packages/database-readiness/structure-contract.js'

const quote = value => '"' + value.replaceAll('"', '""') + '"'
export const recoveryMigrations = Object.freeze([
  { name: '0101_audio_reference_owner.sql', sha256: 'd28ecf9f1b730ae15bd155c04f02427ce9cd7a3117dd548fc030fc712355600f' },
  { name: '0102_platform_operator_role_constraint.sql', sha256: '69b6b6dfce9f9cc152d0ac89015a578742da77e5bb545ed60538999f7e3be530' },
  { name: '0103_interview_completion_role_review.sql', sha256: 'b8b2a34017689ff86f33f0d852c56d6d098572bf7e70f0db8978ff382f98e0a4' },
  { name: '0104_company_data_cutover.sql', sha256: '9310df116b525780ad6c7d7fbf5606e547d29c7fdfcd5c43286bfbe04ceffad3' },
])
const controlTables = ['company_data_cutovers', 'maintenance_receipts']
const tableKey = table => table.schema + '.' + table.name
const roleColumn = { name: 'manual_transcript_roles', type: 'jsonb', notNull: true, identity: '', generated: '', default: "'[]'::jsonb" }

export function verifyRecoveryMigrationScope(approval, { allowAlreadyApplied = false } = {}) {
  if (allowAlreadyApplied && approval.pending.length === 0) return
  assert.deepEqual(approval.pending, recoveryMigrations.map(file => file.name), 'REHEARSAL_MIGRATIONS: Only the reviewed 0101-0104 range may run')
  assert.deepEqual(approval.files.filter(file => approval.pending.includes(file.name)), recoveryMigrations, 'REHEARSAL_MIGRATION_BYTES: Reviewed SQL bytes changed')
}

export async function fingerprintTables(client, { omitRoleReviewSchemas = [] } = {}) {
  const tables = (await client.query("SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' AND c.relkind IN ('r','p','m') AND c.relispopulated ORDER BY n.nspname,c.relname")).rows
  const entries = []
  for (const table of tables) {
    const projection = table.name === 'interview_live_sessions' && omitRoleReviewSchemas.includes(table.schema) ? "(to_jsonb(t)-'manual_transcript_roles')" : 'to_jsonb(t)'
    const result = (await client.query("SELECT count(*)::text AS rows,encode(sha256(convert_to(COALESCE(string_agg(digest,'' ORDER BY digest),''),'UTF8')),'hex') AS sha256 FROM (SELECT encode(sha256(convert_to(" + projection + "::text,'UTF8')),'hex') AS digest FROM " + quote(table.schema) + '.' + quote(table.name) + ' t) hashes')).rows[0]
    entries.push({ ...table, ...result })
  }
  return entries
}

export function verifyTableFingerprints(source, restored, { excludeLedger = false } = {}) {
  const filter = rows => rows.filter(row => !excludeLedger || row.schema !== 'public' || row.name !== 'schema_migrations')
  assert.deepEqual(filter(restored), filter(source), 'REHEARSAL_DATA_MISMATCH: Restored table rows differ from the exported snapshot')
}

async function captureCatalog(client) {
  return (await client.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' AND c.relkind IN ('r','p','m') AND c.relispopulated
    ORDER BY n.nspname,c.relname`)).rows
}

export async function captureMigrationBaseline(client) {
  return { catalog: await captureCatalog(client), companies: (await client.query('SELECT organization_id,schema_name FROM public.organization_schemas ORDER BY schema_name')).rows }
}

export function validateMigrationCatalog(before, after, companies) {
  const targets = ['public', ...companies.map(company => company.schema_name)]
  const previous = new Map(before.map(table => [tableKey(table), table]))
  const current = new Map(after.map(table => [tableKey(table), table]))
  for (const name of controlTables) {
    const key = 'recovery_control.' + name
    assert.ok(!previous.has(key) && current.get(key)?.kind === 'r', 'REHEARSAL_SCHEMA_MISMATCH: Expected new empty maintenance table')
    current.delete(key)
  }
  assert.equal(current.size, previous.size, 'REHEARSAL_SCHEMA_MISMATCH: Unexpected table count')
  const roleSchemas = []
  for (const [key, table] of previous) {
    assert.ok(current.has(key), 'REHEARSAL_SCHEMA_MISMATCH: Existing table disappeared')
    const addsRoles = table.kind === 'r' && table.name === 'interview_live_sessions' && targets.includes(table.schema)
    if (addsRoles) {
      assert.ok(!table.columns.some(column => column.name === roleColumn.name), 'REHEARSAL_SCHEMA_MISMATCH: Role column already exists')
      roleSchemas.push(table.schema)
    }
    assert.deepEqual(current.get(key), { ...table, columns: addsRoles ? [...table.columns, roleColumn] : table.columns }, 'REHEARSAL_SCHEMA_MISMATCH: Unreviewed column or table change')
  }
  assert.ok(roleSchemas.includes('public'), 'REHEARSAL_SCHEMA_MISMATCH: Missing public interview table')
  return roleSchemas
}

export async function verifyMigratedRecoverySnapshot(client, baseline, original, contract) {
  const roleSchemas = validateMigrationCatalog(baseline.catalog, await captureCatalog(client), baseline.companies)
  const current = await fingerprintTables(client, { omitRoleReviewSchemas: roleSchemas })
  const added = current.filter(table => table.schema === 'recovery_control')
  assert.deepEqual(added.map(table => table.name).sort(), controlTables, 'REHEARSAL_SCHEMA_MISMATCH: Unexpected maintenance tables')
  assert.ok(added.every(table => table.rows === '0'), 'REHEARSAL_UNEXPECTED_CUTOVER: Migration must not create approvals or cutovers')
  verifyTableFingerprints(original, current.filter(table => table.schema !== 'recovery_control'), { excludeLedger: true })
  for (const schema of roleSchemas) {
    const invalid = await client.query('SELECT 1 FROM ' + quote(schema) + '.interview_live_sessions WHERE manual_transcript_roles IS DISTINCT FROM \'[]\'::jsonb LIMIT 1')
    assert.equal(invalid.rowCount, 0, 'REHEARSAL_FABRICATED_ROLES: Migration must leave all manual role choices empty')
  }
  assert.ok(contract?.control, 'REHEARSAL_CONTRACT_REQUIRED: Full 0104 structure contract required')
  await assertStructureContract(client, contract, baseline.companies)
  return { legacyColumnsUnchanged: true, newRoleArraysEmpty: true, maintenanceTablesEmpty: true, structureVerified: true, roleTables: roleSchemas.length }
}
