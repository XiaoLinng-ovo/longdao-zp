import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBill, csvRows, billFiles } from "./bill-format.js";
import { AlipayBills, compareBill, validateBillDate, shanghaiDay } from "./bills.js";
import { randomUUID, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { encryptConfig } from "./security.js";
import { alipayBillURL } from "./providers.js";
import { zipFixture, billFixture, header } from "../../tests/helpers/alipay-bill.js";
test("bill ZIP parser handles business CSV comments, quoted commas/newlines and signed refund amounts exactly",()=>{
  const entries=parseBill(billFixture());
  assert.deepEqual(entries,[{outTradeNo:"order",transactionId:"ali",type:"payment",amountFen:29901,refundId:""},{outTradeNo:"order",transactionId:"ali",type:"refund",amountFen:29901,refundId:"refund"}]);
  assert.deepEqual(csvRows('"a,b","c""d"\r\nx,y'),[["a,b",'c"d'],['x','y']]);
  assert.throws(()=>csvRows('"unterminated'));
});
test("bill ZIP parser supports the GBK filenames and CSV returned by the merchant bill interface",()=>{
  const name=Buffer.from('d2b5cef1c3f7cfb82e637376','hex'); // 业务明细.csv, GBK
  const chineseHeader=Buffer.from('d6a7b8b6b1a6bdbbd2d7bac52cc9ccbba7b6a9b5a5bac52cd2b5cef1c0e0d0cd2cb6a9b5a5bdf0b6eea3a8d4aaa3a92ccdcbbfeec5fab4cebac52fc7ebc7f3bac5','hex');
  const csv=Buffer.concat([chineseHeader,Buffer.from('\r\nali,order,'),Buffer.from('bdbbd2d7','hex'),Buffer.from(',1.01,\r\n')]);
  const entries=parseBill(zipFixture(csv,name,0));assert.equal(entries[0]?.amountFen,101);
});
test("bill parser rejects malformed headers, duplicates, empty refund IDs, invalid decimals, corruption and ZIP bombs",()=>{
  for(const row of ['ali,order,交易,1.001,,x','ali,order,退款,-1.00,,x','ali,order,其他,1.00,,x','ali,order,交易,1.00,,x\nali,order,交易,1.00,,x'])assert.throws(()=>parseBill(zipFixture(Buffer.from(header+'\n'+row))));
  assert.throws(()=>parseBill(zipFixture(Buffer.from('unexpected\na,b'))));
  const bad=billFixture();bad[35]=bad[35]!^1;assert.throws(()=>parseBill(bad));
  const bomb=billFixture(),c=bomb.indexOf(Buffer.from('504b0102','hex'));bomb.writeUInt32LE(100*1024*1024,c+24);assert.throws(()=>billFiles(bomb));
});
test("reconciliation reports both sides and ties refunds to their exact request, amount and transaction",()=>{
  const orders=[{id:'id',out_trade_no:'order',transaction_id:'ali',amount_fen:29901,status:'refunded',paid_at:'2026-11-09T10:00:00Z',refunded_at:'2026-11-09T11:00:00Z',refund_id:'refund'}];
  assert.equal(compareBill(parseBill(billFixture()),orders,'2026-11-09').differenceCount,0);
  assert.equal(compareBill([],orders,'2026-11-09').differenceCount,2);
  assert.equal(compareBill(parseBill(billFixture()),[],'2026-11-09').differenceCount,2);
  const wrong=[{...orders[0],amount_fen:1}];assert.equal(compareBill(parseBill(billFixture()),wrong,'2026-11-09').differences[0]?.type,'amount_mismatch');
  assert.equal(compareBill(parseBill(billFixture()),[{...orders[0],status:'refund_pending'}],'2026-11-09').differences[0]?.type,'refund_not_recorded');
  const entries=parseBill(billFixture());entries[1]!.refundId='another';assert.equal(compareBill(entries,orders,'2026-11-09').differenceCount,2);
});
test("bill date and download guards reject current dates, invalid days and nonofficial URLs",()=>{
  assert.equal(shanghaiDay(Date.parse('2026-11-09T16:00:00Z')),'2026-11-10');
  for(const date of [shanghaiDay(),'2026-02-30','2000-01-01','tomorrow'])assert.throws(()=>validateBillDate(date));
  for(const u of ['https://evil.example/downloadBillFile.resource','https://dwbillcenter.alipay.com.evil.example/downloadBillFile.resource','https://u:p@dwbillcenter.alipay.com/downloadBillFile.resource','http://127.0.0.1/downloadBillFile.resource','https://dwbillcenter.alipay.com/other'])assert.throws(()=>alipayBillURL(u));
  assert.equal(alipayBillURL('http://dwbillcenter.alipay.com/downloadBillFile.resource?token=fixture'),'https://dwbillcenter.alipay.com/downloadBillFile.resource?token=fixture');
});

test("bill sweep respects Shanghai cutoff, retry delays, merchant deduplication and per-cycle budget",async t=>{
  const now=Date.parse('2026-11-10T02:00:00Z');
  t.mock.method(Date,'now',()=>now);
  const env:NodeJS.ProcessEnv={PAYMENT_ENCRYPTION_KEY:randomBytes(32).toString('base64')};
  const provider=(sellerId:string)=>{const id=randomUUID();return {id,config_ciphertext:encryptConfig({sellerId},id,env)};};
  const providers=[provider('same'),provider('same'),provider('other')];
  let queryCount=0;
  const priors=new Map<string,any>();
  const pool={query:async(sql:string,args?:string[])=>{queryCount++;return {rows:sql.includes('FROM public.payment_providers')?providers:priors.has(args![0]+':'+args![1])?[priors.get(args![0]+':'+args![1])]:[]};}} as unknown as Pool;
  const bills=new AlipayBills(pool,env), calls:string[][]=[];
  bills.run=async(id,date)=>{calls.push([id,date]);return undefined;};
  env.PAYMENT_BILL_AUTO_ENABLED='false';await bills.sweep();assert.equal(queryCount,0);
  delete env.PAYMENT_BILL_AUTO_ENABLED;
  t.mock.method(Date,'now',()=>now-1);await bills.sweep();assert.equal(queryCount,0);
  t.mock.method(Date,'now',()=>now);
  priors.set(providers[0]!.id+':2026-11-09',{status:'succeeded'});
  priors.set(providers[0]!.id+':2026-11-08',{status:'not_ready',next_retry_at:new Date(now+3600000)});
  await bills.sweep();assert.deepEqual(calls,[[providers[0]!.id,'2026-11-07'],[providers[0]!.id,'2026-11-06']]);
  calls.length=0;
  for(let ago=1;ago<=7;ago++)priors.set(providers[0]!.id+':'+shanghaiDay(now-ago*86400000),{status:'differences'});
  await bills.sweep();assert.deepEqual(calls,[[providers[2]!.id,'2026-11-09'],[providers[2]!.id,'2026-11-08']]);
});
