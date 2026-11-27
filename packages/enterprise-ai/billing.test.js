import assert from 'node:assert/strict'
import {test} from 'node:test'
import {BillingStore,validateBillingPolicy,validateBillingEntitlements,billedUnits,coveredMilliseconds,bindBillingEnv,createBillingFetch,BILLING_OPERATIONS} from './billing.js'
const config=()=>({enabled:true,rules:Object.fromEntries(BILLING_OPERATIONS.map(k=>[k,{enabled:true,resource:'ai_points',quantity:5,unitSize:1}])),limits:{maxConcurrent:2,dailyAiPoints:1000,maxInputChars:100,maxOutputTokens:32},trial:{durationDays:14,seatLimit:5,jobLimit:20,resumeUploads:3,interviews:3,aiGenerations:3,aiPoints:100,interviewSeconds:5400,ocrPages:30}})
test('后台业务规则完整校验，拒绝未知参数及无效数值',()=>{
 const value=config();assert.deepEqual(validateBillingPolicy(value),value);value.trial.resumeUploads=0;assert.equal(validateBillingPolicy(value).trial.resumeUploads,0)
 for(const bad of [{...config(),extra:true},{...config(),limits:{...config().limits,maxConcurrent:0}},{...config(),trial:{...config().trial,aiPoints:-1}}]) assert.throws(()=>validateBillingPolicy(bad),{code:'VALIDATION_ERROR'})
 const bad=config();bad.rules.ocr.unitSize=0;assert.throws(()=>validateBillingPolicy(bad));bad.rules.ocr.unitSize=1;bad.rules.ocr.quantity=NaN;assert.throws(()=>validateBillingPolicy(bad))
})
test('商品额度允许自定义并拒绝负数与未知发放周期',()=>{
 const rights={quotas:{ai_points:123,interview_seconds:456,ocr_pages:78},grantPeriod:'monthly',rollover:true};assert.deepEqual(validateBillingEntitlements(rights),rights)
 assert.throws(()=>validateBillingEntitlements({...rights,grantPeriod:'daily'}));assert.throws(()=>validateBillingEntitlements({...rights,quotas:{...rights.quotas,ai_points:-1}}))
})
test('秒数与页数按单位向上取整，停用规则不扣费',()=>{
 assert.equal(billedUnits({enabled:true,unitSize:60,quantity:2},61),4);assert.equal(billedUnits({enabled:false,unitSize:1,quantity:100},1),0);assert.throws(()=>billedUnits({enabled:true,unitSize:1,quantity:1e9},1e9))
})
test('音频区间并集合并双音轨和后台重复覆盖',()=>{
 assert.equal(coveredMilliseconds([[0,1000],[0,1000],[500,1500],[3000,3500]]),2000)
 assert.equal(coveredMilliseconds([[3000,4000],[0,5000],[2000,2500]]),5000);assert.equal(coveredMilliseconds([]),0)
})
test('模型请求使用平台输入输出限制，超限不调用服务商',async()=>{
 const policy=config();const env=bindBillingEnv({}, {query:async()=>({rows:[{id:'1',config:policy}]})}, 'org')
 let calls=0,body;const request=createBillingFetch(env,async(_url,init)=>{calls++;body=JSON.parse(init.body);return new Response('{}')})
 await request('https://fixture.invalid',{body:JSON.stringify({messages:[{content:'hello'}],max_tokens:500})});assert.equal(body.max_tokens,32)
 await assert.rejects(request('https://fixture.invalid',{body:JSON.stringify({messages:[{content:'x'.repeat(101)}]})}),{code:'BILLING_INPUT_LIMIT'});assert.equal(calls,1)
})
test('明确拒绝退额，未知结果保留预占，结算失败不重复派发',async()=>{
 for(const [code,expected] of [['MODEL_HTTP_ERROR','released'],['OCR_HTTP_ERROR','released'],['ASR_HTTP_ERROR','released'],['BILLING_INPUT_LIMIT','released'],['NETWORK','uncertain'],['MODEL_RESPONSE_INVALID','uncertain']]){
  const store=new BillingStore({});let state;store.reserve=async()=>({id:'id',config:config()});store.finish=async(_id,s)=>{state=s};await assert.rejects(store.execute({},async()=>{throw Object.assign(new Error('fixture'),{code})}));assert.equal(state,expected)
 }
 const store=new BillingStore({});let states=[];store.reserve=async()=>({id:'id',config:config()});store.finish=async(_id,s)=>{states.push(s);if(s==='settled')throw Error('db lost')};await assert.rejects(store.execute({},async()=>true));assert.deepEqual(states,['settled','uncertain'])
})
test('成功重放不会再次调用模型，运行中保持规则快照',async()=>{
 const store=new BillingStore({});store.reserve=async()=>({replayed:true,result:{saved:1}});assert.deepEqual(await store.execute({},()=>{throw Error('duplicate')}),{saved:1})
 const first=config(),latest=config();latest.limits.maxOutputTokens=100;const env=bindBillingEnv({}, {query:async()=>({rows:[{id:'2',config:latest}]})},'org');let body
 const request=createBillingFetch(env,async(_u,i)=>{body=JSON.parse(i.body);return new Response('{}')});store.reserve=async()=>({config:first});store.finish=async()=>{};await store.execute({},()=>request('https://fixture.invalid',{body:JSON.stringify({messages:[]})}));assert.equal(body.max_completion_tokens,32)
})

test('一分钟计费覆盖零、整分及越界，同一分钟分片累计只扣一次',()=>{
 const rule={enabled:true,unitSize:60,quantity:60};
 const charge=ranges=>{const seconds=Math.ceil(coveredMilliseconds(ranges)/1000);return seconds?billedUnits(rule,seconds):0};
 assert.equal(charge([]),0);
 for(const [milliseconds,expected] of [[1,60],[1000,60],[59000,60],[60000,60],[60001,120],[61000,120],[120000,120]])assert.equal(charge([[0,milliseconds]]),expected);
 assert.equal(charge([[0,1000],[1000,59000],[59000,60000],[0,60000],[0,60000]]),60);
});
test('关闭扣费仍保留平台输入输出限制',async()=>{
 const policy=config();policy.enabled=false;const env=bindBillingEnv({}, {query:async()=>({rows:[{id:'1',config:policy}]})}, 'org');let calls=0;
 const request=createBillingFetch(env,async(_url,init)=>{calls++;assert.equal(JSON.parse(init.body).max_completion_tokens,32);return new Response('{}')});
 await request('https://fixture.invalid',{body:JSON.stringify({messages:[],max_completion_tokens:999})});
 await assert.rejects(request('https://fixture.invalid',{body:JSON.stringify({messages:[{content:'x'.repeat(101)}]})}),{code:'BILLING_INPUT_LIMIT'});assert.equal(calls,1);
});
test('双输出参数和无效上限不能绕过平台成本保护',async()=>{
 const policy=config(),env=bindBillingEnv({}, {query:async()=>({rows:[{id:'1',config:policy}]})},'org');let body;
 const request=createBillingFetch(env,async(_url,init)=>{body=JSON.parse(init.body);return new Response('{}')});
 for(const patch of [{max_tokens:999,max_completion_tokens:888},{max_tokens:-1,max_completion_tokens:'unlimited'},{max_tokens:null,max_completion_tokens:0}]){
  await request('https://fixture.invalid',{body:JSON.stringify({messages:[],...patch})});assert.equal(body.max_tokens,32);assert.equal(body.max_completion_tokens,32);
 }
});
