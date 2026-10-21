import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { normalizeInvitationCode, validateInvitationInput, WorkspaceInvitationsService, InvitationError } from './workspace-invitations.js'
const code='ABCDEF123456ABCDEF123456'
test('invitation codes normalize separators but reject arbitrary secrets and short codes',()=>{
  assert.equal(normalizeInvitationCode(' abcdef-123456-abcdef-123456 '),code)
  for(const value of ['', 'admin123', 'G'.repeat(24), null, {code}]) assert.throws(()=>normalizeInvitationCode(value),InvitationError)
})
test('invites cannot grant platform administrator roles or owner membership',()=>{
  for(const businessRole of ['admin','hr_admin','owner','unknown']) assert.throws(()=>validateInvitationInput({businessRole}),InvitationError)
  assert.throws(()=>validateInvitationInput({membershipRole:'owner'}),InvitationError)
  assert.throws(()=>validateInvitationInput({expiresInDays:0}),InvitationError)
  assert.throws(()=>validateInvitationInput({email:'not-email'}),InvitationError)
  assert.throws(()=>validateInvitationInput({businessRole:'hiring_manager'}),InvitationError)
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
  const {db,calls}=fakePool([[],[invitation],[{email:'test@example.com'}],[{id:invitation.organization_id}],[{organization_id:invitation.organization_id}],[],[],[]])
  await assert.doesNotReject(new WorkspaceInvitationsService(db).accept(code,'user'))
  assert.match(calls[1]!.sql,/FOR UPDATE OF i/)
  const insert=calls.find(c=>c.sql.includes('INSERT INTO organization_members'))!
  assert.deepEqual(insert.values,[invitation.organization_id,'user','member','interviewer',undefined])
  assert.ok(calls.some(c=>c.sql==='COMMIT'));assert.ok(calls.some(c=>c.sql.includes('INSERT INTO audit_logs')))
  assert.ok(!calls.some(c=>c.sql.includes('UPDATE user_roles')))
})
