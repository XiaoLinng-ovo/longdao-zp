import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { EntitlementService } from '../src/platform/entitlements.js'
import { WorkspaceInvitationsService } from '../src/auth/workspace-invitations.js'
test('versioned plans enforce seats and job capacity with real concurrent PostgreSQL transactions',async t=>{
  if(shouldSkipPostgresIntegration()){t.skip('PostgreSQL not configured');return}
  const pool=createPostgresHealthPool(),service=new EntitlementService(pool),invites=new WorkspaceInvitationsService(pool)
  const org=randomUUID(),otherOrg=randomUUID(),admin=randomUUID(),viewer=randomUUID(),owner=randomUUID(),outsider=randomUUID(),joiners=[randomUUID(),randomUUID()],code='test_'+randomUUID().replaceAll('-','')
  const users=[admin,viewer,owner,outsider,...joiners];let planId=''
  try{
    for(const user of users) await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'Entitlement fixture',true)",[user,`${user}@example.invalid`])
    await pool.query("INSERT INTO platform_operators(user_id,role) VALUES($1,'admin'),($2,'viewer')",[admin,viewer])
    await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'Entitlement fixture','test'),($2,'Other entitlement fixture','test')",[org,otherOrg])
    await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter')",[org,owner])
    await t.test('enterprise members may read their enterprise; owners and platform viewers cannot write',async()=>{
      assert.equal((await service.readEnterprise(owner,org)).seats.used,1)
      await assert.rejects(service.readEnterprise(owner,otherOrg),{status:403})
      await assert.rejects(service.readEnterprise(admin,org),{status:403})
      await assert.rejects(service.listPlans(owner),{status:403})
      await assert.rejects(service.publish(viewer,{code,version:1,name:'并发测试套餐',seatLimit:2,jobLimit:1,reason:'测试发布'}),{status:403})
      const plan=await service.publish(admin,{code,version:1,name:'并发测试套餐',seatLimit:2,jobLimit:1,reason:'测试发布'},'entitlement-publish-test');planId=plan.id
      await assert.rejects(service.publish(admin,{code,version:1,name:'重复版本',seatLimit:2,jobLimit:1,reason:'重复发布'}),{code:'PLAN_VERSION_EXISTS'})
      await assert.rejects(pool.query('UPDATE subscription_plan_versions SET seat_limit=100 WHERE id=$1',[planId]),{code:'P5503'})
      await assert.rejects(service.assign(viewer,org,{planVersionId:planId,expectedVersion:1,reason:'越权分配'}),{status:403})
      await service.assign(admin,org,{planVersionId:planId,expectedVersion:1,reason:'测试套餐分配'})
      await assert.rejects(service.assign(admin,org,{planVersionId:planId,expectedVersion:1,reason:'过期版本'}),{code:'VERSION_CONFLICT'})
    })
    await t.test('two valid invitations racing for final seat: one success; loser invitation remains usable',async()=>{
      const invitations=await Promise.all(joiners.map(()=>invites.create(org,owner,{membershipRole:'member',businessRole:'recruiter',expiresInDays:7})))
      assert.equal((await service.readPlatform(viewer,org)).seats.used,1,'unaccepted invitations do not consume seats')
      const result=await Promise.allSettled(invitations.map((inv,i)=>invites.accept(inv.code,joiners[i]!)))
      assert.equal(result.filter(r=>r.status==='fulfilled').length,1)
      const loserIndex=result.findIndex(r=>r.status==='rejected');assert.equal((result[loserIndex] as PromiseRejectedResult).reason.code,'P5501')
      assert.equal((await service.readPlatform(viewer,org)).seats.used,2)
      const loser=joiners[loserIndex]!,winner=joiners[1-loserIndex]!
      assert.equal((await invites.preview(invitations[loserIndex]!.code,loser)).acceptedAt,null)
      await pool.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",[org,winner])
      assert.equal((await service.readPlatform(viewer,org)).seats.used,2,'no-op upsert must not charge a seat')
      await pool.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2',[org,winner])
      await invites.accept(invitations[loserIndex]!.code,loser)
      assert.equal((await service.readPlatform(viewer,org)).seats.used,2)
    })
    await t.test('concurrent jobs cannot overrun capacity; deletion releases and updates do not charge',async()=>{
      const jobIds=[randomUUID(),randomUUID()]
      const insert=(job:string)=>pool.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount) VALUES($1,$2,$3,'Capacity test',1)",[job,org,`JOB-${job}`])
      const result=await Promise.allSettled(jobIds.map(insert));assert.equal(result.filter(r=>r.status==='fulfilled').length,1)
      const loser=result.findIndex(r=>r.status==='rejected'),winner=1-loser
      assert.equal((result[loser] as PromiseRejectedResult).reason.code,'P5502')
      await pool.query("UPDATE jobs SET title='Changed' WHERE id=$1",[jobIds[winner]])
      assert.equal((await service.readPlatform(viewer,org)).jobs.used,1)
      await pool.query('DELETE FROM jobs WHERE id=$1',[jobIds[winner]])
      await insert(jobIds[loser]!)
      assert.equal((await service.readPlatform(viewer,org)).jobs.used,1)
    })
    await t.test('reject over-usage downgrade, publish new version without changing assigned rights, audit & revocation',async()=>{
      const small=await service.publish(admin,{code,version:2,name:'测试小容量',seatLimit:1,jobLimit:1,reason:'验证降级'})
      await assert.rejects(service.assign(admin,org,{planVersionId:small.id,expectedVersion:2,reason:'测试降级'}),{code:'PLAN_CAPACITY_BELOW_USAGE'})
      const current=await service.readPlatform(viewer,org);assert.equal(current.plan.id,planId);assert.equal(current.entitlementVersion,2)
      const audit=(await pool.query("SELECT metadata FROM platform_audit_logs WHERE organization_id=$1 AND action='platform.customer.entitlements'",[org])).rows
      assert.equal(audit.length,1);assert.equal(audit[0].metadata.reason,'测试套餐分配')
      await pool.query('UPDATE platform_operators SET is_active=false WHERE user_id=$1',[admin])
      await assert.rejects(service.assign(admin,org,{planVersionId:small.id,expectedVersion:2,reason:'已撤销运营'}),{status:403})
    })
  }finally{
    await pool.query('DELETE FROM platform_audit_logs WHERE actor_user_id=ANY($1::uuid[])',[users])
    await pool.query('DELETE FROM organization_invitations WHERE organization_id=$1',[org])
    await pool.query('DELETE FROM jobs WHERE organization_id=$1',[org])
    await pool.query('DELETE FROM audit_logs WHERE organization_id=$1',[org])
    await pool.query('DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])',[[org,otherOrg]])
    await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])',[[org,otherOrg]])
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users])
    // Published plan versions intentionally remain immutable. Unique fixture code avoids collisions.
    await pool.end()
  }
})
