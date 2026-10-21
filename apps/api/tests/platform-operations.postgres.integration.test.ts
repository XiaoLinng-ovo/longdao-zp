import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { PlatformService } from '../src/platform/service.js'
import { PostgresSessionRepository } from '../src/auth/session-repository.js'
import { WorkspaceInvitationsService } from '../src/auth/workspace-invitations.js'
import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
test('platform permissions, lifecycle, sessions and invitations use real PostgreSQL; all fixtures roll back', async t => {
  if (shouldSkipPostgresIntegration()) {t.skip('PostgreSQL is not configured');return}
  const pool=createPostgresHealthPool(),db=await pool.connect()
  const query=async(sql:string,values:unknown[]=[])=>db.query(sql==='BEGIN'?'SAVEPOINT platform_test':sql==='COMMIT'?'RELEASE SAVEPOINT platform_test':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT platform_test':sql,values)
  const adapter={query,async connect(){return{query,release(){}}},async end(){}} as unknown as Pool
  const service=new PlatformService(adapter),sessions=new PostgresSessionRepository(adapter)
  const admin=randomUUID(),viewer=randomUUID(),owner=randomUUID(),org=randomUUID(),archived=randomUUID()
  const ids=[admin,viewer,owner]
  await db.query('BEGIN')
  try {
    for(const id of ids) await db.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'Platform fixture',true)",[id,`${id}@example.invalid`])
    await db.query("INSERT INTO user_roles(user_id,role_id) SELECT $1,id FROM roles WHERE code='admin'",[owner])
    await db.query("INSERT INTO platform_operators(user_id,role) VALUES($1,'admin'),($2,'viewer')",[admin,viewer])
    await db.query("INSERT INTO organizations(id,name,kind,status) VALUES($1,'platform lifecycle fixture','test','active'),($2,'archived platform fixture','test','archived')",[org,archived])
    await db.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter')",[org,owner])
    await t.test('business admin + owner is not a platform operator; viewer cannot write', async()=>{
      await assert.rejects(service.listCustomers(owner,new URLSearchParams()),{status:403})
      const result=await service.listCustomers(viewer,new URLSearchParams({search:'platform lifecycle fixture'}));assert.equal(result.total,1)
      assert.deepEqual(Object.keys(result.items[0]!).sort(),['id','name','kind','status','serviceStatus','trialEndsAt','serviceVersion','serviceAvailable','memberCount','createdAt'].sort())
      await assert.rejects(service.updateLifecycle(viewer,org,{serviceStatus:'suspended',reason:'test pause',expectedVersion:1}),{status:403})
    })
    const session=await sessions.createSession({id:owner,name:'Owner',email:`${owner}@example.invalid`,role:'admin',departmentId:''})
    await sessions.selectWorkspace(session.session.sessionId,owner,org)
    await t.test('suspension is audited, optimistic writes cannot overwrite and archived orgs stay archived',async()=>{
      const saved=await service.updateLifecycle(admin,org,{serviceStatus:'suspended',reason:'测试暂停',expectedVersion:1},'platform-test');assert.equal(saved.serviceAvailable,false);assert.equal(saved.serviceVersion,2)
      await assert.rejects(service.updateLifecycle(admin,org,{serviceStatus:'enabled',reason:'过期版本',expectedVersion:1}),{code:'VERSION_CONFLICT'})
      await assert.rejects(service.updateLifecycle(admin,archived,{serviceStatus:'enabled',reason:'不能恢复',expectedVersion:1}),{code:'WORKSPACE_ARCHIVED'})
      const audit=(await service.listAudit(viewer)).find(row=>row.organizationId===org)!;assert.equal(audit.metadata.reason,'测试暂停');assert.equal(audit.requestId,'platform-test')
      assert.equal((await db.query('SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1',[org])).rows[0].n,1)
    })
    await t.test('existing sessions lose enterprise scope and cannot reselect or administer AI/invitations',async()=>{
      const current=await sessions.findSessionByToken(session.token);assert.equal(current!.user.workspaceId,undefined);assert.equal(current!.user.workspaceAccessIssue,'unavailable')
      await assert.rejects(sessions.selectWorkspace(session.session.sessionId,owner,org))
      const workspaces=await sessions.listWorkspaces(owner);assert.equal(workspaces[0]!.serviceAvailable,false)
      await assert.rejects(new EnterpriseAiStore(adapter).assertAdmin(org,owner),{code:'WORKSPACE_ADMIN_REQUIRED'})
      const invites=new WorkspaceInvitationsService(adapter);await assert.rejects(invites.list(org,owner))
    })
    await t.test('restore and trial expiration preserve records; revoked operator loses access immediately',async()=>{
      await service.updateLifecycle(admin,org,{serviceStatus:'trial',trialEndsAt:new Date(Date.now()+86400000).toISOString(),reason:'测试试用',expectedVersion:2})
      assert.equal((await sessions.listWorkspaces(owner))[0]!.serviceAvailable,true)
      await db.query("UPDATE organizations SET trial_ends_at=now()-interval '1 second' WHERE id=$1",[org])
      assert.equal((await sessions.listWorkspaces(owner))[0]!.serviceAvailable,false)
      await service.updateLifecycle(admin,org,{serviceStatus:'enabled',reason:'测试恢复',expectedVersion:3})
      assert.ok((await sessions.findSessionByToken(session.token))!.user.workspaceId)
      assert.equal((await sessions.listWorkspaces(admin)).length,0,'platform grant does not create enterprise memberships')
      await db.query('UPDATE platform_operators SET is_active=false WHERE user_id=$1',[admin]);await assert.rejects(service.listCustomers(admin,new URLSearchParams()),{status:403})
    })
  } finally {await db.query('ROLLBACK');db.release();await pool.end()}
})
