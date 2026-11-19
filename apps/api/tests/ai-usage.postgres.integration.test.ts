import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { AiUsageService } from '../src/platform/ai-usage.js'
import { createPostgresHealthPool } from '../src/recruiting/db-health.js'
test('AI usage durable task lifecycle, concurrency and enterprise isolation (real PG)',async t=>{
  assert.equal(process.env.PGPORT,'15433','Run with dedicated test PostgreSQL; this suite never skips or touches business data')
  assert.equal(process.env.PGDATABASE,'smartrecruit_test')
  const pool=createPostgresHealthPool(),service=new AiUsageService(pool)
  const org=randomUUID(),other=randomUUID(),owner=randomUUID(),member=randomUUID(),resource=randomUUID()
  const input={organizationId:org,actorId:owner,operation:'jd' as const,resourceId:resource,key:randomUUID(),input:{prompt:'not stored'},model:'fixture-model'}
  try{
    await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$3,'usage fixture',true),($2,$4,'usage fixture',true)",[owner,member,owner+'@example.invalid',member+'@example.invalid'])
    await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'usage fixture','test'),($2,'other usage fixture','test')",[org,other])
    await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter'),($1,$3,'member','recruiter')",[org,owner,member])
    await t.test('successful generation settles once; replay after service recreation does not invoke provider',async()=>{
      let calls=0
      assert.deepEqual(await service.execute(input,async()=>{calls++;return {version:1}}),{version:1})
      assert.deepEqual(await new AiUsageService(pool).execute(input,async()=>{calls++;return {version:2}}),{version:1})
      assert.equal(calls,1)
      await assert.rejects(service.execute({...input,input:{prompt:'different'}},async()=>({})),{code:'USAGE_KEY_CONFLICT'})
    })
    await t.test('concurrent identical task dispatches provider only once',async()=>{
      let calls=0,complete!:()=>void,signalStarted!:()=>void
      const wait=new Promise<void>(resolve=>{complete=resolve})
      const started=new Promise<void>(resolve=>{signalStarted=resolve})
      const first=service.execute({...input,key:'race-task-key'},async()=>{calls++;signalStarted();await wait;return {ok:true}})
      await started
      await assert.rejects(service.execute({...input,key:'race-task-key'},async()=>{calls++;return {ok:true}}),{code:'AI_USAGE_TASK_EXISTS'})
      complete();await first;assert.equal(calls,1)
    })
    await t.test('explicit rejection releases but does not pretend successful generation or replay retry',async()=>{
      const request={...input,key:randomUUID()};const error=Object.assign(new Error('never stored secret'),{code:'MODEL_HTTP_ERROR'})
      await assert.rejects(service.execute(request,async()=>{throw error}))
      const row=(await pool.query('SELECT state,settled_units,result FROM ai_usage_tasks WHERE idempotency_key=$1',[request.key])).rows[0]
      assert.deepEqual(row,{state:'released',settled_units:0,result:null})
      await assert.rejects(service.execute(request,async()=>({})),{code:'AI_USAGE_TASK_EXISTS'})
    })
    await t.test('timeout or persistence ambiguity needs reconciliation; no automatic provider retry',async()=>{
      for(const code of ['MODEL_REQUEST_FAILED','MODEL_RESPONSE_INVALID','DB_WRITE_FAILED']){
        const request={...input,key:randomUUID()}
        await assert.rejects(service.execute(request,async()=>{throw Object.assign(new Error('fixture'),{code})}))
        assert.equal((await pool.query('SELECT state FROM ai_usage_tasks WHERE idempotency_key=$1',[request.key])).rows[0].state,'uncertain')
      }
    })
    await t.test('enterprise administrators read metadata only; members and unrelated enterprises forbidden',async()=>{
      const report=await service.read(owner,org)
      assert.equal(report.billingSource,'customer_model');assert.equal(report.chargeAmount,null);assert.equal(report.summary.settled,2);assert.equal(report.summary.reconciliation,3)
      assert.equal(JSON.stringify(report).includes('not stored'),false);assert.equal('result' in report.items[0],false)
      await assert.rejects(service.read(member,org),{status:403});await assert.rejects(service.read(owner,other),{status:403});await assert.rejects(service.read(owner,org,0),{status:400})
    })
    await t.test('crashed reservations older than ten minutes surface as reconciliation rather than refunded',async()=>{
      await pool.query("INSERT INTO ai_usage_tasks(organization_id,actor_user_id,operation,resource_id,idempotency_key,fingerprint,model,created_at) VALUES($1,$2,'jd',$3,'stale-task-key','fixture','model',now()-interval '11 minutes')",[org,owner,resource])
      const report=await service.read(owner,org);assert.equal(report.summary.reconciliation,4);assert.equal(report.items.find(r=>r.state==='reserved')?.needsReconciliation,true)
    })
    await t.test('unavailable enterprises and invalid keys never dispatch provider',async()=>{
      await pool.query("UPDATE organizations SET service_status='suspended' WHERE id=$1",[org]);let calls=0
      await assert.rejects(service.execute(input,async()=>{calls++;return {}}),{code:'WORKSPACE_SERVICE_UNAVAILABLE'})
      await assert.rejects(service.execute({...input,key:randomUUID()},async()=>{calls++;return {}}),{code:'WORKSPACE_SERVICE_UNAVAILABLE'})
      await assert.rejects(service.execute({...input,key:'bad'},async()=>{calls++;return {}}),{code:'INVALID_IDEMPOTENCY_KEY'});assert.equal(calls,0)
    })
  }finally{
    await pool.query('DELETE FROM ai_usage_tasks WHERE organization_id=$1',[org]);await pool.query('DELETE FROM organization_members WHERE organization_id=$1',[org]);await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])',[[org,other]]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[owner,member]]);await pool.end()
  }
})
