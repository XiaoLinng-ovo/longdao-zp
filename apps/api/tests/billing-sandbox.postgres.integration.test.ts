import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {createPostgresHealthPool} from '../src/recruiting/db-health.js'
import {BillingSandboxService} from '../src/platform/billing-sandbox.js'
import {MockPaymentAdapter,type SimulationPaymentEvent} from '../src/platform/mock-payment.js'
test('simulation orders persist atomically in isolated PostgreSQL without changing real rights',async t=>{
 assert.equal(process.env.PGPORT,'15433');assert.equal(process.env.PGDATABASE,'smartrecruit_test')
 const pool=createPostgresHealthPool(),adapter=new MockPaymentAdapter(),service=new BillingSandboxService(pool,adapter)
 const org=randomUUID(),other=randomUUID(),owner=randomUUID(),member=randomUUID(),outsider=randomUUID(),users=[owner,member,outsider]
 const create=(key=randomUUID(),productCode='team_test_v1',version=1,channel='mock_alipay')=>service.create(owner,org,{productCode,channel,expectedVersion:version},key)
 const event=(id:string,kind:SimulationPaymentEvent['kind']='success'):SimulationPaymentEvent=>({eventId:'sandbox:'+id+':'+kind,orderId:id,organizationId:org,channel:'mock_alipay',kind,transactionId:'sandbox-tx:'+id,amountFen:100,currency:'CNY',merchant:'smartrecruit-sandbox',reason:kind==='refund'?'测试退款':''})
 const receive=(e:SimulationPaymentEvent)=>{const signed=adapter.sign(e);return service.acceptNotification(owner,org,signed.body,signed.signature)}
 let first:any,second:any,newer:any
 try {
  for(const user of users)await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'Billing sandbox fixture',true)",[user,user+'@example.invalid'])
  await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'Billing sandbox fixture','test'),($2,'Other sandbox fixture','test')",[org,other])
  await pool.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter'),($1,$3,'member','recruiter'),($4,$5,'owner','recruiter')",[org,owner,member,other,outsider])
  const baseline=(await pool.query('SELECT plan_version_id,entitlement_version,seat_usage,job_usage,service_status,service_version FROM organizations WHERE id=$1',[org])).rows[0]
  await t.test('tenant admin catalog, strict amounts, live channel rejection and page bounds',async()=>{
   assert.equal((await service.read(owner,org)).livePaymentEnabled,false)
   await assert.rejects(service.read(member,org),{code:'WORKSPACE_ADMIN_REQUIRED'})
   await assert.rejects(service.read(outsider,org),{status:403})
   await assert.rejects(service.read(owner,org,0),{code:'INVALID_PAGE'})
   await assert.rejects(service.create(owner,org,{productCode:'team_test_v1',channel:'alipay',expectedVersion:1},randomUUID()),{code:'LIVE_PAYMENT_DISABLED'})
   await assert.rejects(service.create(owner,org,{productCode:'team_test_v1',channel:'mock_alipay',expectedVersion:1,amountFen:1},randomUUID()),{code:'INVALID_ORDER'})
  })
  await t.test('concurrent same-key creation persists once and input conflict fails',async()=>{
   const key=randomUUID(),orders=await Promise.all([create(key),create(key)]);first=orders[0];assert.equal(first.id,orders[1]!.id);assert.equal(first.amountFen,100)
   await assert.rejects(create(key,'growth_test_v1'),{code:'ORDER_KEY_CONFLICT'})
   assert.equal((await service.read(owner,org)).total,1)
   await assert.rejects(service.simulate(outsider,other,first.id,'success'),{code:'ORDER_NOT_FOUND'})
  })
  await t.test('bad signatures and signed tampering cannot settle an order',async()=>{
   const signed=adapter.sign(event(first.id));await assert.rejects(service.acceptNotification(owner,org,signed.body,'0'.repeat(64)),{code:'MOCK_SIGNATURE_INVALID'})
   for(const patch of [{amountFen:1},{currency:'USD'},{merchant:'foreign'},{channel:'mock_wechat'},{organizationId:other},{transactionId:'foreign'},{eventId:'foreign'}])await assert.rejects(receive({...event(first.id),...patch} as SimulationPaymentEvent),{code:'PAYMENT_EVENT_MISMATCH'})
   assert.equal((await service.read(owner,org)).orders[0]!.status,'pending')
  })
  await t.test('concurrent successful notifications grant exactly once with durable replay',async()=>{
   second=await create()
   const results=await Promise.all([service.simulate(owner,org,first.id,'success'),service.simulate(owner,org,first.id,'success')])
   assert.equal(results.filter(r=>r.replayed).length,1);assert.equal((await service.read(owner,org)).entitlement.version,2)
   const restarted=new BillingSandboxService(pool);assert.equal((await restarted.simulate(owner,org,first.id,'success')).replayed,true)
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_sandbox_events WHERE order_id=$1 AND kind='success'",[first.id])).rows[0].n,1)
  })
  await t.test('late failure cannot downgrade a fulfilled order; competing old-version order goes to review',async()=>{
   assert.equal((await service.simulate(owner,org,first.id,'failure')).order.status,'fulfilled')
   const result=await service.simulate(owner,org,second.id,'success');assert.equal(result.order.status,'review');assert.equal(result.outcome,'review')
   assert.equal((await service.read(owner,org)).entitlement.activeOrderId,first.id)
  })
  await t.test('new purchase followed by refund of old purchase preserves newer rights',async()=>{
   newer=await create(randomUUID(),'growth_test_v1',2,'mock_wechat');await service.simulate(owner,org,newer.id,'success')
   assert.equal((await service.read(owner,org)).entitlement.version,3)
   await service.simulate(owner,org,first.id,'refund','测试旧订单退款')
   const current=await service.read(owner,org);assert.equal(current.entitlement.activeOrderId,newer.id);assert.equal(current.entitlement.version,3)
   assert.equal((await service.simulate(owner,org,first.id,'refund','测试旧订单退款')).replayed,true)
   await assert.rejects(service.simulate(owner,org,first.id,'refund','不同原因'),{code:'PAYMENT_EVENT_CONFLICT'})
  })
  await t.test('refund reverses current shadow rights once; delayed success cannot resurrect refunded rights',async()=>{
   await assert.rejects(service.simulate(owner,org,newer.id,'refund',''),{code:'REFUND_REASON_REQUIRED'})
   const results=await Promise.all([service.simulate(owner,org,newer.id,'refund','测试当前退款'),service.simulate(owner,org,newer.id,'refund','测试当前退款')])
   assert.equal(results.filter(r=>r.replayed).length,1);assert.equal((await service.read(owner,org)).entitlement.version,4)
   assert.equal((await service.simulate(owner,org,newer.id,'success')).order.status,'refunded');assert.equal((await service.read(owner,org)).entitlement.activeOrderId,null)
  })
  await t.test('failed payment can succeed; stale version cannot create a new order',async()=>{
   await assert.rejects(create(),{code:'VERSION_CONFLICT'})
   const order=await create(randomUUID(),'team_test_v1',4);await service.simulate(owner,org,order.id,'failure')
   assert.equal((await service.simulate(owner,org,order.id,'success')).order.status,'fulfilled')
  })
  await t.test('expiration and cancellation followed by success record review without granting',async()=>{
   const expired=await create(randomUUID(),'team_test_v1',5),cancelled=await create(randomUUID(),'team_test_v1',5)
   await assert.rejects(service.simulate(owner,org,expired.id,'expire'),{code:'ORDER_NOT_EXPIRED'})
   await pool.query("UPDATE billing_sandbox_orders SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired.id])
   assert.equal((await service.simulate(owner,org,expired.id,'expire')).order.status,'expired')
   assert.equal((await service.simulate(owner,org,expired.id,'success')).order.status,'review')
   await service.simulate(owner,org,cancelled.id,'cancel');assert.equal((await service.simulate(owner,org,cancelled.id,'success')).order.status,'review')
   await service.simulate(owner,org,cancelled.id,'refund','测试撤销退款');assert.equal((await service.read(owner,org)).entitlement.version,5)
  })
  await t.test('event write failure rolls back paid state and shadow grant, then recovery succeeds',async()=>{
   const order=await create(randomUUID(),'team_test_v1',5),db=await pool.connect()
   // A transaction-local trigger is unnecessary: use a targeted CHECK, removed in finally.
   const constraint='sandbox_fault_'+randomUUID().replaceAll('-','')
   try {
    await db.query('ALTER TABLE billing_sandbox_events ADD CONSTRAINT '+constraint+" CHECK(order_id <> '"+order.id+"'::uuid) NOT VALID")
    await assert.rejects(service.simulate(owner,org,order.id,'success'))
    assert.equal((await service.read(owner,org)).entitlement.version,5)
    const row=(await pool.query('SELECT status,paid_at FROM billing_sandbox_orders WHERE id=$1',[order.id])).rows[0];assert.equal(row.status,'pending');assert.equal(row.paid_at,null)
   } finally {await db.query('ALTER TABLE billing_sandbox_events DROP CONSTRAINT '+constraint);db.release()}
   assert.equal((await service.simulate(owner,org,order.id,'success')).order.status,'fulfilled')
  })
  await t.test('suspended enterprise and downgraded role block replay; unrelated tenants see no orders',async()=>{
   assert.equal((await service.read(outsider,other)).total,0)
   await pool.query("UPDATE organizations SET service_status='suspended' WHERE id=$1",[org])
   await assert.rejects(service.simulate(owner,org,first.id,'success'),{code:'WORKSPACE_SERVICE_UNAVAILABLE'})
   await pool.query("UPDATE organizations SET service_status='enabled' WHERE id=$1",[org])
   await pool.query("UPDATE organization_members SET role='member' WHERE organization_id=$1 AND user_id=$2",[org,owner])
   await assert.rejects(service.simulate(owner,org,first.id,'success'),{code:'WORKSPACE_ADMIN_REQUIRED'})
   await pool.query("UPDATE organization_members SET role='owner' WHERE organization_id=$1 AND user_id=$2",[org,owner])
  })
  await t.test('pagination and all real rights remain intact',async()=>{
   for(let i=0;i<15;i++)await create(randomUUID(),'team_test_v1',6)
   const p1=await service.read(owner,org),p2=await service.read(owner,org,2);assert.equal(p1.orders.length,20);assert.ok(p2.orders.length>0)
   assert.ok(p2.orders.every(o=>!p1.orders.some(x=>x.id===o.id)))
   assert.deepEqual((await pool.query('SELECT plan_version_id,entitlement_version,seat_usage,job_usage,service_status,service_version FROM organizations WHERE id=$1',[org])).rows[0],baseline)
  })
 } finally {
  await pool.query('DELETE FROM billing_sandbox_events WHERE organization_id=ANY($1::uuid[])',[[org,other]])
  await pool.query('DELETE FROM billing_sandbox_entitlements WHERE organization_id=ANY($1::uuid[])',[[org,other]])
  await pool.query('DELETE FROM billing_sandbox_orders WHERE organization_id=ANY($1::uuid[])',[[org,other]])
  await pool.query('DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])',[[org,other]])
  await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])',[[org,other]])
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[users]);await pool.end()
 }
})
