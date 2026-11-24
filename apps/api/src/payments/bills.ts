import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import { HttpError } from "../http.js";
import { decryptConfig, uuid, type MerchantConfig } from "./security.js";
import { createProvider, downloadAlipayBill, type PaymentProvider } from "./providers.js";
import { parseBill, type BillEntry } from "./bill-format.js";
type Row=Record<string,any>;
export interface BillDifference { type:string; outTradeNo:string; transactionId?:string; refundId?:string; expectedFen?:number; actualFen?:number; localStatus?:string }
export function compareBill(entries:BillEntry[],orders:Row[],date:string) {
  const byNo=new Map(orders.map(o=>[o.out_trade_no,o]));
  const seenPayment=new Set<string>(),seenRefund=new Set<string>();
  const differences:BillDifference[]=[];
  let count=0;
  const add=(d:BillDifference)=>{count++;if(differences.length<500)differences.push(d);};
  for(const e of entries) {
    const o=byNo.get(e.outTradeNo), base={outTradeNo:e.outTradeNo,transactionId:e.transactionId,refundId:e.refundId,actualFen:e.amountFen};
    if(!o) {add({type:"bill_only",...base});continue;}
    if(e.type==="payment")seenPayment.add(o.id);else if(e.refundId===o.refund_id)seenRefund.add(o.id);
    if(o.amount_fen!==e.amountFen) add({type:"amount_mismatch",...base,expectedFen:o.amount_fen});
    else if(o.transaction_id && o.transaction_id!==e.transactionId) add({type:"transaction_mismatch",...base});
    else if(e.type==="payment" && !o.paid_at) add({type:"payment_not_recorded",...base,localStatus:o.status});
    else if(e.type==="refund" && (o.refund_id!==e.refundId || o.status!=="refunded")) add({type:"refund_not_recorded",...base,localStatus:o.status});
  }
  const day=(v:unknown)=>v ? new Date(new Date(v as string).getTime()+8*3600000).toISOString().slice(0,10):null;
  for(const o of orders) {
    if(day(o.paid_at)===date && !seenPayment.has(o.id))add({type:"local_payment_only",outTradeNo:o.out_trade_no,expectedFen:o.amount_fen});
    if(day(o.refunded_at)===date && !seenRefund.has(o.id))add({type:"local_refund_only",outTradeNo:o.out_trade_no,refundId:o.refund_id,expectedFen:o.amount_fen});
  }
  return {differences,differenceCount:count};
}
export const shanghaiDay=(now=Date.now())=>new Date(now+8*3600000).toISOString().slice(0,10);
export function validateBillDate(value:unknown) {
  if(typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value || value>=shanghaiDay() || Date.now()-Date.parse(value)>366*86400000)
    throw new HttpError(400,"PAYMENT_BILL_DATE_INVALID","账单日期须为过去一年内已结束的日期（北京时间）");
  return value;
}
export class AlipayBills {
  constructor(private pool:Pool, private env:NodeJS.ProcessEnv=process.env,
    private factory:(kind:"alipay",config:MerchantConfig)=>PaymentProvider=createProvider,
    private download:(url:string)=>Promise<Buffer>=downloadAlipayBill) {}
  async list() {
    return (await this.pool.query(
      `SELECT b.id,b.provider_id AS "providerId",p.name AS "providerName",p.environment,b.bill_date::text AS "billDate",b.status,b.attempts,b.started_at AS "startedAt",b.completed_at AS "completedAt",b.next_retry_at AS "nextRetryAt",b.file_sha256 AS "fileSha256",b.entry_count AS "entryCount",b.difference_count AS "differenceCount",b.differences,b.error_code AS "errorCode" FROM public.payment_bill_runs b JOIN public.payment_providers p ON p.id=b.provider_id ORDER BY b.bill_date DESC,b.started_at DESC LIMIT 100`
    )).rows;
  }
  async run(providerId:string,date:string,manual=false) {
    uuid(providerId);validateBillDate(date);
    const db=await this.pool.connect();
    const lock="alipay-bill:"+providerId+":"+date;
    let held=false;
    try {
      held=(await db.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",[lock])).rows[0].locked;
      if(!held)throw new HttpError(409,"PAYMENT_BILL_RUNNING","该账单正在对账，请稍后查看");
      const p=(await db.query("SELECT * FROM public.payment_providers WHERE id=$1 AND kind='alipay'",[providerId])).rows[0];
      if(!p)throw new HttpError(404,"PAYMENT_PROVIDER_NOT_FOUND","支付宝渠道不存在");
      const previous=(await db.query("SELECT * FROM public.payment_bill_runs WHERE provider_id=$1 AND bill_date=$2",[providerId,date])).rows[0];
      if(!manual && previous && (["succeeded","differences"].includes(previous.status) || new Date(previous.next_retry_at).getTime()>Date.now()))return;
      const run=(await db.query("INSERT INTO public.payment_bill_runs(id,provider_id,bill_date,status) VALUES($1,$2,$3,'running') ON CONFLICT(provider_id,bill_date) DO UPDATE SET status='running',attempts=payment_bill_runs.attempts+1,started_at=now(),completed_at=NULL,error_code=NULL,file_sha256=NULL,entry_count=0,difference_count=0,differences='[]'::jsonb RETURNING id",[randomUUID(),providerId,date])).rows[0];
      try {
        const cfg=decryptConfig(p.config_ciphertext,p.id,this.env);
        if((cfg.environment??"production")!==p.environment)throw new HttpError(503,"PAYMENT_CONFIG_INVALID","渠道环境不一致");
        if(p.environment==='sandbox')throw new HttpError(409,"PAYMENT_BILL_SANDBOX_UNSUPPORTED","沙箱不用于正式账单对账，请使用正式渠道");
        const api=this.factory("alipay",cfg);
        if(!api.billURL)throw new Error("missing bill API");
        const zip=await this.download(await api.billURL(date)), entries=parseBill(zip);
        // A merchant bill may include multiple applications/configuration versions. Match only the same seller and environment.
        const peers=(await db.query("SELECT * FROM public.payment_providers WHERE kind='alipay' AND environment=$1",[p.environment])).rows;
        const ids=peers.filter(v=>decryptConfig(v.config_ciphertext,v.id,this.env).sellerId===cfg.sellerId).map(v=>v.id);
        const numbers=entries.map(e=>e.outTradeNo);
        const orders=(await db.query("SELECT id,out_trade_no,transaction_id,amount_fen,status,paid_at,refunded_at,refund_id FROM public.payment_orders WHERE provider_id=ANY($1::uuid[]) AND (out_trade_no=ANY($2::text[]) OR (paid_at >= $3::date::timestamp AT TIME ZONE 'Asia/Shanghai' AND paid_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') OR (refunded_at >= $3::date::timestamp AT TIME ZONE 'Asia/Shanghai' AND refunded_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))",[ids,numbers,date])).rows;
        const compared=compareBill(entries,orders,date);
        await db.query("UPDATE public.payment_bill_runs SET status=$2,completed_at=now(),file_sha256=$3,entry_count=$4,difference_count=$5,differences=$6 WHERE id=$1",[run.id,compared.differenceCount?'differences':'succeeded',createHash('sha256').update(zip).digest('hex'),entries.length,compared.differenceCount,JSON.stringify(compared.differences)]);
      } catch(e) {
        const code=e instanceof HttpError?e.code:"PAYMENT_BILL_FAILED";
        await db.query("UPDATE public.payment_bill_runs SET status=$2,completed_at=now(),next_retry_at=now()+interval '1 hour',error_code=$3 WHERE id=$1",[run.id,code==='PAYMENT_BILL_NOT_READY'?'not_ready':'failed',code]);
      }
      return run.id;
    } finally {
      try { if(held)await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lock]); }
      finally { db.release(); }
    }
  }
  async sweep() {
    if(this.env.PAYMENT_BILL_AUTO_ENABLED==='false')return;
    // Run at 10:00 China time, leaving a buffer after the normal next-morning bill generation window.
    const hour=Number(new Date(Date.now()+8*3600000).toISOString().slice(11,13));
    if(hour<10)return;
    const providers=(await this.pool.query("SELECT * FROM public.payment_providers WHERE kind='alipay' AND environment='production' AND (enabled OR EXISTS(SELECT 1 FROM public.payment_orders o WHERE o.provider_id=payment_providers.id AND (o.created_at>now()-interval '8 days' OR o.refunded_at>now()-interval '8 days'))) ORDER BY created_at DESC")).rows;
    const sellers=new Set<string>();let budget=2;
    for(const p of providers) {
      let cfg:MerchantConfig;
      try{cfg=decryptConfig(p.config_ciphertext,p.id,this.env);}catch{continue;}
      if(sellers.has(cfg.sellerId!))continue;sellers.add(cfg.sellerId!);
      for(let ago=1;ago<=7 && budget>0;ago++) {
        const date=shanghaiDay(Date.now()-ago*86400000);
        const prior=(await this.pool.query("SELECT status,next_retry_at FROM public.payment_bill_runs WHERE provider_id=$1 AND bill_date=$2",[p.id,date])).rows[0];
        if(prior && (["succeeded","differences"].includes(prior.status)||new Date(prior.next_retry_at).getTime()>Date.now()))continue;
        budget--;try{await this.run(p.id,date);}catch{/* Another instance may hold the claim. */}
      }
      if(budget<=0)break;
    }
  }
}
