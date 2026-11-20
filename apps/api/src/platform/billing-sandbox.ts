import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { HttpError } from '../http.js'
import { MockPaymentAdapter, requireSimulationChannel, type SimulationPaymentEvent, type SimulationEventKind } from './mock-payment.js'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
export const sandboxCatalog = [
 {code:'all_modules_year_v1',name:'全功能年付套餐',planVersionId:'00000000-0000-4000-8000-000000000054',seatLimit:100,jobLimit:2000,amountFen:250000,currency:'CNY',durationDays:null,durationMonths:12,allModules:true},
 {code:'all_modules_half_year_v1',name:'全功能半年套餐',planVersionId:'00000000-0000-4000-8000-000000000054',seatLimit:100,jobLimit:2000,amountFen:130000,currency:'CNY',durationDays:null,durationMonths:6,allModules:true},
 {code:'all_modules_month_v1',name:'全功能月付套餐',planVersionId:'00000000-0000-4000-8000-000000000054',seatLimit:100,jobLimit:2000,amountFen:25800,currency:'CNY',durationDays:null,durationMonths:1,allModules:true},
] as const
function orderView(row: any) {
 return {id:row.id,productCode:row.product_code,name:row.product_name,seatLimit:row.seat_limit,jobLimit:row.job_limit,
  amountFen:row.amount_fen,currency:row.currency,durationDays:row.duration_days,durationMonths:row.duration_months ?? null,allModules:row.all_modules ?? false,channel:row.channel,status:row.status,
  createdAt:row.created_at,expiresAt:row.expires_at,paidAt:row.paid_at,refundedAt:row.refunded_at}
}
export class BillingSandboxService {
 constructor(private readonly pool: Pool, private readonly adapter = new MockPaymentAdapter()) {}
 private async transaction<T>(actor: string, org: string, work: (db: PoolClient) => Promise<T>): Promise<T> {
  if (!uuid.test(org)) throw new HttpError(409,'WORKSPACE_REQUIRED','请先选择企业')
  const db = await this.pool.connect()
  try {
   await db.query('BEGIN')
   await db.query('SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE',[org])
   const available = (await db.query('SELECT organization_service_available($1::uuid) AS available',[org])).rows[0]
   const member = (await db.query('SELECT m.role FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND u.is_active FOR SHARE OF m,u',[org,actor])).rows[0]
   if (!member || !['owner','admin'].includes(member.role)) throw new HttpError(403,'WORKSPACE_ADMIN_REQUIRED','仅企业所有者或管理员可管理模拟订单')
   if (!available?.available) throw new HttpError(403,'WORKSPACE_SERVICE_UNAVAILABLE','企业当前不可使用模拟订单')
   const value = await work(db); await db.query('COMMIT'); return value
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
 }
 private async shadow(db: PoolClient, org: string) {
  await db.query('INSERT INTO billing_sandbox_entitlements(organization_id) VALUES($1) ON CONFLICT DO NOTHING',[org])
  return (await db.query('SELECT * FROM billing_sandbox_entitlements WHERE organization_id=$1 FOR UPDATE',[org])).rows[0]!
 }
 async read(actor: string, org: string, page = 1) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new HttpError(400,'INVALID_PAGE','页码无效')
  return this.transaction(actor,org,async db=> {
   const shadow = (await db.query('SELECT * FROM billing_sandbox_entitlements WHERE organization_id=$1',[org])).rows[0]
   const orders = await db.query('SELECT * FROM billing_sandbox_orders WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $2',[org,(page-1)*20])
   const total = (await db.query('SELECT count(*)::int AS n FROM billing_sandbox_orders WHERE organization_id=$1',[org])).rows[0].n
   const active = shadow?.active_order_id ? (await db.query('SELECT * FROM billing_sandbox_orders WHERE id=$1 AND organization_id=$2',[shadow.active_order_id,org])).rows[0] : undefined
   return {mode:'simulation',livePaymentEnabled:false,catalog:sandboxCatalog,page,pageSize:20,total,
    entitlement:{version:shadow?.version ?? 1,activeOrderId:shadow?.active_order_id ?? null,name:active?.product_name ?? null,
     seatLimit:active?.seat_limit ?? null,jobLimit:active?.job_limit ?? null,allModules:active?.all_modules ?? false,expiresAt:shadow?.expires_at ?? null,
     effective:!!shadow?.expires_at && new Date(shadow.expires_at).getTime()>Date.now()},orders:orders.rows.map(orderView)}
  })
 }
 async create(actor: string, org: string, input: any, key: string) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new HttpError(400,'INVALID_IDEMPOTENCY_KEY','需要有效订单操作标识')
  if (!input || typeof input!=='object' || Object.keys(input).some(k=>!['productCode','channel','expectedVersion'].includes(k))) throw new HttpError(400,'INVALID_ORDER','订单参数无效；金额由服务器决定')
  const channel=requireSimulationChannel(input.channel)
  if (typeof input.productCode!=='string' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<1) throw new HttpError(400,'INVALID_ORDER','模拟商品或权益版本无效')
  const fingerprint=digest([input.productCode,channel,input.expectedVersion])
  return this.transaction(actor,org,async db=> {
   const previous=(await db.query('SELECT * FROM billing_sandbox_orders WHERE organization_id=$1 AND actor_id=$2 AND idempotency_key=$3',[org,actor,key])).rows[0]
   if(previous) { if(previous.fingerprint!==fingerprint) throw new HttpError(409,'ORDER_KEY_CONFLICT','同一标识不能创建不同订单'); return orderView(previous) }
   // Retired products remain replayable, but cannot be purchased as new orders.
   const product = sandboxCatalog.find(p=>p.code===input.productCode)
   if(!product) throw new HttpError(400,'INVALID_ORDER','模拟商品无效或已下架')
   const shadow=await this.shadow(db,org)
   if(shadow.version!==input.expectedVersion) throw new HttpError(409,'VERSION_CONFLICT','模拟权益已变化，请刷新后创建订单')
   const row=(await db.query(
    'INSERT INTO billing_sandbox_orders(organization_id,actor_id,idempotency_key,fingerprint,product_code,plan_version_id,product_name,seat_limit,job_limit,amount_fen,currency,duration_days,channel,expected_version,duration_months,all_modules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
    [org,actor,key,fingerprint,product.code,product.planVersionId,product.name,product.seatLimit,product.jobLimit,product.amountFen,product.currency,product.durationDays,channel,input.expectedVersion,product.durationMonths,product.allModules])).rows[0]
   return orderView(row)
  })
 }
 /** Called only after enterprise authorization. Simulator creates the notification server-side. */
 async simulate(actor: string, org: string, orderId: string, kind: SimulationEventKind, reason = '') {
  return this.transaction(actor,org,async db=> {
   const order=await this.findOrder(db,org,orderId)
   if(!['success','failure','refund','expire','cancel'].includes(kind)) throw new HttpError(400,'INVALID_ACTION','模拟操作无效')
   if(kind==='expire' && new Date(order.expires_at).getTime()>Date.now()) throw new HttpError(409,'ORDER_NOT_EXPIRED','订单尚未超时')
   if(kind==='refund' && (typeof reason!=='string' || reason.trim().length<2 || reason.length>300)) throw new HttpError(400,'REFUND_REASON_REQUIRED','请填写 2–300 字的模拟退款原因')
   const event:SimulationPaymentEvent={eventId:'sandbox:'+order.id+':'+kind,orderId:order.id,organizationId:org,kind,
    channel:order.channel,transactionId:'sandbox-tx:'+order.id,amountFen:order.amount_fen,currency:order.currency,merchant:'smartrecruit-sandbox',reason:kind==='refund'?reason.trim():''}
   const signed=this.adapter.sign(event)
   return this.apply(db,actor,org,this.adapter.verify(signed.body,signed.signature))
  })
 }
 /** Trusted internal adapter seam. Never exposed as a public HTTP callback. */
 async acceptNotification(actor: string, org: string, body: string, signature: string) {
  const event=this.adapter.verify(body,signature)
  return this.transaction(actor,org,db=>this.apply(db,actor,org,event))
 }
 private async findOrder(db:PoolClient,org:string,id:string) {
  if(!uuid.test(id)) throw new HttpError(404,'ORDER_NOT_FOUND','未找到当前企业的模拟订单')
  const order=(await db.query('SELECT * FROM billing_sandbox_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE',[id,org])).rows[0]
  if(!order) throw new HttpError(404,'ORDER_NOT_FOUND','未找到当前企业的模拟订单')
  return order
 }
 private async apply(db:PoolClient,actor:string,org:string,event:SimulationPaymentEvent) {
  const order=await this.findOrder(db,org,event.orderId)
  if(event.organizationId!==org || event.channel!==order.channel || event.amountFen!==order.amount_fen || event.currency!==order.currency ||
    event.merchant!=='smartrecruit-sandbox' || event.transactionId!=='sandbox-tx:'+order.id || event.eventId!=='sandbox:'+order.id+':'+event.kind)
   throw new HttpError(409,'PAYMENT_EVENT_MISMATCH','模拟通知的订单、金额、币种或渠道不匹配')
  const fingerprint=digest(event)
  const prior=(await db.query('SELECT * FROM billing_sandbox_events WHERE event_id=$1',[event.eventId])).rows[0]
  if(prior) {
   if(prior.fingerprint!==fingerprint) throw new HttpError(409,'PAYMENT_EVENT_CONFLICT','同一模拟通知内容发生变化')
   return {order:orderView(order),outcome:prior.outcome,replayed:true}
  }
  const shadow=await this.shadow(db,org)
  let outcome='ignored',status=order.status
  if(event.kind==='success' && ['pending','failed','expired','cancelled'].includes(status)) {
   const late = ['expired','cancelled'].includes(status) || new Date(order.expires_at).getTime()<=Date.now()
   if(late || shadow.version!==order.expected_version) {status='review';outcome='review'}
   else {
    status='fulfilled';outcome='applied'
    await db.query("UPDATE billing_sandbox_entitlements SET version=version+1,active_order_id=$2,plan_version_id=$3,expires_at=CASE WHEN $5::integer IS NOT NULL THEN ((now() AT TIME ZONE 'Asia/Shanghai') + make_interval(months => $5::integer)) AT TIME ZONE 'Asia/Shanghai' ELSE now()+($4::integer * interval '1 day') END WHERE organization_id=$1",[org,order.id,order.plan_version_id,order.duration_days,order.duration_months])
   }
   await db.query('UPDATE billing_sandbox_orders SET paid_at=now(),transaction_id=$2 WHERE id=$1',[order.id,event.transactionId])
  } else if(event.kind==='failure' && status==='pending') {status='failed';outcome='applied'}
  else if((event.kind==='cancel'||event.kind==='expire') && ['pending','failed'].includes(status)) {
   if(event.kind==='expire' && new Date(order.expires_at).getTime()>Date.now()) throw new HttpError(409,'ORDER_NOT_EXPIRED','订单尚未超时')
   status=event.kind==='expire'?'expired':'cancelled';outcome='applied'
  } else if(event.kind==='refund') {
   if(!['fulfilled','review'].includes(status)) throw new HttpError(409,'ORDER_NOT_REFUNDABLE','仅已支付的模拟订单可退款')
   if(event.reason.trim().length<2||event.reason.length>300) throw new HttpError(400,'REFUND_REASON_REQUIRED','退款需要原因')
   if(shadow.active_order_id===order.id) await db.query('UPDATE billing_sandbox_entitlements SET version=version+1,active_order_id=NULL,plan_version_id=NULL,expires_at=NULL WHERE organization_id=$1',[org])
   status='refunded';outcome='applied'
   await db.query('UPDATE billing_sandbox_orders SET refunded_at=now() WHERE id=$1',[order.id])
  }
  const updated=(await db.query('UPDATE billing_sandbox_orders SET status=$2 WHERE id=$1 RETURNING *',[order.id,status])).rows[0]
  await db.query('INSERT INTO billing_sandbox_events(event_id,organization_id,order_id,actor_id,kind,fingerprint,payload,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[event.eventId,org,order.id,actor,event.kind,fingerprint,event,outcome])
  return {order:orderView(updated),outcome,replayed:false}
 }
}
