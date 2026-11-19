import { snapshotDigest } from './migration-approval.mjs'
import { inspectCompanyData } from './check-company-schemas.mjs'
import { companySchema, companyIntegrity, identifier, qualified, sameSnapshot, uuidPattern, readCutover } from './company-data-model.mjs'
import { fingerprintTables } from './recovery-snapshot.mjs'
import { assertStructureContract } from '../packages/database-readiness/structure-contract.js'

export const repairFields = Object.freeze(Object.fromEntries(Object.entries({
  interview_live_sessions: ['corrected_transcript_version_id', 'summary_report', 'summary_revision', 'updated_at'],
  interview_transcript_postprocess_jobs: ['attempts', 'completed_at', 'updated_at', 'warnings'],
  offer_templates: ['updated_at'],
  offers: ['current_version_id', 'updated_at', 'version'],
  resume_import_batches: ['detached_at', 'detached_job_id', 'detached_job_title', 'job_id', 'updated_at'],
}).map(([table, fields]) => [table, Object.freeze(fields)])))
export const repairKeys = Object.freeze(Object.fromEntries(Object.keys(repairFields).map(table => [table,table === 'interview_transcript_postprocess_jobs' ? 'session_id' : 'id'])))
const hashPattern = /^[a-f0-9]{64}$/
const fail = code => { throw new Error(code) }
const hashSql = row => "encode(sha256(convert_to(" + row + "::text,'UTF8')),'hex')"
const byKey = (a, b) => (a.table + a.id).localeCompare(b.table + b.id, 'en')
const digestPlan = plan => snapshotDigest({ format: plan.format, createdAt: plan.createdAt, snapshot: plan.snapshot, context: plan.context })
const evidenceNames = ['writersDrained', 'backupRestored', 'objectsReviewed', 'configReviewed', 'rehearsalPassed']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => object(value) && sameSnapshot(Object.keys(value).sort(), [...keys].sort())
const persistedKey = row => row.schema + '.' + row.name
const remainingEntries = company => company.differences.flatMap(table => table.entries.map(row => ({ table: table.table, keys: table.primaryKeyColumns, ...row }))).sort((a,b) => (a.table + JSON.stringify(a.primaryKey)).localeCompare(b.table + JSON.stringify(b.primaryKey), 'en'))
export function classifyRepairRemainder(company, approvedEntries) {
  const preservedTimestamps = [], remaining = []
  for (const row of remainingEntries(company)) {
    const approved = approvedEntries.find(entry => entry.table === row.table && sameSnapshot(row.keys, [entry.key]) && sameSnapshot(row.primaryKey, [entry.id]))
    // GREATEST may intentionally retain a newer company timestamp rather than make both rows identical.
    if (approved && row.kind === 'conflict' && row.legacyHash === approved.legacyHash && row.companyHash === approved.expectedHash && sameSnapshot(row.changedFields, ['updated_at'])) preservedTimestamps.push(row)
    else remaining.push(row)
  }
  return { remaining, preservedTimestamps }
}
function validateRemaining(rows) {
  if (!Array.isArray(rows)) fail('REPAIR_REMAINING_INVALID')
  const keys = new Set()
  for (const row of rows) {
    const key = row?.table + ':' + JSON.stringify(row?.primaryKey)
    if (!object(row) || keys.has(key) || !sameSnapshot(row.keys, ['id']) || !Array.isArray(row.primaryKey) || row.primaryKey.length !== 1 || !uuidPattern.test(row.primaryKey[0] || '') ||
      (row.kind === 'company-only' ? !['jobs','job_spec_versions','job_description_versions'].includes(row.table) || row.legacyHash !== null || !hashPattern.test(row.companyHash || '') :
        row.kind !== 'legacy-only' || row.table !== 'workflow_events' || row.companyHash !== null || !hashPattern.test(row.legacyHash || ''))) fail('REPAIR_REMAINING_INVALID')
    keys.add(key)
  }
}

export function validateConflictPlan(plan, now = new Date()) {
  if (!exactKeys(plan, ['format','createdAt','snapshot','context','approval','snapshotSha256']) || plan.format !== 'company-five-decisions/v1' || !object(plan.snapshot) || !object(plan.context) || !hashPattern.test(plan.context.backupSha256 || '') || plan.snapshotSha256 !== digestPlan(plan)) fail('REPAIR_PLAN_CHANGED')
  const s = plan.snapshot
  if (!uuidPattern.test(s.organizationId || '') || !exactKeys(s, ['organizationId','schema','identity','ledger','entries','dependencies','correctedVersionId','offerContentVersion','tables','expectedTables','remaining']) ||
      s.schema !== companySchema(s.organizationId) || !exactKeys(s.identity, ['database','databaseOid','serverAddress','serverPort']) || typeof s.identity.database !== 'string' || !s.identity.database || !/^\d+$/.test(s.identity.databaseOid || '') ||
      typeof s.identity.serverAddress !== 'string' || !s.identity.serverAddress || !Number.isInteger(s.identity.serverPort) || s.identity.serverPort < 1 || s.identity.serverPort > 65535 ||
      !Array.isArray(s.entries) || s.entries.some(row => !object(row)) || !sameSnapshot(s.entries.map(row => row.table).sort(), Object.keys(repairFields).sort()) ||
      !uuidPattern.test(s.correctedVersionId || '') || !Number.isSafeInteger(s.offerContentVersion) || s.offerContentVersion < 1 || !Array.isArray(s.ledger) || !s.ledger.length ||
      s.ledger.some(row => !exactKeys(row, ['version','name']) || typeof row.version !== 'string' || typeof row.name !== 'string')) fail('REPAIR_PLAN_INVALID')
  for (const row of s.entries) {
    if (!exactKeys(row, ['table','key','id','fields','legacyHash','companyHash','expectedHash']) || row.key !== repairKeys[row.table] || !uuidPattern.test(row.id || '') || !sameSnapshot(row.fields, repairFields[row.table]) ||
        !hashPattern.test(row.legacyHash || '') || !hashPattern.test(row.companyHash || '') || !hashPattern.test(row.expectedHash || '')) fail('REPAIR_ENTRY_INVALID')
  }
  if (!Array.isArray(s.dependencies) || !s.dependencies.length) fail('REPAIR_DEPENDENCIES_INVALID')
  const dependencyKeys = new Set()
  for (const row of s.dependencies) {
    const key = row?.table + ':' + row?.id
    if (!exactKeys(row, ['table','id','sourceHash','targetHash']) || dependencyKeys.has(key) || !['offer_versions', 'interview_transcript_versions'].includes(row.table) || !uuidPattern.test(row.id || '') ||
        !hashPattern.test(row.sourceHash || '') || (row.targetHash !== null && row.targetHash !== row.sourceHash)) fail('REPAIR_DEPENDENCIES_INVALID')
    dependencyKeys.add(key)
  }
  if (s.dependencies.filter(row => row.table === 'offer_versions').length !== s.offerContentVersion || s.dependencies.filter(row => row.table === 'interview_transcript_versions').length !== 1 ||
      !dependencyKeys.has('interview_transcript_versions:' + s.correctedVersionId)) fail('REPAIR_DEPENDENCIES_INVALID')
  for (const tables of [s.tables,s.expectedTables]) {
    if (!Array.isArray(tables) || !tables.length) fail('REPAIR_TABLES_INVALID')
    const seen = new Set()
    for (const row of tables) {
      if (!exactKeys(row, ['schema','name','kind','rows','sha256']) || typeof row.schema !== 'string' || typeof row.name !== 'string' || typeof row.rows !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(row.schema) || !/^[a-z_][a-z0-9_]*$/.test(row.name) || row.kind !== 'r' || !/^(0|[1-9]\d*)$/.test(row.rows) || !hashPattern.test(row.sha256 || '') || seen.has(persistedKey(row))) fail('REPAIR_TABLES_INVALID')
      seen.add(persistedKey(row))
    }
  }
  if (!sameSnapshot(s.tables.map(persistedKey),s.expectedTables.map(persistedKey))) fail('REPAIR_TABLES_INVALID')
  for (let index = 0; index < s.tables.length; index++) {
    const before = s.tables[index], after = s.expectedTables[index]
    const entry = before.schema === s.schema && s.entries.some(row => row.table === before.name)
    const additions = before.schema === s.schema ? s.dependencies.filter(row => row.table === before.name && row.targetHash === null).length : 0
    if ((!entry && !additions && !sameSnapshot(before,after)) || BigInt(after.rows) !== BigInt(before.rows) + BigInt(additions)) fail('REPAIR_TABLES_INVALID')
  }
  for (const name of [...Object.keys(repairFields),'offer_versions','interview_transcript_versions']) if (!s.tables.some(row => row.schema === s.schema && row.name === name)) fail('REPAIR_TABLES_INVALID')
  validateRemaining(s.remaining)
  const a = plan.approval
  if (!exactKeys(a, ['reviewedBy','snapshotSha256','approvedAt','expiresAt','evidenceReferences']) || typeof a.reviewedBy !== 'string' || !a.reviewedBy.trim() || a.snapshotSha256 !== plan.snapshotSha256) fail('REPAIR_APPROVAL_REQUIRED')
  const created = Date.parse(plan.createdAt), start = Date.parse(a.approvedAt), end = Date.parse(a.expiresAt), time = now.getTime()
  if (![created, start, end, time].every(Number.isFinite) || created > start || start > time || end <= time || end <= start || end - start > 4 * 60 * 60 * 1000) fail('REPAIR_APPROVAL_WINDOW_INVALID')
  if (!exactKeys(a.evidenceReferences,evidenceNames)) fail('REPAIR_EVIDENCE_REQUIRED')
  for (const name of evidenceNames) if (typeof a.evidenceReferences[name] !== 'string' || a.evidenceReferences[name].trim().length < 5) fail('REPAIR_EVIDENCE_REQUIRED')
  return s
}

async function configure(client) {
  await client.query("SET LOCAL search_path=pg_catalog,public")
  await client.query("SET LOCAL timezone='UTC'")
  await client.query("SET LOCAL statement_timeout='60s'")
  await client.query("SET LOCAL lock_timeout='5s'")
  await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'")
}

function bounded(client) {
  const deadline = Date.now() + 10 * 60 * 1000
  return { query(sql, values) { if (sql !== 'ROLLBACK' && Date.now() > deadline) fail('REPAIR_DEADLINE'); return client.query(sql, values) }, release: broken => client.release(broken) }
}

async function rowHash(client, schema, table, id, key = 'id') {
  return (await client.query('SELECT ' + hashSql('to_jsonb(t)') + ' AS hash FROM ' + qualified(schema, table) + ' t WHERE ' + identifier(key) + '=$1', [id])).rows[0]?.hash || null
}

function correctedJson(table) {
  return 'to_jsonb(c)||jsonb_build_object(' + repairFields[table].map(field => "'" + field + "'," + (field === 'updated_at' ? 'GREATEST(c.updated_at,s.updated_at)' : 's.' + identifier(field))).join(',') + ')'
}

async function jsonFingerprint(client, selection, values) {
  return (await client.query("SELECT count(*)::text AS rows," + hashSql("COALESCE(string_agg(digest,'' ORDER BY digest),'')") + ' AS sha256 FROM (SELECT ' + hashSql('row') + ' AS digest FROM (' + selection + ') selected) hashes', values)).rows[0]
}

async function captureRepairSnapshot(client, organizationId, contract) {
  const schema = companySchema(organizationId)
  if (!contract?.control) fail('REPAIR_MIGRATION_0104_REQUIRED')
  await assertStructureContract(client, contract, [{ organization_id: organizationId, schema_name: schema }])
  if (await readCutover(client, organizationId)) fail('REPAIR_ALREADY_CUT_OVER')
  const audit = await inspectCompanyData(client, { organizationId, compareLegacy: true, includeEntries: true })
  const company = audit.companies[0]
  if (!company || company.status !== 'ready' || !company.structure_ready || !company.validName || company.differences.some(row => row.code)) fail('REPAIR_COMPANY_NOT_READY')
  const conflicts = company.differences.flatMap(table => table.entries.filter(row => row.kind === 'conflict').map(row => ({ table: table.table, keys: table.primaryKeyColumns, ...row })))
  if (!sameSnapshot(conflicts.map(row => row.table).sort(), Object.keys(repairFields).sort())) fail('REPAIR_CONFLICT_SCOPE_CHANGED')
  const entries = []
  for (const row of conflicts) {
    if (!sameSnapshot(row.keys, [repairKeys[row.table]]) || row.primaryKey.length !== 1 || !uuidPattern.test(row.primaryKey[0]) ||
        !sameSnapshot([...row.changedFields].sort(), [...repairFields[row.table]].sort())) fail('REPAIR_CONFLICT_FIELDS_CHANGED')
    const id = row.primaryKey[0], key = repairKeys[row.table]
    const expected = (await client.query('SELECT ' + hashSql('(' + correctedJson(row.table) + ')') + ' AS hash FROM ' + qualified(schema, row.table) + ' c JOIN ' + qualified('public', row.table) + ' s USING(' + identifier(key) + ') WHERE c.' + identifier(key) + '=$1', [id])).rows[0]?.hash
    if (!expected) fail('REPAIR_ROW_MISSING')
    entries.push({ table: row.table, key, id, fields: repairFields[row.table], legacyHash: row.legacyHash, companyHash: row.companyHash, expectedHash: expected })
  }
  entries.sort(byKey)
  const session = entries.find(row => row.table === 'interview_live_sessions'), offer = entries.find(row => row.table === 'offers')
  const corrected = (await client.query("SELECT v.id FROM public.interview_live_sessions s JOIN public.interview_transcript_versions v ON v.id=s.corrected_transcript_version_id AND v.session_id=s.id WHERE s.id=$1 AND s.status='completed' AND s.summary_report IS NOT NULL AND s.manual_transcript_roles='[]'::jsonb", [session.id])).rows[0]?.id
  if (!corrected) fail('REPAIR_CORRECTED_SOURCE_INVALID')
  const versions = (await client.query('SELECT id,version FROM public.offer_versions WHERE offer_id=$1 ORDER BY version', [offer.id])).rows
  if (!versions.length || versions.some((row, index) => row.version !== index + 1)) fail('REPAIR_OFFER_HISTORY_INVALID')
  const currentOffer = (await client.query('SELECT current_version_id FROM public.offers WHERE id=$1', [offer.id])).rows[0]
  if (currentOffer?.current_version_id !== versions.at(-1).id) fail('REPAIR_OFFER_CURRENT_NOT_LATEST')
  const targetVersions = (await client.query('SELECT id FROM ' + qualified(schema, 'offer_versions') + ' WHERE offer_id=$1', [offer.id])).rows
  if (targetVersions.some(row => !versions.some(source => source.id === row.id))) fail('REPAIR_OFFER_TARGET_HISTORY_DIVERGED')
  const candidates = [{ table: 'interview_transcript_versions', id: corrected }, ...versions.map(row => ({ table: 'offer_versions', id: row.id }))]
  const dependencies = []
  for (const row of candidates) {
    const sourceHash = await rowHash(client, 'public', row.table, row.id), targetHash = await rowHash(client, schema, row.table, row.id)
    if (!sourceHash || (targetHash !== null && targetHash !== sourceHash)) fail('REPAIR_IMMUTABLE_DEPENDENCY_CONFLICT')
    dependencies.push({ ...row, sourceHash, targetHash })
  }
  dependencies.sort(byKey)
  const remaining = remainingEntries(company).filter(row => row.kind !== 'conflict' && !dependencies.some(dependency => dependency.targetHash === null && row.kind === 'legacy-only' && row.table === dependency.table && row.primaryKey?.[0] === dependency.id))
  validateRemaining(remaining)
  const tables = await fingerprintTables(client)
  if (tables.some(row => row.kind !== 'r')) fail('REPAIR_TABLE_KIND_UNSUPPORTED')
  const expectedTables = structuredClone(tables)
  for (const table of expectedTables.filter(row => row.schema === schema)) {
    const entry = entries.find(row => row.table === table.name)
    const additions = dependencies.filter(row => row.table === table.name && row.targetHash === null)
    if (entry) Object.assign(table, await jsonFingerprint(client, 'SELECT CASE WHEN c.' + identifier(entry.key) + '=$1::uuid THEN ' + correctedJson(table.name) + ' ELSE to_jsonb(c) END AS row FROM ' + qualified(schema, table.name) + ' c LEFT JOIN ' + qualified('public', table.name) + ' s USING(' + identifier(entry.key) + ')', [entry.id]))
    else if (additions.length) Object.assign(table, await jsonFingerprint(client, 'SELECT to_jsonb(c) AS row FROM ' + qualified(schema, table.name) + ' c UNION ALL SELECT to_jsonb(s) AS row FROM ' + qualified('public', table.name) + ' s WHERE s.id=ANY($1::uuid[])', [additions.map(row => row.id)]))
  }
  const identity = (await client.query('SELECT current_database() AS database,d.oid::text AS "databaseOid",host(inet_server_addr()) AS "serverAddress",inet_server_port() AS "serverPort" FROM pg_database d WHERE d.datname=current_database()')).rows[0]
  return { organizationId, schema, identity, ledger: (await client.query('SELECT version,name FROM public.schema_migrations ORDER BY version')).rows,
    entries, dependencies, correctedVersionId: corrected, offerContentVersion: versions.at(-1).version, tables, expectedTables, remaining }
}

export async function buildConflictPlan(pool, { organizationId, context, contract }, now = new Date()) {
  const client = bounded(await pool.connect())
  let broken = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await configure(client)
    const snapshot = await captureRepairSnapshot(client, organizationId, contract)
    const plan = { format: 'company-five-decisions/v1', createdAt: now.toISOString(), snapshot, context, approval: null }
    plan.snapshotSha256 = digestPlan(plan)
    await client.query('COMMIT')
    return plan
  } catch (error) { try { await client.query('ROLLBACK') } catch { broken = true } throw error }
  finally { client.release(broken) }
}

export async function executeConflictPlan(pool, plan, { apply = false, clock = () => new Date(), contract } = {}) {
  const approved = validateConflictPlan(plan, clock()), client = bounded(await pool.connect())
  let broken = false
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await configure(client)
    if (apply) {
      for (const lock of ['smartrecruit:migrations', 'smartrecruit:company-data-maintenance'])
        if (!(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [lock])).rows[0].locked) fail('REPAIR_MAINTENANCE_BUSY')
      const inventory = (await client.query("SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%' AND c.relkind IN ('r','p','m') AND c.relispopulated ORDER BY n.nspname,c.relname")).rows
      if (!sameSnapshot(inventory, approved.tables.map(({ schema, name, kind }) => ({ schema, name, kind })))) fail('REPAIR_TABLE_INVENTORY_CHANGED')
      // The plan hashes every persisted table, so its write-blocking maintenance scope is database-wide.
      await client.query('LOCK TABLE ' + inventory.map(row => qualified(row.schema, row.name)).sort().join(',') + ' IN SHARE ROW EXCLUSIVE MODE')
    }
    if ((await client.query('SELECT 1 FROM recovery_control.maintenance_receipts WHERE plan_sha256=$1', [plan.snapshotSha256])).rowCount) fail('REPAIR_ALREADY_RECORDED')
    if (!sameSnapshot(await captureRepairSnapshot(client, approved.organizationId, contract), approved)) fail('REPAIR_SNAPSHOT_CHANGED')
    validateConflictPlan(plan, clock())
    if (!apply) { await client.query('COMMIT'); return { approvedSnapshotMatches: true, readOnly: true, businessRecoveryVerified: false } }
    for (const row of approved.dependencies.filter(row => row.targetHash === null)) {
      const result = await client.query('INSERT INTO ' + qualified(approved.schema, row.table) + ' SELECT * FROM ' + qualified('public', row.table) + ' WHERE id=$1', [row.id])
      if (result.rowCount !== 1 || await rowHash(client, approved.schema, row.table, row.id) !== row.sourceHash) fail('REPAIR_DEPENDENCY_COPY_FAILED')
    }
    for (const row of approved.entries) {
      await client.query('SET LOCAL search_path=' + identifier(approved.schema) + ',public')
      const relation = qualified(approved.schema, row.table)
      const triggers = (await client.query("SELECT t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal AND n.nspname='public' AND p.proname='set_updated_at'", [relation])).rows
      for (const trigger of triggers) {
        if (trigger.tgname !== row.table + '_set_updated_at' || trigger.tgenabled !== 'O') fail('REPAIR_TIMESTAMP_TRIGGER_CHANGED')
        await client.query('ALTER TABLE ' + relation + ' DISABLE TRIGGER ' + identifier(trigger.tgname))
      }
      const assignments = row.fields.map(field => identifier(field) + '=' + (field === 'updated_at' ? 'GREATEST(c.updated_at,s.updated_at)' : 's.' + identifier(field))).join(',')
      const key = identifier(row.key)
      const changed = await client.query('UPDATE ' + relation + ' c SET ' + assignments + ' FROM ' + qualified('public', row.table) + ' s WHERE c.' + key + '=s.' + key + ' AND c.' + key + '=$1', [row.id])
      if (changed.rowCount !== 1) fail('REPAIR_UPDATE_COUNT')
      for (const trigger of triggers) await client.query('ALTER TABLE ' + relation + ' ENABLE TRIGGER ' + identifier(trigger.tgname))
      if (await rowHash(client, approved.schema, row.table, row.id, row.key) !== row.expectedHash) fail('REPAIR_RESULT_ROW_CHANGED')
    }
    await client.query('SET LOCAL search_path=pg_catalog,public')
    await assertStructureContract(client, contract, [{ organization_id: approved.organizationId, schema_name: approved.schema }])
    if (!sameSnapshot(await fingerprintTables(client), approved.expectedTables)) fail('REPAIR_UNEXPECTED_ROW_CHANGE')
    const businessTables = (await client.query('SELECT unnest(public.organization_business_tables()) AS name')).rows.map(row => row.name)
    if (!(await companyIntegrity(client, approved.organizationId, approved.schema, businessTables)).ready) fail('REPAIR_INTEGRITY_FAILED')
    const audit = await inspectCompanyData(client, { organizationId: approved.organizationId, compareLegacy: true, includeEntries: true })
    const { remaining, preservedTimestamps } = classifyRepairRemainder(audit.companies[0], approved.entries)
    if (!sameSnapshot(remaining,approved.remaining)) fail('REPAIR_REMAINING_REVIEW_REQUIRED')
    validateConflictPlan(plan, clock())
    const result = { operation: 'five-approved-decisions', organizationId: approved.organizationId, planSha256: plan.snapshotSha256, repaired: approved.entries.length,
      dependenciesCopied: approved.dependencies.filter(row => row.targetHash === null).length, offerContentVersion: approved.offerContentVersion,
      remainingDifferences: remaining.length, preservedTimestampDifferences: preservedTimestamps, businessRecoveryVerified: false }
    await client.query("INSERT INTO recovery_control.maintenance_receipts(plan_sha256,organization_id,intent,approved_by,evidence,result) VALUES($1,$2,'reconcile',$3,$4,$5)",
      [plan.snapshotSha256, approved.organizationId, plan.approval.reviewedBy, JSON.stringify(plan.approval.evidenceReferences), JSON.stringify(result)])
    validateConflictPlan(plan, clock())
    await client.query('COMMIT')
    return result
  } catch (error) { try { await client.query('ROLLBACK') } catch { broken = true } throw error }
  finally { client.release(broken) }
}
