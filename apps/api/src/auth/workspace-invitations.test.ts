import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { organizationSchemaName } from '../db/tenant-context.js'
import { normalizeInvitationCode, validateMemberInput, WorkspaceInvitationsService, InvitationError } from './workspace-invitations.js'
const code='ABCDEF123456ABCDEF123456'
test('invitation codes normalize separators but reject arbitrary secrets and short codes',()=>{
  assert.equal(normalizeInvitationCode(' abcdef-123456-abcdef-123456 '),code)
  for(const value of ['', 'admin123', 'G'.repeat(24), null, {code}]) assert.throws(()=>normalizeInvitationCode(value),InvitationError)
})
test('invites cannot grant platform administrator roles or owner membership',()=>{
  for(const businessRole of ['admin','hr_admin','owner','unknown']) assert.throws(()=>validateMemberInput({businessRole}),InvitationError)
  assert.throws(()=>validateMemberInput({membershipRole:'owner'}),InvitationError)
  assert.equal(validateMemberInput({membershipRole:'admin'}).membershipRole,'admin')
  assert.throws(()=>validateMemberInput({expiresInDays:0}),InvitationError)
  assert.throws(()=>validateMemberInput({email:'not-email'}),InvitationError)
  assert.equal(validateMemberInput({businessRole:'hiring_manager'}).businessRole, 'recruiter')
  assert.throws(()=>validateMemberInput({email:''}),InvitationError)
})
function fakePool(responses: Record<string,unknown>[][]) {
  const calls: {sql:string;values:unknown[]}[]=[]
  const db={ async query(sql:string,values:unknown[]=[]) { calls.push({sql,values}); return {rows:responses.shift() ?? []} }, async connect(){return {...db,release(){calls.push({sql:'RELEASE',values:[]})}}} }
  return {db:db as unknown as Pool,calls}
}
const invitation={id:'11111111-1111-4111-8111-111111111111',organization_id:'22222222-2222-4222-8222-222222222222',workspace_name:'企业',workspace_kind:'test',workspace_status:'active',service_available:true,code,email:null,business_role:'recruiter',membership_role:'member',is_shared:true,created_at:new Date(),expires_at:new Date(Date.now()+72*3600000)}
const org={id:invitation.organization_id}
const denied=(code:string)=>(error:unknown)=>error instanceof InvitationError && error.code===code
for (const row of [undefined,{...invitation,is_shared:false},{...invitation,workspace_status:'archived'},{...invitation,service_available:false},{...invitation,revoked_at:new Date()},{...invitation,expires_at:new Date(0)}]) {
  test('unavailable invitation is rejected without writing membership: '+JSON.stringify(row),async()=>{
    const {db,calls}=fakePool([[],row?[row]:[]])
    await assert.rejects(new WorkspaceInvitationsService(db,false).accept(code,'user'),InvitationError)
    assert.ok(calls.some(c=>c.sql==='ROLLBACK'))
    assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO organization_members')))
  })
}
test('public summary discloses only enterprise name and expiry',async()=>{
 const {db}=fakePool([[invitation]])
 const result=await new WorkspaceInvitationsService(db,false).summary(code)
 assert.deepEqual(Object.keys(result).sort(),['expiresAt','shared','workspaceName'])
})
test('all invitation customization is rejected before writes',async()=>{
 for(const input of [{email:''},{membershipRole:'admin'},{departmentId:null},{expiresInDays:3},{businessRole:'recruiter'},{replace:'yes'}]) {
  const {db,calls}=fakePool([])
  await assert.rejects(new WorkspaceInvitationsService(db,false).create(org.id,'owner',input),denied('VALIDATION_ERROR'))
  assert.equal(calls.length,0)
 }
})
test('generation reuses the active shared invite without extending expiry',async()=>{
 const {db,calls}=fakePool([[],[org],[{role:'admin'}],[invitation],[]])
 assert.equal((await new WorkspaceInvitationsService(db,false).create(org.id,'actor',{})).id,invitation.id)
 assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO organization_invitations')))
})
test('generation fixes 72 hour validity and member role, replace revokes old codes',async()=>{
 const {db,calls}=fakePool([[],[org],[{role:'admin'}],[invitation],[],[{id:invitation.id}],[],[invitation],[]])
 await new WorkspaceInvitationsService(db,false).create(org.id,'actor',{replace:true})
 const insert=calls.find(c=>c.sql.includes('INSERT INTO organization_invitations'))!
 assert.match(insert.sql,/interval '72 hours'/)
 assert.match(insert.sql,/NULL,'member','recruiter',NULL/)
 assert.ok(calls.findIndex(c=>c.sql.includes('SET revoked_at'))<calls.indexOf(insert))
 assert.equal(insert.values.length,3)
})
test('joining creates fixed member permissions and leaves shared invitation unconsumed',async()=>{
 for(const userId of ['first','second']) {
  const {db,calls}=fakePool([[],[invitation],[org],[invitation],[{id:userId}],[],[],[],[],[]])
  const result=await new WorkspaceInvitationsService(db,false).accept(code,userId)
  assert.equal(result.alreadyMember,false)
  assert.deepEqual(Object.keys(result).sort(),['alreadyMember','workspaceId','workspaceName'])
  const insert=calls.find(c=>c.sql.includes('INSERT INTO organization_members'))!
  assert.match(insert.sql,/'member','recruiter',NULL/)
  assert.deepEqual(insert.values,[org.id,userId])
  assert.ok(calls.some(c=>c.sql.includes('INSERT INTO organization_invitation_joins')))
  assert.ok(!calls.some(c=>c.sql.includes('SET accepted_at')||c.sql.includes('user_roles')))
  assert.match(calls[2]!.sql,/organizations.*FOR UPDATE/)
  assert.match(calls[3]!.sql,/FOR UPDATE OF i/)
 }
})
test('existing active membership is idempotent and roles never downgraded',async()=>{
 const {db,calls}=fakePool([[],[invitation],[org],[invitation],[{id:'user'}],[{is_active:true}],[]])
 assert.equal((await new WorkspaceInvitationsService(db,false).accept(code,'user')).alreadyMember,true)
 assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO')||c.sql.includes('UPDATE organization_members')))
})
test('disabled membership cannot be reactivated by an invitation',async()=>{
 const {db,calls}=fakePool([[],[invitation],[org],[invitation],[{id:'user'}],[{is_active:false}]])
 await assert.rejects(new WorkspaceInvitationsService(db,false).accept(code,'user'),denied('MEMBERSHIP_DISABLED'))
 assert.ok(calls.some(c=>c.sql==='ROLLBACK'))
})
test('revocation while waiting for organization lock is rechecked',async()=>{
 const {db,calls}=fakePool([[],[invitation],[org],[{...invitation,revoked_at:new Date()}]])
 await assert.rejects(new WorkspaceInvitationsService(db,false).accept(code,'user'),denied('INVITATION_REVOKED'))
 assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO')))
})
test('tenant join audits preserve mirroring before cutover',async()=>{
 const schema=organizationSchemaName(org.id)
 const {db,calls}=fakePool([[],[invitation],[org],[invitation],[{id:'user'}],[],[],[],[{schema_name:schema,status:'ready',structure_ready:true}],[],[]])
 await new WorkspaceInvitationsService(db,true).accept(code,'user')
 const audit=calls.find(c=>c.sql.includes('INSERT INTO public.audit_logs'))!
 assert.ok(audit.sql.includes('INSERT INTO "'+schema+'".audit_logs'))
 assert.ok(audit.sql.includes('read_company_data_cutover($1::uuid) IS NULL'))
 assert.ok(calls.indexOf(audit)<calls.findIndex(c=>c.sql==='COMMIT'))
})
test('missing tenant schema rolls back membership and join record',async()=>{
 const {db,calls}=fakePool([[],[invitation],[org],[invitation],[{id:'user'}],[],[],[],[]])
 await assert.rejects(new WorkspaceInvitationsService(db,true).accept(code,'user'),{code:'WORKSPACE_SCHEMA_UNAVAILABLE'})
 assert.ok(calls.some(c=>c.sql==='ROLLBACK'))
 assert.ok(!calls.some(c=>c.sql==='COMMIT'))
})
test('used shared invitation can still be revoked',async()=>{
 const {db,calls}=fakePool([[],[org],[{role:'admin'}],[{id:invitation.id}],[],[]])
 await new WorkspaceInvitationsService(db,false).revoke(org.id,'actor',invitation.id)
 const update=calls.find(c=>c.sql.startsWith('UPDATE organization_invitations'))!
 assert.ok(!update.sql.includes('accepted_at'))
})
test('ownership transfer preserves one owner and demotes previous owner to admin',async()=>{
 const target='33333333-3333-4333-8333-333333333333'
 const {db,calls}=fakePool([[],[org],[{role:'owner'}],[{user_id:target}],[],[],[],[]])
 await new WorkspaceInvitationsService(db,false).transferOwnership(org.id,'actor',target,{reason:'职责交接'})
 const updates=calls.filter(c=>c.sql.startsWith('UPDATE organization_members'))
 assert.match(updates[0]!.sql,/role='admin'/)
 assert.deepEqual(updates[0]!.values,[org.id,'actor'])
 assert.match(updates[1]!.sql,/role='owner'/)
})
const memberId='33333333-3333-4333-8333-333333333333'
for (const [from,to] of [['member','admin'],['admin','member'],['admin','admin']]) {
  test('owner updates scoped membership from '+from+' to '+to+' without changing global roles',async()=>{
    const {db,calls}=fakePool([[],[],[{role:'owner'}],[{role:from}],[],[],[]])
    await new WorkspaceInvitationsService(db,false).updateMember(invitation.organization_id,'owner',memberId,{membershipRole:to})
    const write=calls.find(call=>call.sql.startsWith('UPDATE organization_members'))!
    assert.deepEqual(write.values,[invitation.organization_id,memberId,to,'recruiter',null])
    const audit=calls.find(call=>call.sql.includes('.audit_logs'))!
    assert.deepEqual(JSON.parse(audit.values[5] as string),{previousRole:from,membershipRole:to,departmentId:null})
    assert.ok(!calls.some(call=>/UPDATE (users|user_roles)|INSERT INTO (user_roles|platform_operators)/.test(call.sql)))
    assert.ok(calls.some(call=>call.sql==='COMMIT'))
  })
}
for (const [actor,target,next] of [['admin','member','admin'],['admin','admin','member'],['owner','owner','member'],['admin','admin','admin']]) {
  test(actor+' cannot change '+target+' membership to '+next,async()=>{
    const {db,calls}=fakePool([[],[],[{role:actor}],[{role:target}]])
    await assert.rejects(new WorkspaceInvitationsService(db,false).updateMember(invitation.organization_id,'actor',memberId,{membershipRole:next}),{code:'FORBIDDEN',status:403})
    assert.ok(calls.some(call=>call.sql==='ROLLBACK'))
    assert.ok(!calls.some(call=>call.sql.startsWith('UPDATE organization_members')))
  })
}
test('sub-administrator can still update ordinary members',async()=>{
  const {db,calls}=fakePool([[],[],[{role:'admin'}],[{role:'member'}],[],[],[]])
  await new WorkspaceInvitationsService(db,false).updateMember(invitation.organization_id,'actor',memberId,{membershipRole:'member'})
  assert.ok(calls.some(call=>call.sql==='COMMIT'))
})
for (const [actor,target,allowed] of [['owner','admin',true],['admin','admin',false],['owner','owner',false],['admin','member',true]] as const) {
  test(actor+' status change on '+target+' allowed: '+allowed,async()=>{
    const {db,calls}=fakePool([[],[],[{role:actor}],[{role:target}],[],[],[]])
    const action=new WorkspaceInvitationsService(db,false).setMemberStatus(invitation.organization_id,'actor',memberId,{isActive:false,reason:'synthetic reason'})
    if(allowed) await action
    else await assert.rejects(action,{code:'FORBIDDEN',status:403})
    assert.equal(calls.some(call=>call.sql.startsWith('UPDATE organization_members')),allowed)
  })
}

test('public summary queries are rate limited before database reads',async()=>{
 const {db,calls}=fakePool(Array.from({length:30},()=>[invitation]))
 const service=new WorkspaceInvitationsService(db,false)
 for(let i=0;i<30;i++)await service.summary(code,'127.0.0.1')
 await assert.rejects(service.summary(code,'127.0.0.1'),denied('INVITATION_RATE_LIMITED'))
 assert.equal(calls.length,30)
})
