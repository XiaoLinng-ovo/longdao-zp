import { assertDisposableTestDatabase } from './helpers/disposable-database.js'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { createPostgresHealthPool } from '../src/recruiting/db-health.js';
import { PaymentService } from '../src/payments/service.js';
import { AlipayBills, shanghaiDay } from '../src/payments/bills.js';
import { HttpError } from '../src/http.js';
import { zipFixture, header } from './helpers/alipay-bill.js';
import type { PaymentProvider, PaymentEvidence } from '../src/payments/providers.js';
test('Alipay enterprise WAP, sandbox isolation and official bill retries, claims and merchant scope',async t=>{
  assertDisposableTestDatabase();
  const pool=createPostgresHealthPool(), actor=randomUUID(), member=randomUUID(), org=randomUUID();
  const env:NodeJS.ProcessEnv={PAYMENT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),PAYMENT_PUBLIC_BASE_URL:'https://recruit.example.com'};
  const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  let evidence:PaymentEvidence|null=null, billCalls=0, unavailable=false, corrupt=false, gate:Promise<void>|undefined;
  let release:(()=>void)|undefined, zip:Buffer=Buffer.alloc(0);
  const adapter:PaymentProvider={create:async()=>({payURL:'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay',qrCode:null}),query:async()=>evidence,notification:async()=>evidence,close:async()=>{},refund:async()=>true,queryRefund:async()=>true,billURL:async()=>{billCalls++;if(gate)await gate;if(unavailable)throw new HttpError(409,'PAYMENT_BILL_NOT_READY','fixture');return 'https://dwbillcenter.alipay.com/downloadBillFile.resource?fixture';}};
  const factory=()=>adapter, service=new PaymentService(pool,factory,env,async()=>zip), bills=new AlipayBills(pool,env,factory,async()=>corrupt?Buffer.from('invalid'):zip);
  const ids:string[]=[], productIds:string[]=[];
  try {
    for(const id of [actor,member])await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'Bill fixture',true)",[id,id+'@example.invalid']);
    env.SYSTEM_ADMIN_USER_NO=(await pool.query('SELECT user_no FROM users WHERE id=$1',[actor])).rows[0].user_no;
    await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'Alipay bill fixture','test')",[org]);
    await pool.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,actor,member]);
    const product=await service.publishProduct(actor,{planVersionId:'00000000-0000-4000-8000-000000000053',name:'支付宝账单测试套餐',amountFen:100,durationDays:30,reason:'隔离测试'});productIds.push(product.id);
    await service.toggleProduct(actor,product.id,{active:true,reason:'隔离测试'});
    const add=async(environment:string,sellerId:string)=>{const p=await service.addProvider(actor,{name:'Alipay '+environment,kind:'alipay',config:{appId:'app',sellerId,...keys,environment},reason:'隔离测试'});ids.push(p.id);await service.toggleProvider(actor,p.id,{enabled:true,reason:'隔离测试'});return p;};
    const old=await add('production','same_seller'), current=await add('production','same_seller'), sandbox=await add('sandbox','same_seller'), other=await add('production','other_seller');
    const create=async(providerId:string)=>service.create(member,org,{productId:product.id,providerId,method:'alipay',mode:'redirect',expectedVersion:(await pool.query('SELECT entitlement_version FROM organizations WHERE id=$1',[org])).rows[0].entitlement_version},randomUUID(),'203.0.113.1');
    const date=shanghaiDay(Date.now()-86400000),paidAt=date+'T12:00:00+08:00';
    const order=await create(old.id);
    evidence={outTradeNo:order.outTradeNo,transactionId:'ali_fixture',amountFen:100,currency:'CNY',paid:true,paidAt};
    await service.webhook(old.id,'fixture',{});
    assert.equal((await service.read(member,org,order.id)).status,'fulfilled');
    assert.equal(new Date((await service.read(member,org,order.id)).paidAt).getTime(),Date.parse(paidAt));
    const sandboxOrder=await create(sandbox.id), before=(await pool.query('SELECT entitlement_version,paid_subscription_expires_at FROM organizations WHERE id=$1',[org])).rows[0];
    evidence={...evidence,outTradeNo:sandboxOrder.outTradeNo,transactionId:'sandbox_fixture'};
    await service.webhook(sandbox.id,'fixture',{});
    const sandboxResult=await service.read(member,org,sandboxOrder.id);assert.equal(sandboxResult.status,'review');assert.equal(sandboxResult.environment,'sandbox');
    const after=(await pool.query('SELECT entitlement_version,paid_subscription_expires_at FROM organizations WHERE id=$1',[org])).rows[0];assert.deepEqual(after,before);
    await assert.rejects(service.billReports(member),(e:any)=>e.code==='SYSTEM_ADMIN_REQUIRED');
    await assert.rejects(service.reconcileBill(member,{providerId:current.id,billDate:date,reason:'越权测试'}),(e:any)=>e.code==='SYSTEM_ADMIN_REQUIRED');
    zip=zipFixture(Buffer.from(header+'\nali_fixture,'+order.outTradeNo+',交易,1.00,,fixture\n'));
    await bills.run(current.id,date);let report=(await bills.list()).find(r=>r.providerId===current.id)!;
    assert.equal(report.status,'succeeded');assert.equal(report.entryCount,1);assert.equal(report.differenceCount,0);assert.match(report.fileSha256,/^[a-f0-9]{64}$/);
    await bills.run(current.id,date);assert.equal(billCalls,1);
    unavailable=true;await bills.run(current.id,date,true);report=(await bills.list()).find(r=>r.providerId===current.id)!;assert.equal(report.status,'not_ready');
    const calls=billCalls;await bills.run(current.id,date);assert.equal(billCalls,calls);
    unavailable=false;corrupt=true;await bills.run(current.id,date,true);report=(await bills.list()).find(r=>r.providerId===current.id)!;assert.equal(report.status,'failed');
    corrupt=false;zip=zipFixture(Buffer.from(header+'\nali_fixture,'+order.outTradeNo+',交易,2.00,,fixture\n'));
    await bills.run(current.id,date,true);report=(await bills.list()).find(r=>r.providerId===current.id)!;assert.equal(report.status,'differences');assert.equal(report.differences[0].type,'amount_mismatch');
    // A matching merchant order number in another seller must never count as a match.
    await bills.run(other.id,date,true);const foreign=(await bills.list()).find(r=>r.providerId===other.id)!;assert.equal(foreign.differences[0].type,'bill_only');
    gate=new Promise(resolve=>{release=resolve;});const running=bills.run(current.id,date,true);
    for(let i=0;i<100;i++){if((await pool.query("SELECT status FROM public.payment_bill_runs WHERE provider_id=$1 AND bill_date=$2",[current.id,date])).rows[0]?.status==='running')break;await new Promise(r=>setTimeout(r,5));}
    await assert.rejects(bills.run(current.id,date,true),(e:any)=>e.code==='PAYMENT_BILL_RUNNING');release!();await running;gate=undefined;
    zip=zipFixture(Buffer.from(header+'\nali_fixture,'+order.outTradeNo+',交易,1.00,,fixture\n'));
    const final=await service.reconcileBill(actor,{providerId:current.id,billDate:date,reason:'管理员重试对账'});assert.equal(final.find(r=>r.providerId===current.id)?.status,'succeeded');
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM platform_audit_logs WHERE actor_user_id=$1 AND action='payment.bill.reconcile'",[actor])).rows[0].n,1);
    assert.equal((await pool.query('SELECT status FROM payment_orders WHERE id=$1',[order.id])).rows[0].status,'fulfilled');
  } finally {
    release?.();
    await pool.query('DELETE FROM platform_audit_logs WHERE actor_user_id=ANY($1::uuid[])',[[actor,member]]);
    await pool.query('UPDATE organizations SET active_payment_order_id=NULL WHERE id=$1',[org]);
    await pool.query('DELETE FROM payment_events WHERE order_id IN (SELECT id FROM payment_orders WHERE organization_id=$1)',[org]);
    await pool.query('DELETE FROM billing_grants WHERE order_id IN (SELECT id FROM payment_orders WHERE organization_id=$1)',[org]);
    await pool.query('DELETE FROM payment_orders WHERE organization_id=$1',[org]);
    await pool.query('DELETE FROM payment_bill_runs WHERE provider_id=ANY($1::uuid[])',[ids]);
    await pool.query('DELETE FROM payment_products WHERE id=ANY($1::uuid[])',[productIds]);
    await pool.query('DELETE FROM payment_providers WHERE id=ANY($1::uuid[])',[ids]);
    await pool.query('DELETE FROM organizations WHERE id=$1',[org]);await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[actor,member]]);await pool.end();
  }
});
