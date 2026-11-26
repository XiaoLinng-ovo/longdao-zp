import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { validateCompanyPlan, executeCompanyPlan, buildCompanyPlan, recognizeTimestampPreservations } from '../company-data-maintenance.mjs'
import { parseCompanyMaintenanceArgs } from '../maintenance-company-data.mjs'
import { companySchema } from '../company-data-model.mjs'
import { snapshotDigest } from '../migration-approval.mjs'

const now = new Date('2026-11-16T06:00:00Z'), org = '10000000-0000-4000-8000-000000000001'
function plan() {
  const p = { format: 'company-data-maintenance/v1', createdAt: now.toISOString(), intent: 'reconcile', context: { backupSha256: 'a'.repeat(64) },
    snapshot: { organizationId: org, schema: companySchema(org), identity: { database: 'synthetic', databaseOid: '123', serverAddress: '127.0.0.1', serverPort: 55432 },
      status: 'ready', cutover: null, integrity: { ready: true }, legacyBaseline: [], companyBaseline: [], expectedCompanyBaseline: [],
      entries: [{ table: 'jobs', primaryKeyColumns: ['id'], primaryKey: [org], kind: 'company-only', action: 'preserve-company', companyHash: 'b'.repeat(64), legacyHash: null }] } }
  digest(p)
  p.approval = { reviewedBy: 'synthetic-reviewer', snapshotSha256: p.snapshotSha256, approvedAt: now.toISOString(), expiresAt: '2026-11-16T07:00:00Z',
    evidenceReferences: Object.fromEntries(['writersDrained','backupRestored','objectsReviewed','configReviewed','rehearsalPassed'].map(name => [name, 'synthetic-' + name])) }
  return p
}
function digest(p) { p.snapshotSha256 = snapshotDigest({ intent: p.intent, snapshot: p.snapshot, context: p.context }); if (p.approval) p.approval.snapshotSha256 = p.snapshotSha256 }
test('reviewed preservation plan validates with numeric database OID', () => assert.equal(validateCompanyPlan(plan(), now).organizationId, org))
for (const mutation of ['unapproved','expired','future','long-window','tampered','backup','reviewer','evidence','conflict','unknown-table','duplicate','unsafe-import','seal-event','seal-evidence','schema']) {
  test('rejects ' + mutation, () => {
    const p = plan(), e = p.snapshot.entries[0]
    if (mutation === 'unapproved') p.approval = null
    if (mutation === 'expired') p.approval.expiresAt = now.toISOString()
    if (mutation === 'future') p.approval.approvedAt = '2026-11-16T06:30:00Z'
    if (mutation === 'long-window') p.approval.expiresAt = '2026-11-16T11:00:00Z'
    if (mutation === 'tampered') p.context.release = 'changed'
    if (mutation === 'backup') { p.context.backupSha256 = ''; digest(p) }
    if (mutation === 'reviewer') p.approval.reviewedBy = ''
    if (mutation === 'evidence') delete p.approval.evidenceReferences.writersDrained
    if (mutation === 'conflict') { e.kind = 'conflict'; digest(p) }
    if (mutation === 'unknown-table') { e.table = 'candidates'; digest(p) }
    if (mutation === 'duplicate') { p.snapshot.entries.push({ ...e }); digest(p) }
    if (mutation === 'unsafe-import' || mutation === 'seal-event') {
      Object.assign(e, { table: 'workflow_events', kind: 'legacy-only', action: 'copy-original-event', legacyHash: 'a'.repeat(64), companyHash: null, importCheck: { ready: mutation === 'seal-event' } })
      if (mutation === 'seal-event') p.intent = 'seal'
      digest(p)
    }
    if (mutation === 'seal-evidence') { p.intent = 'seal'; digest(p) }
    if (mutation === 'schema') { p.snapshot.schema = 'public'; digest(p) }
    assert.throws(() => validateCompanyPlan(p, now), /DATA_/)
  })
}
test('invalid approval never obtains a database connection', async () => {
  const p = plan(); p.approval = null
  await assert.rejects(executeCompanyPlan({ connect() { throw Error('must not connect') } }, p, { clock: () => now }), /DATA_APPROVAL_REQUIRED/)
})
test('later maintenance binds only exact timestamp preservation from the original immutable receipt',()=>{
  const entry={table:'offer_templates',primaryKeyColumns:['id'],primaryKey:[org],kind:'conflict',legacyHash:'a'.repeat(64),companyHash:'b'.repeat(64),changedFields:['updated_at'],action:null}
  const {primaryKeyColumns,action,...fields}=entry
  const record={plan_sha256:'c'.repeat(64),result:{operation:'five-approved-decisions',organizationId:org,planSha256:'c'.repeat(64),preservedTimestampDifferences:[{...fields,keys:primaryKeyColumns}]}}
  const matched=recognizeTimestampPreservations([entry],[record],org)
  assert.equal(matched.entries.length,0);assert.equal(matched.approvedTimestampPreservations[0].priorRepairPlanSha256,record.plan_sha256)
  const p=plan();p.snapshot.approvedTimestampPreservations=matched.approvedTimestampPreservations;digest(p);validateCompanyPlan(p,now)
  for (const row of [{...entry,companyHash:'d'.repeat(64)},{...entry,legacyHash:'d'.repeat(64)},{...entry,changedFields:['status']},{...entry,primaryKey:[org.replace(/1$/,'2')]}]) {
    assert.equal(recognizeTimestampPreservations([row],[record],org).entries.length,1)
  }
  assert.equal(recognizeTimestampPreservations([entry],[],org).entries.length,1)
  assert.equal(recognizeTimestampPreservations([entry],[{...record,result:{...record.result,organizationId:org.replace(/1$/,'2')}}],org).entries.length,1)
  for(const invalid of [null,{...matched.approvedTimestampPreservations[0],changedFields:['status']},{...matched.approvedTimestampPreservations[0],priorRepairPlanSha256:''}]) {
    const invalidPlan=plan();invalidPlan.snapshot.approvedTimestampPreservations=[invalid];digest(invalidPlan)
    assert.throws(()=>validateCompanyPlan(invalidPlan,now),/DATA_PLAN_ENTRY_INVALID/)
  }
})
test('failed rollback destroys maintenance and planning connections', async () => {
  for (const action of ['plan','check','apply']) {
    const released = [], calls = []
    const pool = { async connect() { return {
      async query(sql) { calls.push(sql); throw Error(sql === 'ROLLBACK' ? 'rollback failure' : 'query failure') },
      release(broken) { released.push(broken) },
    } } }
    const operation = action === 'plan' ? buildCompanyPlan(pool,{organizationId:org,context:{}}) : executeCompanyPlan(pool,plan(),{apply:action==='apply',clock:()=>now})
    await assert.rejects(operation,/query failure/)
    assert.equal(calls.at(-1),'ROLLBACK'); assert.deepEqual(released,[true])
  }
})
test('CLI requires explicit absolute scope and reviewed candidate for apply', () => {
  const args = ['--profile',resolve('profile.env'),'--plan',resolve('plan.json'),'--backup',resolve('backup.dump'),'--organization',org,'--intent','reconcile']
  assert.equal(parseCompanyMaintenanceArgs(['plan',...args]).action, 'plan')
  for (const bad of [['apply',...args],['plan',...args,'--profile',resolve('other.env')],['plan',...args,'--force','yes'],['plan',...args,'--release','relative']])
    assert.throws(() => parseCompanyMaintenanceArgs(bad), /DATA_ARGS/)
})
