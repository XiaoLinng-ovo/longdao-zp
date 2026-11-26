import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { repairFields, repairKeys, validateConflictPlan, buildConflictPlan, executeConflictPlan, classifyRepairRemainder } from '../company-conflict-repair.mjs'
import { parseFiveDecisionArgs } from '../maintenance-five-decisions.mjs'
import { snapshotDigest } from '../migration-approval.mjs'
import { companySchema } from '../company-data-model.mjs'

const now = new Date('2026-11-16T06:00:00Z'), org = '10000000-0000-4000-8000-000000000001'
const id = number => '20000000-0000-4000-8000-' + String(number).padStart(12,'0')
function digest(p) {
  p.snapshotSha256 = snapshotDigest({format:p.format,createdAt:p.createdAt,snapshot:p.snapshot,context:p.context})
  if (p.approval) p.approval.snapshotSha256 = p.snapshotSha256
}
function plan() {
  const schema = companySchema(org)
  const tables = [...Object.keys(repairFields),'offer_versions','interview_transcript_versions'].sort().map(name => ({schema,name,kind:'r',rows:'1',sha256:'b'.repeat(64)}))
  const p = {format:'company-five-decisions/v1',createdAt:now.toISOString(),context:{backupSha256:'a'.repeat(64)},snapshot:{
    organizationId:org,schema,identity:{database:'synthetic',databaseOid:'123',serverAddress:'127.0.0.1',serverPort:55432},ledger:[{version:'0104',name:'0104_company_data_cutover.sql'}],
    entries:Object.entries(repairFields).map(([table,fields],i)=>({table,key:repairKeys[table],id:id(i+1),fields:[...fields],legacyHash:'a'.repeat(64),companyHash:'b'.repeat(64),expectedHash:'c'.repeat(64)})),
    dependencies:[{table:'offer_versions',id:id(10),sourceHash:'a'.repeat(64),targetHash:'a'.repeat(64)},
      {table:'interview_transcript_versions',id:id(11),sourceHash:'b'.repeat(64),targetHash:null}],correctedVersionId:id(11),offerContentVersion:1,
    tables,expectedTables:tables.map(t=>({...t,rows:t.name==='interview_transcript_versions'?'2':t.rows})),remaining:[]},approval:null}
  digest(p)
  p.approval = {reviewedBy:'synthetic-test-only',snapshotSha256:p.snapshotSha256,approvedAt:now.toISOString(),expiresAt:'2026-11-16T07:00:00Z',
    evidenceReferences:Object.fromEntries(['writersDrained','backupRestored','objectsReviewed','configReviewed','rehearsalPassed'].map(name=>[name,'synthetic-only-'+name]))}
  return p
}
test('valid exact five-decision plan validates; exported fields are immutable',()=>{
  assert.equal(validateConflictPlan(plan(),now).organizationId,org)
  assert.throws(()=>repairFields.offers.push('status'),TypeError)
})
const mutations = {
  unapproved:p=>{p.approval=null}, expired:p=>{p.approval.expiresAt=now.toISOString()}, future:p=>{p.approval.approvedAt='2026-11-16T06:30:00Z'},
  'long-window':p=>{p.approval.expiresAt='2026-11-16T11:00:00Z'}, reviewer:p=>{p.approval.reviewedBy=42}, evidence:p=>{delete p.approval.evidenceReferences.writersDrained},
  'extra-approval':p=>{p.approval.force=true}, 'extra-evidence':p=>{p.approval.evidenceReferences.force=true},
  'unknown-plan':p=>{p.force=true}, 'missing-backup':p=>{p.context.backupSha256='';digest(p)},
  'digest-tamper':p=>{p.context.extra='changed'}, 'created-tamper':p=>{p.createdAt='2026-11-16T05:00:00Z'},
  schema:p=>{p.snapshot.schema='public';digest(p)}, organization:p=>{p.snapshot.organizationId='invalid';digest(p)},
  identity:p=>{p.snapshot.identity.serverPort=0;digest(p)}, 'non-array':p=>{p.snapshot.entries={};digest(p)},
  'null-entry':p=>{p.snapshot.entries[0]=null;digest(p)}, 'missing-entry':p=>{p.snapshot.entries.pop();digest(p)},
  'duplicate-entry':p=>{p.snapshot.entries[0]={...p.snapshot.entries[1]};digest(p)},
  'unknown-field':p=>{p.snapshot.entries[0].fields.push('status');digest(p)}, 'extra-entry':p=>{p.snapshot.entries[0].force=true;digest(p)},
  'wrong-primary-key':p=>{p.snapshot.entries.find(row=>row.table==='interview_transcript_postprocess_jobs').key='id';digest(p)},
  'row-hash':p=>{p.snapshot.entries[0].expectedHash='';digest(p)},
  'null-dependency':p=>{p.snapshot.dependencies[0]=null;digest(p)}, 'no-dependencies':p=>{p.snapshot.dependencies=[];digest(p)},
  'duplicate-dependency':p=>{p.snapshot.dependencies.push({...p.snapshot.dependencies[0]});digest(p)},
  'changed-immutable':p=>{p.snapshot.dependencies[0].targetHash='d'.repeat(64);digest(p)},
  'wrong-corrected-id':p=>{p.snapshot.correctedVersionId=id(12);digest(p)}, 'wrong-body-version':p=>{p.snapshot.offerContentVersion=2;digest(p)},
  'extra-table':p=>{p.snapshot.expectedTables.push({...p.snapshot.tables[0],name:'extra'});digest(p)},
  'duplicate-table':p=>{p.snapshot.tables.push({...p.snapshot.tables[0]});digest(p)},
  'invalid-count':p=>{p.snapshot.tables[0].rows='1.1';digest(p)}, 'wrong-count':p=>{p.snapshot.expectedTables[0].rows='3';digest(p)},
  'numeric-count':p=>{p.snapshot.tables[0].rows=1;digest(p)},
  'no-tables':p=>{p.snapshot.tables=[];digest(p)}, 'null-table':p=>{p.snapshot.tables[0]=null;digest(p)},
  'unknown-table-change':p=>{const t={schema:'public',name:'users',kind:'r',rows:'1',sha256:'a'.repeat(64)};p.snapshot.tables.push(t);p.snapshot.expectedTables.push({...t,sha256:'c'.repeat(64)});digest(p)},
  'null-remainder':p=>{p.snapshot.remaining=[null];digest(p)},
  'unknown-remainder':p=>{p.snapshot.remaining=[{table:'offers',keys:['id'],primaryKey:[id(20)],kind:'company-only',legacyHash:null,companyHash:'a'.repeat(64)}];digest(p)},
  'empty-ledger':p=>{p.snapshot.ledger=[];digest(p)},
}
for (const [name,mutate] of Object.entries(mutations)) test('rejects '+name,()=>{const p=plan();mutate(p);assert.throws(()=>validateConflictPlan(p,now),/REPAIR_/)})
test('invalid approval never connects',async()=>{
  const p=plan();p.approval=null
  await assert.rejects(executeConflictPlan({connect(){throw Error('must not connect')}},p,{clock:()=>now}),/REPAIR_APPROVAL_REQUIRED/)
})
test('only exact approved newer timestamp differences are classified as preserved',()=>{
  const approved=plan().snapshot.entries.find(row=>row.table==='offer_templates')
  const row={primaryKey:[approved.id],kind:'conflict',legacyHash:approved.legacyHash,companyHash:approved.expectedHash,changedFields:['updated_at']}
  const classify=(entry,keys=[approved.key])=>classifyRepairRemainder({differences:[{table:approved.table,primaryKeyColumns:keys,entries:[entry]}]},[approved])
  assert.equal(classify(row).preservedTimestamps.length,1)
  assert.equal(classify(row).remaining.length,0)
  for(const changed of [{...row,companyHash:'d'.repeat(64)},{...row,legacyHash:'d'.repeat(64)},{...row,primaryKey:[id(99)]},{...row,kind:'company-only'},{...row,changedFields:['status','updated_at']}]) {
    assert.equal(classify(changed).preservedTimestamps.length,0)
    assert.equal(classify(changed).remaining.length,1)
  }
  assert.equal(classify(row,['other_id']).remaining.length,1)
})
test('transaction failures roll back and release or destroy the connection',async()=>{
  for (const action of ['plan','check','apply']) for (const rollbackFails of [false,true]) {
    const calls=[], released=[]
    const pool={async connect(){return {async query(sql){calls.push(sql);if(sql!=='ROLLBACK'||rollbackFails)throw Error(sql==='ROLLBACK'?'rollback failure':'synthetic query failure');return {rows:[]}},release(broken){released.push(broken)}}}}
    const operation=action==='plan'?buildConflictPlan(pool,{organizationId:org,context:{}}):executeConflictPlan(pool,plan(),{apply:action==='apply',clock:()=>now})
    await assert.rejects(operation,/synthetic query failure/)
    assert.equal(calls.at(-1),'ROLLBACK');assert.deepEqual(released,[rollbackFails])
  }
})
test('CLI requires explicit candidate and exact file hash for check/apply',()=>{
  const args=['--profile',resolve('private/profile.env'),'--plan',resolve('private/plan.json'),'--backup',resolve('private/database.dump'),'--organization',org,'--release',resolve('candidate')]
  assert.equal(parseFiveDecisionArgs(['plan',...args]).action,'plan')
  for(const action of ['check','apply'])assert.equal(parseFiveDecisionArgs([action,...args,'--sha256','a'.repeat(64)]).action,action)
  for(const bad of [['apply',...args],['check',...args],['plan',...args,'--force','yes'],['plan',...args,'--release',resolve('other')],['plan',...args,'--sha256','a'.repeat(64)],['plan',...args.slice(0,-2)],['plan',...args.slice(0,-2),'--release','relative']])assert.throws(()=>parseFiveDecisionArgs(bad),/REPAIR_ARGS/)
})
