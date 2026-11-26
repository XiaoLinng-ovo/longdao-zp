import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createDatabasePool } from '../src/db/connection.js'
import { WorkspaceInvitationsService } from '../src/auth/workspace-invitations.js'
import { PostgresSessionRepository } from '../src/auth/session-repository.js'
import { organizationSchemaName } from '../src/db/tenant-context.js'

test('shared invitations: concurrent multi-user joins, registration rollback, scoped permissions and ownership',async t=>{
 const expected=process.env.INVITATION_TEST_DATABASE
 if(!expected || !/^invitation_verify_[a-f0-9]{32}$/.test(expected)) {t.skip('Run scripts/test-shared-workspace-invitations.mjs against an isolated local database');return}
 const pool=createDatabasePool()
 try {
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,expected)
  const service=new WorkspaceInvitationsService(pool,true),sessions=new PostgresSessionRepository(pool)
  const owner=randomUUID(),admin=randomUUID(),first=randomUUID(),second=randomUUID(),org=randomUUID()
  for(const id of [owner,admin,first,second]) await pool.query("INSERT INTO users (id,email,display_name,is_active) VALUES ($1,$2,'邀请测试',true)",[id,id+'@example.invalid'])
  await pool.query("INSERT INTO organizations (id,name,kind,created_by) VALUES ($1,'共享邀请测试企业','test',$2)",[org,owner])
  await pool.query('SELECT public.initialize_organization_schema($1)',[org])
  await pool.query("INSERT INTO organization_members (organization_id,user_id,role,business_role) VALUES ($1,$2,'owner','recruiter'),($1,$3,'admin','recruiter')",[org,owner,admin])
  await assert.rejects(service.create(org,owner,{email:''}),{code:'VALIDATION_ERROR'})
  const [invite,reused]=await Promise.all([service.create(org,owner,{}),service.create(org,admin,{})])
  assert.equal(invite.id,reused.id)
  assert.equal(Date.parse(invite.expiresAt!)-Date.parse(invite.createdAt!),72*3600000)
  await Promise.all([service.accept(invite.code,first),service.accept(invite.code,second),service.accept(invite.code,first)])
  assert.equal((await service.list(org,owner))[0]!.joinedCount,2)
  assert.equal((await service.preview(invite.code,first)).status,'pending')
  assert.equal((await service.accept(invite.code,first)).alreadyMember,true)
  const roles=await pool.query('SELECT role,business_role,department_id FROM organization_members WHERE organization_id=$1 AND user_id=ANY($2::uuid[])',[org,[first,second]])
  assert.ok(roles.rows.every(row=>row.role==='member'&&row.business_role==='recruiter'&&row.department_id===null))
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_roles WHERE user_id=$1',[first])).rows[0].n,0)
  await service.setMemberStatus(org,owner,first,{isActive:false,reason:'测试停用'})
  await assert.rejects(service.accept(invite.code,first),{code:'MEMBERSHIP_DISABLED'})
  await service.setMemberStatus(org,owner,first,{isActive:true,reason:'恢复测试'})
  await assert.rejects(service.updateMember(org,admin,second,{membershipRole:'admin'}),{code:'FORBIDDEN'})
  await service.updateMember(org,owner,second,{membershipRole:'admin'})
  assert.equal((await service.accept(invite.code,second)).alreadyMember,true)
  assert.equal((await pool.query('SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2',[org,second])).rows[0].role,'admin')
  const before=(await pool.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n
  const email='invited-'+randomUUID()+'@example.invalid',codeHash='a'.repeat(64)
  await sessions.createEmailVerificationChallenge({purpose:'registration',email,codeHash,expiresInMs:600000,maxAttempts:5})
  const registered=await sessions.registerUserWithVerification({name:'受邀注册用户',email,password:'strong-password',companyName:'',invitationCode:invite.code!},{codeHash})
  assert.equal(registered.workspace!.id,org);assert.equal(registered.workspace!.role,'member')
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM organizations')).rows[0].n,before)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM organization_invitation_joins WHERE invitation_id=$1',[invite.id])).rows[0].n,3)
  const replaced=await service.create(org,owner,{replace:true})
  await assert.rejects(service.summary(invite.code),{code:'INVITATION_REVOKED'})
  const failedEmail='rollback-'+randomUUID()+'@example.invalid'
  await sessions.createEmailVerificationChallenge({purpose:'registration',email:failedEmail,codeHash,expiresInMs:600000,maxAttempts:5})
  await assert.rejects(sessions.registerUserWithVerification({name:'回滚测试用户',email:failedEmail,password:'strong-password',companyName:'',invitationCode:invite.code!},{codeHash}),{code:'INVITATION_REVOKED'})
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE email=$1',[failedEmail])).rows[0].n,0)
  assert.equal((await pool.query('SELECT consumed_at FROM email_verification_challenges WHERE email=$1',[failedEmail])).rows[0].consumed_at,null)
  await service.revoke(org,admin,replaced.id)
  const expired=await service.create(org,owner,{})
  await pool.query("UPDATE organization_invitations SET created_at=now()-interval '4 days',expires_at=now()-interval '1 day' WHERE id=$1",[expired.id])
  await assert.rejects(service.accept(expired.code,registered.user.id),{code:'INVITATION_EXPIRED'})
  await service.transferOwnership(org,owner,second,{reason:'测试交接'})
  const owners=await pool.query("SELECT user_id FROM organization_members WHERE organization_id=$1 AND role='owner'",[org])
  assert.deepEqual(owners.rows.map(row=>row.user_id),[second])
  assert.equal((await pool.query('SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2',[org,owner])).rows[0].role,'admin')
  const schema=organizationSchemaName(org)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM "'+schema+'".audit_logs WHERE action=$1',['workspace.invitation.accept'])).rows[0].n,3)
 } finally {await pool.end()}
})
