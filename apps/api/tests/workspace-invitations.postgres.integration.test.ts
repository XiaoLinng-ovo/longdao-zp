import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createDatabasePool } from '../src/db/connection.js'
import { WorkspaceInvitationsService, InvitationError } from '../src/auth/workspace-invitations.js'
import { PostgresSessionRepository } from '../src/auth/session-repository.js'
const denied=(code:string)=>(e:unknown)=>e instanceof InvitationError && e.code===code
test('PostgreSQL enterprise invitations: scoped permissions, single use, email, revoke, expiry, audit and session roles',async(t)=>{
 if(!process.env.DATABASE_URL && !process.env.PGPASSWORD){t.skip('PostgreSQL integration is not configured');return}
 const pool=createDatabasePool(),client=await pool.connect()
 // Keep fixtures and service transactions on one connection; never commit test data.
 const query=async(sql:string,values:unknown[]=[])=>client.query(sql==='BEGIN'?'SAVEPOINT invitation_service_test':sql==='COMMIT'?'RELEASE SAVEPOINT invitation_service_test':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT invitation_service_test':sql,values)
 const adapter={query,async connect(){return {query,release(){}}}}
 const service=new WorkspaceInvitationsService(adapter as unknown as Pool)
 const sessions=new PostgresSessionRepository(adapter)
 const orgA=randomUUID(),orgB=randomUUID(),owner=randomUUID(),admin=randomUUID(),joiner=randomUUID(),other=randomUUID()
 await client.query('BEGIN')
 try{
  for(const id of [owner,admin,joiner,other])await client.query("INSERT INTO users (id,email,display_name,is_active) VALUES ($1,$2,'邀请功能集成测试',true)",[id,id+'@example.invalid'])
  for(const org of [orgA,orgB])await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'邀请模块集成测试','test')",[org])
  await client.query("INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'admin'),($4,$2,'owner')",[orgA,owner,admin,orgB])
  await assert.rejects(service.list(orgA,other),denied('WORKSPACE_ADMIN_REQUIRED'))
  await assert.rejects(service.create(orgA,admin,{membershipRole:'admin'}),denied('FORBIDDEN'))
  await assert.rejects(service.create(orgA,owner,{businessRole:'hr_admin'}),denied('VALIDATION_ERROR'))
  const invite=await service.create(orgA,owner,{businessRole:'interviewer',email:joiner+'@example.invalid'})
  assert.equal(invite.status,'pending');assert.ok(invite.code)
  assert.equal((await service.preview(invite.code,joiner)).businessRole,'interviewer')
  await assert.rejects(service.preview(invite.code,other),denied('INVITATION_EMAIL_MISMATCH'))
  await service.accept(invite.code,joiner)
  await assert.rejects(service.accept(invite.code,joiner),denied('INVITATION_USED'))
  assert.equal((await service.list(orgA,owner))[0]!.status,'accepted')
  assert.equal((await client.query('SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1',[joiner])).rows[0].n,0)
  const inviteB=await service.create(orgB,owner,{businessRole:'approver'})
  await service.accept(inviteB.code,joiner)
  const created=await sessions.createSession({id:joiner,name:'测试',email:joiner+'@example.invalid',role:'recruiter',departmentId:''})
  assert.equal((await sessions.selectWorkspace(created.session.sessionId,joiner,orgA)).role,'interviewer')
  assert.equal((await sessions.findSessionByToken(created.token))?.user.role,'interviewer')
  await service.updateMember(orgA,owner,joiner,{businessRole:'recruiter',membershipRole:'member'})
  assert.equal((await sessions.findSessionByToken(created.token))?.user.role,'recruiter')
  assert.equal((await sessions.selectWorkspace(created.session.sessionId,joiner,orgB)).role,'approver')
  assert.equal((await sessions.findSessionByToken(created.token))?.user.role,'approver')
  await assert.rejects(service.updateMember(orgA,admin,owner,{businessRole:'recruiter'}),denied('FORBIDDEN'))
  await assert.rejects(service.updateMember(orgA,admin,joiner,{membershipRole:'admin'}),denied('FORBIDDEN'))
  await assert.rejects(service.updateMember(orgA,owner,owner,{}),denied('FORBIDDEN'))
  const duplicate=await service.create(orgA,owner,{})
  await assert.rejects(service.accept(duplicate.code,joiner),denied('ALREADY_MEMBER'))
  assert.equal((await service.preview(duplicate.code,joiner)).status,'pending')
  await service.revoke(orgA,owner,duplicate.id)
  await assert.rejects(service.preview(duplicate.code,other),denied('INVITATION_REVOKED'))
  const expired=await service.create(orgA,owner,{})
  await client.query("UPDATE organization_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE id=$1",[expired.id])
  await assert.rejects(service.accept(expired.code,other),denied('INVITATION_EXPIRED'))
  assert.equal((await client.query("SELECT count(*)::int n FROM audit_logs WHERE organization_id=$1 AND resource_type='organization_member'",[orgA])).rows[0].n,1)
  await client.query("UPDATE organizations SET status='archived',archived_at=now() WHERE id=$1",[orgB])
  const archived=await sessions.findSessionByToken(created.token)
  assert.equal(archived?.user.workspaceId,undefined);assert.equal(archived?.user.role,'recruiter')
 }finally{await client.query('ROLLBACK');client.release();await pool.end()}
})
