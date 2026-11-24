import { assertDisposableTestDatabase } from './helpers/disposable-database.js'
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {createPostgresHealthPool} from '../src/recruiting/db-health.js';
import {PaymentService} from '../src/payments/service.js';
import type {PaymentProvider} from '../src/payments/providers.js';

test('商品版本：原子替换、幂等、归并、历史订单权益及并发保护',async t=>{
  assertDisposableTestDatabase();
  const pool=createPostgresHealthPool(),actor=randomUUID(),member=randomUUID(),org=randomUUID();
  const env:NodeJS.ProcessEnv={PAYMENT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),PAYMENT_PUBLIC_BASE_URL:'https://recruit.example.com'};
  let paid=false;
  const adapter:PaymentProvider={create:async()=>({payURL:'https://pay.example.com/test',qrCode:null}),query:async no=>({outTradeNo:no,transactionId:'version-test-'+no,amountFen:28800,currency:'CNY',paid}),notification:async()=>null,close:async()=>{},refund:async()=>true,queryRefund:async()=>true};
  const service=new PaymentService(pool,()=>adapter,env);
  const input={name:'算力包版本测试',amountFen:28800,billingKind:'addon',durationDays:null,durationMonths:null,billingEntitlements:{quotas:{ai_points:100,interview_seconds:601,ocr_pages:0},grantPeriod:'once',rollover:false},reason:'隔离版本测试'};
  const catalogs=new Set<string>();
  let original:any,current:any,copy:any,order:any,provider:any;
  try{
    for(const id of [actor,member])await pool.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'商品版本测试',true)",[id,id+'@example.invalid']);
    env.SYSTEM_ADMIN_USER_NO=(await pool.query('SELECT user_no FROM users WHERE id=$1',[actor])).rows[0].user_no;
    await pool.query("INSERT INTO organizations(id,name,kind,service_status,trial_ends_at) VALUES($1,'商品版本隔离企业','test','enabled',NULL)",[org]);
    await pool.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'member')",[org,member]);
    await t.test('新建幂等且同名商品不会自动合并',async()=>{
      const requestId=randomUUID();original=await service.publishProduct(actor,{...input,requestId});catalogs.add(original.catalogId);
      assert.equal((await service.publishProduct(actor,{...input,requestId})).id,original.id);
      assert.equal(original.versionNumber,1);assert.equal(original.active,false);
      await assert.rejects(service.publishProduct(actor,{...input,amountFen:100,requestId}),{code:'IDEMPOTENCY_CONFLICT'});
      copy=await service.publishProduct(actor,input);catalogs.add(copy.catalogId);assert.notEqual(copy.catalogId,original.catalogId);
      await assert.rejects(service.publishProduct(member,input),{code:'SYSTEM_ADMIN_REQUIRED'});
      await service.toggleProduct(actor,original.id,{active:true,reason:'测试上架'});
      provider=await service.addProvider(actor,{name:'版本隔离渠道',kind:'easypay',config:{apiBase:'https://pay.example.com',pid:'fixture',pkey:'fixture-only'},reason:'隔离测试渠道'});
      await service.toggleProvider(actor,provider.id,{enabled:true,reason:'隔离测试启用'});
      order=await service.create(member,org,{productId:original.id,providerId:provider.id,method:'alipay',mode:'redirect',expectedVersion:1},randomUUID(),'127.0.0.1');
    });
    await t.test('编辑原子切换为新版，重复提交只发布一次',async()=>{
      const next={...input,billingEntitlements:{...input.billingEntitlements,quotas:{ai_points:1000,interview_seconds:1200,ocr_pages:10}},requestId:randomUUID(),expectedVersionId:original.id};
      const results=await Promise.all([service.publishProduct(actor,next,original.id),service.publishProduct(actor,next,original.id)]);
      current=results[0];assert.equal(results[1]!.id,current.id);assert.equal(current.catalogId,original.catalogId);assert.equal(current.versionNumber,2);assert.equal(current.active,true);
      assert.equal((await pool.query('SELECT active FROM payment_products WHERE id=$1',[original.id])).rows[0].active,false);
      const rows=(await service.adminOverview(actor)).products.filter(p=>p.catalogId===original.catalogId);assert.equal(rows.length,1);assert.equal(rows[0]!.id,current.id);
      const history=await service.productHistory(actor,original.id);assert.equal(history.versions.length,2);assert.equal(history.currentVersionId,current.id);assert.equal(history.versions[1]!.billingEntitlements.quotas.ai_points,100);
      await assert.rejects(service.toggleProduct(actor,original.id,{active:true,reason:'不许重售旧版'}),{code:'VERSION_CONFLICT'});
      await assert.rejects(service.publishProduct(actor,{...next,requestId:randomUUID()},original.id),{code:'VERSION_CONFLICT'});
      await assert.rejects(pool.query('UPDATE payment_products SET amount_fen=1 WHERE id=$1',[original.id]),/Publish a new price version/);
    });
    await t.test('旧版待付款订单仍可结算，按原价原额度到账且退款关联不变',async()=>{
      const before=(await pool.query('SELECT product_id,amount_fen,billing_entitlements FROM payment_orders WHERE id=$1',[order.id])).rows[0];
      assert.equal(before.product_id,original.id);assert.equal(before.amount_fen,28800);assert.equal(before.billing_entitlements.quotas.ai_points,100);
      paid=true;const settled=await service.verify(member,org,order.id);assert.equal(settled.status,'fulfilled');
      const grants=(await pool.query('SELECT resource,total FROM billing_grants WHERE order_id=$1',[order.id])).rows;
      assert.equal(Number(grants.find(g=>g.resource==='ai_points')?.total),100);
      assert.equal((await pool.query('SELECT product_id FROM payment_orders WHERE id=$1',[order.id])).rows[0].product_id,original.id);
    });
    await t.test('并发不同修改仅一个成功；旧配置恢复发布新版本',async()=>{
      const previous=current;
      const results=await Promise.allSettled([1,2].map(n=>service.publishProduct(actor,{...input,amountFen:100+n,requestId:randomUUID(),expectedVersionId:previous.id},previous.id)));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'VERSION_CONFLICT');
      current=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;
      current=await service.publishProduct(actor,{...input,reason:'恢复首版配置',expectedVersionId:current.id,requestId:randomUUID()},current.id);
      assert.equal(current.versionNumber,4);assert.equal(current.billingEntitlements.quotas.ai_points,100);
      assert.equal((await service.productHistory(actor,current.id)).versions.length,4);
    });
    await t.test('跨类型归并回滚；手动指定当前版本归并不改订单与原版本 ID',async()=>{
      const sub=await service.publishProduct(actor,{name:'订阅隔离商品',seatLimit:5,jobLimit:10,amountFen:100,durationDays:30,reason:'跨类型归并测试'});catalogs.add(sub.catalogId);
      await assert.rejects(service.mergeProducts(actor,{versionIds:[current.id,sub.id],keepVersionId:current.id,active:true,reason:'非法跨类归并',requestId:randomUUID()}),{code:'PRODUCT_KIND_MISMATCH'});
      const request={versionIds:[current.id,copy.id],keepVersionId:copy.id,active:true,reason:'管理员明确归并',requestId:randomUUID()};
      const merged=await service.mergeProducts(actor,request);assert.equal(merged.id,copy.id);assert.equal(merged.versionNumber,5);
      assert.equal((await service.mergeProducts(actor,request)).id,copy.id);
      const history=await service.productHistory(actor,original.id);assert.equal(history.versions.length,5);assert.equal(history.currentVersionId,copy.id);
      assert.equal((await service.adminOverview(actor)).products.filter(p=>[original.catalogId,copy.catalogId].includes(p.catalogId)).length,1);
      assert.equal((await pool.query('SELECT product_id,amount_fen,billing_entitlements FROM payment_orders WHERE id=$1',[order.id])).rows[0].product_id,original.id);
      await assert.rejects(service.mergeProducts(actor,{...request,requestId:randomUUID()}),{code:'VERSION_CONFLICT'});
      await assert.rejects(service.toggleProduct(actor,current.id,{active:true,reason:'旧商品不能上架'}),{code:'VERSION_CONFLICT'});
      const next=await service.publishProduct(actor,{...input,expectedVersionId:copy.id,requestId:randomUUID()},copy.id);assert.equal(next.versionNumber,6);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_products WHERE catalog_id=$1 AND active',[next.catalogId])).rows[0].n,1);
      await service.refund(actor,order.id,'隔离测试原订单退款');
      assert.equal((await pool.query('SELECT product_id,status FROM payment_orders WHERE id=$1',[order.id])).rows[0].status,'refunded');
    });
    await t.test('同一商品仅调价与期限变化仍在剩余服务期后续费', async () => {
      const base = { name: '连续订阅验证', seatLimit: 5, jobLimit: 10, amountFen: 28800, durationDays: 30, reason: '续费连续性验证' };
      const originalSubscription = await service.publishProduct(actor, base); catalogs.add(originalSubscription.catalogId);
      await service.toggleProduct(actor, originalSubscription.id, { active: true, reason: '隔离测试上架' });
      const purchase = async (product: any) => {
        const version = (await service.checkout(member, org)).organization.entitlementVersion;
        const order = await service.create(member, org, { productId: product.id, providerId: provider.id, method: 'alipay', mode: 'redirect', expectedVersion: version }, randomUUID(), '127.0.0.1');
        await service.settle(provider.id, { outTradeNo: order.outTradeNo, transactionId: 'renewal-' + order.id, amountFen: order.amountFen, currency: 'CNY', paid: true }, 'callback');
        return order;
      };
      await purchase(originalSubscription);
      const before = (await pool.query('SELECT paid_subscription_expires_at FROM organizations WHERE id=$1', [org])).rows[0].paid_subscription_expires_at;
      const revised = await service.publishProduct(actor, { ...base, name: '连续订阅新版', amountFen: 18800, durationDays: 45, expectedVersionId: originalSubscription.id, requestId: randomUUID() }, originalSubscription.id);
      assert.notEqual(revised.planVersionId, originalSubscription.planVersionId);
      assert.equal((await service.checkout(member, org)).products.find(p => p.id === revised.id)?.subscriptionRenewal, true);
      await purchase(revised);
      const after = (await pool.query('SELECT paid_subscription_expires_at FROM organizations WHERE id=$1', [org])).rows[0].paid_subscription_expires_at;
      assert.equal(after.getTime() - before.getTime(), 45 * 86400_000);
    });
  }finally{
    await pool.query('DELETE FROM payment_events WHERE order_id IN(SELECT id FROM payment_orders WHERE organization_id=$1)',[org]);
    await pool.query('UPDATE organizations SET active_payment_order_id=NULL WHERE id=$1',[org]);
    await pool.query('DELETE FROM billing_grants WHERE organization_id=$1',[org]);
    await pool.query('DELETE FROM payment_orders WHERE organization_id=$1',[org]);
    await pool.query('DELETE FROM payment_products WHERE created_by=$1',[actor]);
    await pool.query('DELETE FROM payment_catalog_products WHERE id=ANY($1::uuid[])',[[...catalogs]]);
    await pool.query('DELETE FROM payment_providers WHERE created_by=$1',[actor]);
    await pool.query('DELETE FROM platform_audit_logs WHERE actor_user_id=$1',[actor]);
    await pool.query('DELETE FROM organization_members WHERE organization_id=$1',[org]);
    await pool.query('DELETE FROM organizations WHERE id=$1',[org]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[actor,member]]);
    await pool.end();
  }
});
