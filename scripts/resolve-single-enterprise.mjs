import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const root=resolve(import.meta.dirname,'..'),load=file=>import(pathToFileURL(join(root,'apps/api/dist/src',file+'.js')))
const uuid=value=>typeof value==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
export function validateResolutionPlan(plan) {
 assert.ok(Array.isArray(plan) && plan.length>0,'Plan must be a non-empty array')
 const seen=new Set()
 for(const row of plan) {
  assert.ok(row && Object.keys(row).every(key=>['organizationId','userId','actorId','replacementId','keepOrganizationId','reason'].includes(key)),'Unknown resolution field')
  for(const key of ['organizationId','userId','actorId','replacementId','keepOrganizationId'])assert.ok(uuid(row[key]),'Invalid '+key)
  assert.notEqual(row.organizationId,row.keepOrganizationId,'Cannot end the retained affiliation')
  assert.notEqual(row.userId,row.actorId,'Cannot approve own departure')
  assert.ok(typeof row.reason==='string' && row.reason.trim().length>=2 && row.reason.trim().length<=500,'An explicit reason is required')
  const key=row.organizationId+':'+row.userId;assert.ok(!seen.has(key),'Duplicate action');seen.add(key)
 }
 return plan
}
export async function resolveSingleEnterprise(pool,plan,{apply=false,routeSchemas=true}={}) {
 validateResolutionPlan(plan)
 const ready=(await pool.query("SELECT to_regclass('public.organization_membership_history') AS ready")).rows[0].ready
 assert.ok(ready,'Install additive migration 0113 before resolving conflicts')
 const checks=[]
 for(const row of plan) {
  const bindings=(await pool.query('SELECT organization_id,role FROM public.organization_members WHERE user_id=$1 AND ended_at IS NULL',[row.userId])).rows
  const current=bindings.find(m=>m.organization_id===row.organizationId)
  assert.ok(bindings.some(m=>m.organization_id===row.keepOrganizationId),'Retained affiliation is missing')
  if(!current){checks.push({...row,alreadyEnded:true});continue}
  assert.notEqual(current.role,'owner','Transfer enterprise ownership before resolving this affiliation')
  const actors=(await pool.query('SELECT m.user_id,m.role,m.is_active,u.is_active AS account_active FROM public.organization_members m JOIN public.users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.ended_at IS NULL AND m.user_id=ANY($2::uuid[])',[row.organizationId,[row.actorId,row.replacementId]])).rows
  const actor=actors.find(m=>m.user_id===row.actorId),receiver=actors.find(m=>m.user_id===row.replacementId)
  assert.ok(actor?.is_active && actor.account_active && ['owner','admin'].includes(actor.role),'Approving administrator unavailable')
  assert.ok(actor.role==='owner' || current.role==='member','Only owner can approve administrator departure')
  assert.ok(receiver?.is_active && receiver.account_active && receiver.user_id!==row.userId,'Receiver unavailable')
  checks.push({...row,alreadyEnded:false})
 }
 if(!apply)return {dryRun:true,actions:checks}
 const {WorkspaceOffboardingService}=await load('auth/workspace-offboarding')
 const service=new WorkspaceOffboardingService(pool,routeSchemas),results=[]
 for(const row of checks) {
  if(!row.alreadyEnded)await service.resolve(row.organizationId,row.actorId,row.userId,{reason:row.reason,replacementId:row.replacementId})
  results.push({organizationId:row.organizationId,userId:row.userId,alreadyEnded:row.alreadyEnded})
 }
 return {dryRun:false,actions:results}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const argument=process.argv.indexOf('--plan');assert.ok(argument>=0 && process.argv[argument+1],'Explicit --plan JSON file required')
 const plan=validateResolutionPlan(JSON.parse(await readFile(resolve(process.argv[argument+1]),'utf8')))
 await load('env');const {loadDatabaseConfig}=await load('db/config'),{target,...config}=loadDatabaseConfig()
 const apply=process.argv.includes('--apply')
 if(apply){const expected=process.argv.indexOf('--expect-target');assert.equal(process.argv[expected+1],target,'Explicit --expect-target must match');assert.ok(process.argv.includes('--maintenance-confirmed') && process.argv.includes('--backup-confirmed'),'Maintenance window and verified backup confirmations required')}
 const require=createRequire(join(root,'apps/api/package.json')),{Pool}=require('pg'),pool=new Pool(config)
 try {console.log(JSON.stringify(await resolveSingleEnterprise(pool,plan,{apply,routeSchemas:process.env.TENANT_SCHEMA_ROUTING==='on'}),null,2))}
 finally{await pool.end()}
}
