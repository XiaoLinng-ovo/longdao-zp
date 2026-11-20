import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { organizationSchemaName } from '../db/tenant-context.js'
import { normalizeInvitationCode, validateInvitationInput, WorkspaceInvitationsService, InvitationError } from './workspace-invitations.js'
const code='ABCDEF123456ABCDEF123456'
test('invitation codes normalize separators but reject arbitrary secrets and short codes',()=>{
  assert.equal(normalizeInvitationCode(' abcdef-123456-abcdef-123456 '),code)
  for(const value of ['', 'admin123', 'G'.repeat(24), null, {code}]) assert.throws(()=>normalizeInvitationCode(value),InvitationError)
})
test('invites cannot grant platform administrator roles or owner membership',()=>{
  for(const businessRole of ['admin','hr_admin','owner','unknown']) assert.throws(()=>validateInvitationInput({businessRole}),InvitationError)
  assert.throws(()=>validateInvitationInput({membershipRole:'owner'}),InvitationError)
  assert.equal(validateInvitationInput({membershipRole:'admin'}).membershipRole,'admin')
  assert.throws(()=>validateInvitationInput({expiresInDays:0}),InvitationError)
  assert.throws(()=>validateInvitationInput({email:'not-email'}),InvitationError)
  assert.equal(validateInvitationInput({businessRole:'hiring_manager'}).businessRole, 'recruiter')
  assert.equal(validateInvitationInput({email:' Alice@Example.com '}).email,'alice@example.com')
})
function fakePool(responses: Record<string,unknown>[][]) {
  const calls: {sql:string;values:unknown[]}[]=[]
  const db={ async query(sql:string,values:unknown[]=[]) { calls.push({sql,values}); return {rows:responses.shift() ?? []} }, async connect(){return {...db,release(){calls.push({sql:'RELEASE',values:[]})}}} }
  return {db:db as unknown as Pool,calls}
}
const invitation={id:'11111111-1111-4111-8111-111111111111',organization_id:'22222222-2222-4222-8222-222222222222',workspace_name:'企业',workspace_kind:'test',workspace_status:'active',code,email:null,business_role:'interviewer',membership_role:'member',created_at:new Date(),expires_at:new Date(Date.now()+86400000)}
test('invalid, archived, revoked, used and expired invites are denied before membership writes',async()=>{
  for(const row of [undefined,{...invitation,workspace_status:'archived'},{...invitation,revoked_at:new Date()},{...invitation,accepted_at:new Date()},{...invitation,expires_at:new Date(0)}]) {
    const {db,calls}=fakePool([[],row?[row]:[]])
    await assert.rejects(new WorkspaceInvitationsService(db).accept(code,'user'),InvitationError)
    assert.ok(calls.some(c=>c.sql==='ROLLBACK'));assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO organization_members')))
  }
})
test('email-bound invites deny a different signed-in email',async()=>{
  const {db}=fakePool([[{...invitation,email:'allowed@example.com'}],[{email:'other@example.com'}]])
  await assert.rejects(new WorkspaceInvitationsService(db).preview(code,'user'),e=>e instanceof InvitationError && e.code==='INVITATION_EMAIL_MISMATCH')
})
test('members cannot enumerate enterprise invitations',async()=>{
  const {db}=fakePool([[]])
  await assert.rejects(new WorkspaceInvitationsService(db).list(invitation.organization_id,'user'),e=>e instanceof InvitationError && e.status===403)
})
test('legacy enterprise roles are read as ordinary users without granting platform access', async () => {
  const {db} = fakePool([[{role:'owner'}], ['admin','hr_admin','approver','interviewer'].map(business_role => ({id:business_role,business_role,membership_role:'member'}))])
  const members = await new WorkspaceInvitationsService(db).members(invitation.organization_id,'owner')
  assert.deepEqual(members.map(member => member.businessRole), Array(4).fill('recruiter'))
  assert.ok(members.every(member => !('platformRole' in member)))
})
test('sub-administrators can list only ordinary member invitations, not administrator codes',async()=>{
  const {db,calls}=fakePool([[{role:'admin'}],[]])
  await new WorkspaceInvitationsService(db,false).list(invitation.organization_id,'actor')
  assert.ok(calls[1]!.sql.includes("i.membership_role='member' OR $2='owner'"))
  assert.deepEqual(calls[1]!.values,[invitation.organization_id,'admin'])
})
test('only owners may generate an enterprise administrator invitation',async()=>{
  const {db,calls}=fakePool([[],[{role:'admin'}]])
  await assert.rejects(new WorkspaceInvitationsService(db).create(invitation.organization_id,'user',{membershipRole:'admin'}),InvitationError)
  assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO organization_invitations')))
})
test('duplicate membership rolls back without consuming the invitation',async()=>{
  const {db,calls}=fakePool([[],[invitation],[{email:'test@example.com'}],[{id:invitation.organization_id}],[]])
  await assert.rejects(new WorkspaceInvitationsService(db).accept(code,'user'),e=>e instanceof InvitationError && e.code==='ALREADY_MEMBER')
  assert.ok(calls.some(c=>c.sql==='ROLLBACK'));assert.ok(!calls.some(c=>c.sql.includes('SET accepted_at')))
})
test('accept locks code and atomically creates scoped membership, consumes code and audits',async()=>{
  const schema = organizationSchemaName(invitation.organization_id)
  const {db,calls}=fakePool([[],[invitation],[{email:'test@example.com'}],[{id:invitation.organization_id}],[{organization_id:invitation.organization_id}],[],[{schema_name:schema,status:'ready',structure_ready:true}],[],[]])
  await assert.doesNotReject(new WorkspaceInvitationsService(db, true).accept(code,'user'))
  assert.match(calls[1]!.sql,/FOR UPDATE OF i/)
  const insert=calls.find(c=>c.sql.includes('INSERT INTO organization_members'))!
  assert.deepEqual(insert.values,[invitation.organization_id,'user','member','recruiter',undefined])
  const audit = calls.findIndex(c=>c.sql.includes(`INSERT INTO "${schema}".audit_logs`))
  assert.ok(audit > 0 && audit < calls.findIndex(c=>c.sql==='COMMIT'))
  assert.match(calls[audit]!.sql, /WITH inserted AS/)
  assert.match(calls[audit]!.sql, /INSERT INTO public.audit_logs/)
  assert.ok(calls[audit]!.sql.includes('read_company_data_cutover($1::uuid) IS NULL'))
  assert.ok(calls[audit]!.sql.includes('RETURNING *'))
  assert.deepEqual(calls[audit-1]!.values,[invitation.organization_id])
  assert.ok(!calls.some(c=>c.sql.includes('UPDATE user_roles')))
})
test('a missing or mismatched company schema rolls back the invitation write', async () => {
  const wrong = organizationSchemaName('33333333-3333-4333-8333-333333333333')
  for (const schemas of [[], [{schema_name:wrong,status:'ready',structure_ready:true}]]) {
    const {db,calls} = fakePool([[],[{role:'owner'}],[{id:invitation.id}],schemas])
    await assert.rejects(new WorkspaceInvitationsService(db, true).create(invitation.organization_id,'user',{}), {code:'WORKSPACE_SCHEMA_UNAVAILABLE',status:503})
    assert.ok(calls.some(c=>c.sql==='ROLLBACK'))
    assert.ok(!calls.some(c=>c.sql.includes('.audit_logs') || c.sql==='COMMIT'))
  }
})

test('legacy routing writes once to public without requiring company cutover metadata',async()=>{
  const {db,calls}=fakePool([[],[{role:'owner'}],[{id:invitation.id}],[],[invitation],[]])
  await new WorkspaceInvitationsService(db,false).create(invitation.organization_id,'user',{})
  const audits=calls.filter(c=>c.sql.includes('.audit_logs'))
  assert.equal(audits.length,1)
  assert.ok(audits[0]!.sql.includes('INSERT INTO "public".audit_logs'))
  assert.ok(!audits[0]!.sql.includes('read_company_data_cutover'))
})
test('a mirror insert failure rolls back the membership or invitation mutation',async()=>{
  const schema=organizationSchemaName(invitation.organization_id)
  const {db,calls}=fakePool([[],[{role:'owner'}],[{id:invitation.id}],[{schema_name:schema,status:'ready',structure_ready:true}]])
  const connect=db.connect.bind(db)
  db.connect=(async()=>{
    const client=await connect()
    const query=client.query.bind(client)
    client.query=(async(sql:string,values:unknown[]=[])=>{
      if(sql.includes('INSERT INTO public.audit_logs'))throw Error('mirror insert rejected')
      return query(sql,values)
    }) as typeof client.query
    return client
  }) as typeof db.connect
  await assert.rejects(new WorkspaceInvitationsService(db,true).create(invitation.organization_id,'user',{}),/mirror insert rejected/)
  assert.ok(calls.some(c=>c.sql==='ROLLBACK'))
  assert.ok(!calls.some(c=>c.sql==='COMMIT'))
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
test('owner creates a sub-administrator invitation and acceptance honors only enterprise role',async()=>{
  const invited={...invitation,membership_role:'admin'}
  const created=fakePool([[],[{role:'owner'}],[{id:invitation.id}],[],[invited],[]])
  assert.equal((await new WorkspaceInvitationsService(created.db,false).create(invitation.organization_id,'owner',{membershipRole:'admin'})).membershipRole,'admin')
  assert.equal(created.calls.find(call=>call.sql.includes('INSERT INTO organization_invitations'))!.values[3],'admin')
  const accepted=fakePool([[],[invited],[{email:'test@example.com'}],[{id:invitation.organization_id}],[{organization_id:invitation.organization_id}],[],[],[]])
  await new WorkspaceInvitationsService(accepted.db,false).accept(code,'user')
  assert.equal(accepted.calls.find(call=>call.sql.includes('INSERT INTO organization_members'))!.values[2],'admin')
  assert.ok(!accepted.calls.some(call=>call.sql.includes('user_roles')||call.sql.includes('platform_operators')))
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
test('sub-administrators cannot revoke administrator invitations',async()=>{
  const {db,calls}=fakePool([[],[{role:'admin'}],[]])
  await assert.rejects(new WorkspaceInvitationsService(db,false).revoke(invitation.organization_id,'actor',invitation.id),{code:'INVITATION_NOT_REVOCABLE'})
  const write=calls.find(call=>call.sql.startsWith('UPDATE organization_invitations'))!
  assert.ok(write.sql.includes("membership_role='member' OR $3='owner'"))
  assert.equal(write.values[2],'admin')
})
