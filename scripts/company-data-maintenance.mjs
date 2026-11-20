import { snapshotDigest } from './migration-approval.mjs'
import { inspectCompanyData } from './check-company-schemas.mjs'
import { companySchema, companyIntegrity, fingerprintSelection, identifier, legacyBaseline, qualified, readCutover, sameSnapshot, uuidPattern, workflowSubjects } from './company-data-model.mjs'
import { captureStructure, normalizeStructure, assertStructureContract } from '../packages/database-readiness/structure-contract.js'
import { repairKeys } from './company-conflict-repair.mjs'

const hashPattern = /^[a-f0-9]{64}$/
const preservationTables = new Set(['jobs', 'job_spec_versions', 'job_description_versions'])
const requiredEvidence = ['writersDrained', 'backupRestored', 'objectsReviewed', 'configReviewed', 'rehearsalPassed']
const fail = (code, detail = '') => { throw new Error(code + (detail ? ': ' + detail : '')) }
function validTimestampPreservation(row) {
  return row && row.kind === 'conflict' && Object.hasOwn(repairKeys,row.table) && sameSnapshot(row.primaryKeyColumns,[repairKeys[row.table]]) &&
    Array.isArray(row.primaryKey) && row.primaryKey.length === 1 && uuidPattern.test(row.primaryKey[0]) && sameSnapshot(row.changedFields,['updated_at']) &&
    hashPattern.test(row.legacyHash || '') && hashPattern.test(row.companyHash || '') && hashPattern.test(row.priorRepairPlanSha256 || '')
}
export function recognizeTimestampPreservations(entries, receipts, organizationId) {
  const remaining = [], approvedTimestampPreservations = []
  for (const entry of entries) {
    const receipt = receipts.find(record => hashPattern.test(record.plan_sha256 || '') && record.result?.operation === 'five-approved-decisions' &&
      record.result.organizationId === organizationId && record.result.planSha256 === record.plan_sha256 && Array.isArray(record.result.preservedTimestampDifferences) &&
      record.result.preservedTimestampDifferences.some(row => sameSnapshot(row,{table:entry.table,keys:entry.primaryKeyColumns,primaryKey:entry.primaryKey,
        kind:entry.kind,legacyHash:entry.legacyHash,companyHash:entry.companyHash,changedFields:entry.changedFields})))
    const preserved = receipt ? {...entry,priorRepairPlanSha256:receipt.plan_sha256} : null
    if (validTimestampPreservation(preserved)) {
      delete preserved.action
      approvedTimestampPreservations.push(preserved)
    } else remaining.push(entry)
  }
  return { entries:remaining, approvedTimestampPreservations }
}
export function validateCompanyPlan(plan, now = new Date()) {
  if (plan?.format !== 'company-data-maintenance/v1' || !['reconcile', 'seal'].includes(plan.intent) ||
      !plan.snapshot || !plan.context || !hashPattern.test(plan.context.backupSha256 || '') ||
      plan.snapshotSha256 !== snapshotDigest({ intent: plan.intent, snapshot: plan.snapshot, context: plan.context })) fail('DATA_PLAN_CHANGED')
  const s = plan.snapshot
  if (s.schema !== companySchema(s.organizationId) || !s.identity?.database || !/^\d+$/.test(s.identity.databaseOid || '') ||
      !s.identity.serverAddress || !Number.isInteger(s.identity.serverPort) || !Array.isArray(s.entries) || !Array.isArray(s.companyBaseline) ||
      !Array.isArray(s.legacyBaseline) || !Array.isArray(s.expectedCompanyBaseline) || !s.integrity?.ready || s.status !== 'ready' || s.cutover) fail('DATA_PLAN_NOT_READY')
  const keys = new Set()
  if (!Array.isArray(s.approvedTimestampPreservations || [])) fail('DATA_PLAN_ENTRY_INVALID')
  for (const row of s.approvedTimestampPreservations || []) {
    const key = row?.table + ':' + JSON.stringify(row?.primaryKey)
    if (!validTimestampPreservation(row) || keys.has(key)) fail('DATA_PLAN_ENTRY_INVALID')
    keys.add(key)
  }
  for (const entry of s.entries) {
    const key = entry.table + ':' + JSON.stringify(entry.primaryKey)
    if (keys.has(key) || JSON.stringify(entry.primaryKeyColumns) !== '["id"]' || entry.primaryKey?.length !== 1 || !uuidPattern.test(entry.primaryKey[0])) fail('DATA_PLAN_ENTRY_INVALID')
    keys.add(key)
    if (entry.kind === 'company-only' && preservationTables.has(entry.table) && entry.action === 'preserve-company' &&
        hashPattern.test(entry.companyHash || '') && entry.legacyHash === null) continue
    if (plan.intent === 'reconcile' && entry.kind === 'legacy-only' && entry.table === 'workflow_events' &&
        entry.action === 'copy-original-event' && hashPattern.test(entry.legacyHash || '') && entry.companyHash === null && entry.importCheck?.ready) continue
    fail('DATA_PLAN_REVIEW_REQUIRED', entry.table)
  }
  if (plan.intent === 'reconcile' && !s.entries.length) fail('DATA_PLAN_EMPTY')
  const a = plan.approval
  if (!a?.reviewedBy?.trim() || a.snapshotSha256 !== plan.snapshotSha256) fail('DATA_APPROVAL_REQUIRED')
  const created = Date.parse(plan.createdAt), start = Date.parse(a.approvedAt), end = Date.parse(a.expiresAt), time = now.getTime()
  if (![created, start, end, time].every(Number.isFinite) || created > start || start > time || end <= time || end <= start || end - start > 4 * 60 * 60 * 1000) fail('DATA_APPROVAL_WINDOW_INVALID')
  for (const name of [...requiredEvidence, ...(plan.intent === 'seal' ? ['businessSmokePassed', 'dataReconciled'] : [])]) {
    if (typeof a.evidenceReferences?.[name] !== 'string' || a.evidenceReferences[name].trim().length < 5) fail('DATA_EVIDENCE_REQUIRED', name)
  }
  return s
}

async function eventImportCheck(client, org, schema, id) {
  const event = (await client.query('SELECT subject_type,subject_id,actor_user_id,organization_id FROM public.workflow_events WHERE id=$1', [id])).rows[0]
  if (!event || event.organization_id !== org) return { ready: false, code: 'EVENT_OWNER_MISMATCH' }
  const parent = workflowSubjects[event.subject_type]
  if (!parent) return { ready: false, code: 'EVENT_SUBJECT_UNSUPPORTED' }
  if (!(await client.query('SELECT 1 FROM ' + qualified(schema, parent) + ' WHERE id=$1 AND organization_id=$2', [event.subject_id, org])).rowCount) return { ready: false, code: 'EVENT_SUBJECT_MISSING' }
  if (event.actor_user_id && !(await client.query('SELECT 1 FROM public.users WHERE id=$1', [event.actor_user_id])).rowCount) return { ready: false, code: 'EVENT_ACTOR_MISSING' }
  // Only the known, company-no-op legacy guard may run during this historical import.
  const triggers = (await client.query(
    'SELECT t.tgname,n.nspname,p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal',
    [qualified(schema, 'workflow_events')])).rows
  if (triggers.some(t => t.nspname !== 'public' || t.proname !== 'guard_company_legacy_snapshot' || !['company_legacy_snapshot_guard','company_legacy_snapshot_no_truncate'].includes(t.tgname))) return { ready: false, code: 'EVENT_TRIGGER_REVIEW_REQUIRED' }
  if ((await client.query('SELECT 1 FROM pg_rewrite WHERE ev_class=$1::regclass', [qualified(schema, 'workflow_events')])).rowCount) return { ready: false, code: 'EVENT_RULE_REVIEW_REQUIRED' }
  const duplicate = await client.query('SELECT 1 FROM ' + qualified(schema, 'workflow_events') + " t JOIN public.workflow_events s ON s.id=$1 WHERE t.id<>s.id AND to_jsonb(t)-'id'=to_jsonb(s)-'id' LIMIT 1", [id])
  if (duplicate.rowCount) return { ready: false, code: 'EVENT_SEMANTIC_DUPLICATE' }
  const legacyDuplicate = await client.query("SELECT 1 FROM public.workflow_events t JOIN public.workflow_events s ON s.id=$1 WHERE t.organization_id=s.organization_id AND t.id<>s.id AND to_jsonb(t)-'id'=to_jsonb(s)-'id' LIMIT 1", [id])
  if (legacyDuplicate.rowCount) return { ready: false, code: 'EVENT_SEMANTIC_DUPLICATE' }
  return { ready: true, subjectType: event.subject_type }
}

async function eventColumnList(client) {
  const columns = (await client.query("SELECT attname::text AS name FROM pg_attribute WHERE attrelid='public.workflow_events'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows
  if (!columns.length) fail('DATA_EVENT_COLUMNS_MISSING')
  return columns.map(column => identifier(column.name)).join(',')
}

export async function captureCompanySnapshot(client, organizationId, intent) {
  const schema = companySchema(organizationId)
  const report = await inspectCompanyData(client, { compareLegacy: true, includeEntries: true, organizationId, respectCutovers: false })
  const company = report.companies[0]
  if (!company?.validName || !company.structure_ready) fail('DATA_COMPANY_NOT_READY')
  if (!(await client.query("SELECT to_regclass('recovery_control.maintenance_receipts') IS NOT NULL AS installed")).rows[0].installed) fail('DATA_MIGRATION_0104_REQUIRED')
  const tables = (await client.query('SELECT unnest(public.organization_business_tables()) AS name')).rows.map(row => row.name).sort()
  const identity = (await client.query('SELECT current_database() AS database,d.oid::text AS "databaseOid",host(inet_server_addr()) AS "serverAddress",inet_server_port() AS "serverPort" FROM pg_database d WHERE d.datname=current_database()')).rows[0]
  const differences = company.differences.flatMap(table => table.entries.map(entry => ({ table: table.table, primaryKeyColumns: table.primaryKeyColumns, ...entry,
    action: entry.kind === 'company-only' && preservationTables.has(table.table) ? 'preserve-company' : intent === 'reconcile' && entry.kind === 'legacy-only' && table.table === 'workflow_events' ? 'copy-original-event' : null })))
  const receipts = (await client.query("SELECT plan_sha256,result FROM recovery_control.maintenance_receipts WHERE organization_id=$1 AND intent='reconcile' AND result->>'operation'='five-approved-decisions' ORDER BY plan_sha256",[organizationId])).rows
  const { entries, approvedTimestampPreservations } = recognizeTimestampPreservations(differences,receipts,organizationId)
  for (const entry of entries.filter(e => e.action === 'copy-original-event')) entry.importCheck = await eventImportCheck(client, organizationId, schema, entry.primaryKey[0])
  const companyBaseline = [], expectedCompanyBaseline = []
  const imports = entries.filter(e => e.action === 'copy-original-event').map(e => e.primaryKey[0])
  const eventColumns = imports.length ? await eventColumnList(client) : null
  for (const table of tables) {
    const selection = 'SELECT * FROM ' + qualified(schema, table)
    const current = { table, ...await fingerprintSelection(client, selection) }
    companyBaseline.push(current)
    expectedCompanyBaseline.push(table === 'workflow_events' && imports.length ? { table, ...await fingerprintSelection(client, 'SELECT ' + eventColumns + ' FROM ' + qualified(schema, table) + ' UNION ALL SELECT ' + eventColumns + ' FROM public.workflow_events WHERE id=ANY($1::uuid[])', [imports]) } : current)
  }
  const structure = await captureStructure(client, ['public', schema, 'recovery_control'])
  return { identity, organizationId, schema, status: company.status, cutover: await readCutover(client, organizationId), tables,
    ledger: (await client.query('SELECT version,name FROM public.schema_migrations ORDER BY version')).rows,
    structureSha256: snapshotDigest({ public: normalizeStructure(structure, 'public'), company: normalizeStructure(structure, schema, organizationId), control: normalizeStructure(structure, 'recovery_control') }),
    legacyBaseline: await legacyBaseline(client, organizationId, tables), companyBaseline, expectedCompanyBaseline,
    integrity: await companyIntegrity(client, organizationId, schema, tables), entries, approvedTimestampPreservations }
}

export async function buildCompanyPlan(pool, { organizationId, intent = 'reconcile', context, contract }, now = new Date()) {
  if (!['reconcile','seal'].includes(intent)) fail('DATA_INTENT_INVALID')
  const client = boundedClient(await pool.connect())
  let broken = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await configure(client)
    if (!contract?.control) fail('DATA_CONTROL_CONTRACT_REQUIRED')
    await assertStructureContract(client, contract, [{ organization_id: organizationId, schema_name: companySchema(organizationId) }])
    const snapshot = await captureCompanySnapshot(client, organizationId, intent)
    const plan = { format: 'company-data-maintenance/v1', createdAt: now.toISOString(), intent, context, snapshot,
      snapshotSha256: snapshotDigest({ intent, snapshot, context }), approval: null }
    await client.query('COMMIT')
    return plan
  } catch (error) { try { await client.query('ROLLBACK') } catch { broken = true } throw error }
  finally { client.release(broken) }
}

async function configure(client) {
  await client.query("SET LOCAL timezone='UTC'")
  await client.query("SET LOCAL search_path=pg_catalog,public")
  await client.query("SET LOCAL statement_timeout='60s'")
  await client.query("SET LOCAL lock_timeout='5s'")
  await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'")
}

function boundedClient(client) {
  const deadline = Date.now() + 10 * 60 * 1000
  return {
    query(sql, values) {
      if (Date.now() > deadline && sql !== 'ROLLBACK') fail('DATA_MAINTENANCE_DEADLINE')
      return client.query(sql, values)
    },
    release: broken => client.release(broken),
  }
}

export async function executeCompanyPlan(pool, plan, { apply = false, clock = () => new Date(), contract } = {}) {
  const approved = validateCompanyPlan(plan, clock())
  const client = boundedClient(await pool.connect())
  let broken = false
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await configure(client)
    if (apply) {
      for (const lock of ['smartrecruit:migrations', 'smartrecruit:company-data-maintenance']) {
        if (!(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [lock])).rows[0].locked) fail('DATA_MAINTENANCE_BUSY')
      }
      const actualTables = (await client.query('SELECT unnest(public.organization_business_tables()) AS name')).rows.map(row => row.name).sort()
      if (!sameSnapshot(actualTables, approved.tables)) fail('DATA_TABLE_INVENTORY_CHANGED')
      const relations = [...actualTables.flatMap(table => [qualified('public', table), qualified(approved.schema, table)]),
        ...['organizations','organization_schemas','users','organization_members','departments','schema_migrations'].map(table => qualified('public', table)),
        qualified('recovery_control', 'maintenance_receipts'), qualified('recovery_control', 'company_data_cutovers')].sort()
      // Acquire write-blocking locks before observing a READ COMMITTED snapshot; never approve stale pre-lock reads.
      await client.query('LOCK TABLE ' + relations.join(',') + ' IN SHARE ROW EXCLUSIVE MODE')
    }
    if (!contract?.control) fail('DATA_CONTROL_CONTRACT_REQUIRED')
    await assertStructureContract(client, contract, [{ organization_id: approved.organizationId, schema_name: approved.schema }])
    const actual = await captureCompanySnapshot(client, approved.organizationId, plan.intent)
    const receipt = (await client.query('SELECT result FROM recovery_control.maintenance_receipts WHERE plan_sha256=$1', [plan.snapshotSha256])).rows[0]
    if (receipt) {
      for (const field of ['identity','ledger','structureSha256','legacyBaseline']) if (!sameSnapshot(actual[field], approved[field])) fail('DATA_APPLIED_STATE_CHANGED', field)
      if (!sameSnapshot(actual.companyBaseline, approved.expectedCompanyBaseline)) fail('DATA_APPLIED_STATE_CHANGED', 'companyBaseline')
      if (!actual.integrity.ready || (plan.intent === 'seal' ? actual.cutover?.planSha256 !== plan.snapshotSha256 : actual.cutover !== null)) fail('DATA_APPLIED_STATE_CHANGED', 'cutover/integrity')
      validateCompanyPlan(plan, clock())
      await client.query('COMMIT')
      return { ...receipt.result, alreadyApplied: true, readOnly: true }
    }
    if (!sameSnapshot(actual, approved)) fail('DATA_SNAPSHOT_CHANGED', 'Regenerate and review; no records were changed')
    if (!apply) {
      await client.query('COMMIT')
      return { approvedSnapshotMatches: true, readOnly: true, businessRecoveryVerified: false }
    }
    let copied = 0
    const eventColumns = approved.entries.some(e => e.action === 'copy-original-event') ? await eventColumnList(client) : null
    for (const entry of approved.entries.filter(e => e.action === 'copy-original-event')) {
      // INSERT ... SELECT preserves original timestamp precision, UUIDs and JSON without JS round trips.
      const result = await client.query('INSERT INTO ' + qualified(approved.schema, 'workflow_events') + '(' + eventColumns + ') SELECT ' + eventColumns + ' FROM public.workflow_events WHERE id=$1 AND organization_id=$2', [entry.primaryKey[0], approved.organizationId])
      if (result.rowCount !== 1) fail('DATA_EVENT_COPY_COUNT')
      copied++
    }
    const after = await captureCompanySnapshot(client, approved.organizationId, plan.intent)
    if (!sameSnapshot(after.companyBaseline, approved.expectedCompanyBaseline) || !sameSnapshot(after.legacyBaseline, approved.legacyBaseline) || !after.integrity.ready) fail('DATA_POSTCHECK_FAILED')
    const result = { organizationId: approved.organizationId, intent: plan.intent, planSha256: plan.snapshotSha256, copied,
      preserved: approved.entries.filter(e => e.action === 'preserve-company').length,
      preservedApprovedTimestamps: (approved.approvedTimestampPreservations || []).length, businessRecoveryVerified: false }
    if (plan.intent === 'seal') result.companyAuthoritative = true
    validateCompanyPlan(plan, clock())
    await client.query('INSERT INTO recovery_control.maintenance_receipts(plan_sha256,organization_id,intent,approved_by,evidence,result) VALUES($1,$2,$3,$4,$5,$6)',
      [plan.snapshotSha256, approved.organizationId, plan.intent, plan.approval.reviewedBy, JSON.stringify(plan.approval.evidenceReferences), JSON.stringify(result)])
    if (plan.intent === 'seal') {
      await client.query('INSERT INTO recovery_control.company_data_cutovers(organization_id,schema_name,plan_sha256,legacy_baseline) VALUES($1,$2,$3,$4)',
        [approved.organizationId, approved.schema, plan.snapshotSha256, JSON.stringify(approved.legacyBaseline)])
    }
    validateCompanyPlan(plan, clock())
    await client.query('COMMIT')
    return result
  } catch (error) { try { await client.query('ROLLBACK') } catch { broken = true } throw error }
  finally { client.release(broken) }
}
