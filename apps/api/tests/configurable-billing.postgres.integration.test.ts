import { assertDisposableTestDatabase } from './helpers/disposable-database.js'
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {BillingStore,bindBillingEnv,meterAiOperation,meterInterviewAudio,createBillingFetch,readExecutionStatus} from '@smartrecruit-pro/enterprise-ai';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {WebSocket,WebSocketServer} from 'ws';
import {attachBilledStreamGateway} from '../src/interviews/billed-stream-gateway.js';
import {billedRecordingChunks} from '../src/interviews/billed-recording.js';
import {postgresPoolConfig} from '../src/recruiting/db-health.js';
import {Pool} from 'pg';
import {PaymentService} from '../src/payments/service.js';
import type {PaymentProvider} from '../src/payments/providers.js';

test('可配置计费：隔离数据库验证扣费、版本、试用、支付与退款',async t=>{
 assertDisposableTestDatabase();
 const pool=new Pool({...postgresPoolConfig(),max:10}),store=new BillingStore(pool),actor=randomUUID(),member=randomUUID(),outsider=randomUUID(),org=randomUUID(),other=randomUUID(),trial=randomUUID();
 const original=await store.policy();
 const env:NodeJS.ProcessEnv={PAYMENT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),PAYMENT_PUBLIC_BASE_URL:'https://recruit.example.com'};
 const adapter:PaymentProvider={create:async()=>({payURL:'https://pay.example.com/order',qrCode:null}),query:async no=>({outTradeNo:no,transactionId:'',amountFen:100,currency:'CNY',paid:false}),notification:async()=>null,close:async()=>{},refund:async()=>true,queryRefund:async()=>true};
 const service=new PaymentService(pool,()=>adapter,env);
 let config=structuredClone(original.config),version=original.version;
 const publish=async()=>{const r=await service.publishBillingPolicy(actor,{config,expectedVersion:version,reason:'隔离数据库计费验证'});version=r.version;return r};
 const balance=async (id=org,resource='ai_points')=>Number((await store.balance(id)).resources.find((r:any)=>r.resource===resource)?.available??0);
 const grant=async (units:number,resource='ai_points',id=org)=>service.grantBillingQuota(actor,{organizationId:id,key:randomUUID(),resource,units,expiresAt:new Date(Date.now()+10*86400000).toISOString(),reason:'隔离额度测试'});
 const reserve=(key:string,patch:Record<string,unknown>={})=>store.reserve({organizationId:org,operation:'resume_analysis',key,...patch});
 try{
  for(const id of [actor,member,outsider])await pool.query('INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,$3,true)',[id,id+'@billing.test','计费测试']);
  env.SYSTEM_ADMIN_USER_NO=String((await pool.query('SELECT user_no FROM users WHERE id=$1',[actor])).rows[0].user_no);
  for(const id of [org,other,trial])await pool.query("INSERT INTO organizations(id,name,kind) VALUES($1,'计费隔离企业','test')",[id]);
  await pool.query("UPDATE organizations SET service_status='enabled',trial_ends_at=NULL WHERE id=ANY($1::uuid[])",[[org,other]]);
  await pool.query("UPDATE organizations SET service_status='trial',trial_ends_at=now()+interval '7 days' WHERE id=$1",[trial]);
  await pool.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$4,'owner'),($1,$5,'member'),($2,$6,'member'),($3,$5,'member')",[org,other,trial,actor,member,outsider]);
  config.enabled=true;config.limits.maxConcurrent=2;config.limits.dailyAiPoints=1000;config.rules.resume_analysis={enabled:true,resource:'ai_points',quantity:7,unitSize:1};
  config.trial.aiPoints=40;config.trial.interviewSeconds=80;config.trial.ocrPages=0;await publish();
  await t.test('平台配置权限、版本冲突及企业隔离',async()=>{
   await assert.rejects(service.publishBillingPolicy(member,{config,expectedVersion:version,reason:'越权发布'}),{code:'SYSTEM_ADMIN_REQUIRED'});
   await assert.rejects(service.publishBillingPolicy(actor,{config,expectedVersion:'0',reason:'过期版本'}),{code:'VERSION_CONFLICT'});
   await assert.rejects(service.enterpriseBilling(outsider,org),{code:'WORKSPACE_MEMBER_REQUIRED'});
   const key=randomUUID(),input={organizationId:org,key,resource:'ai_points',units:50,expiresAt:new Date(Date.now()+86400000).toISOString(),reason:'幂等额度'};
   const first=await service.grantBillingQuota(actor,input),second=await service.grantBillingQuota(actor,input);assert.equal(first.id,second.id);
   await assert.rejects(service.grantBillingQuota(actor,{...input,units:51}),{code:'BILLING_KEY_CONFLICT'});
   assert.equal((await service.enterpriseBilling(member,org)).resources[0]!.available,'50');assert.equal(await balance(other),0);
  });
  await t.test('后台题目、右侧交互、音频和实时通道独立，未知结果不重复派发',async()=>{
   const saved=structuredClone(config),billingEnv=bindBillingEnv({},pool,org),session=randomUUID();
   config.enabled=false;config.rules.interview_questions.quantity=0;await publish();
   let release!:()=>void,started!:()=>void;
   const wait=new Promise<void>(r=>{release=r}),ready=new Promise<void>(r=>{started=r});
   const run=(key:string,action:()=>Promise<unknown>,channel:'background'|'interactive'='interactive')=>meterAiOperation(billingEnv,'interview_questions',key,{key},action,1,channel);
   const background=run('isolated-background',async()=>{started();await wait;return true},'background');
   try{
    await Promise.race([ready,background.then(()=>assert.fail('background did not start'))]);
    const status=await readExecutionStatus(pool,org,2);assert.equal(status.text.active,1);assert.equal(status.text.reservedInteractive,1);
    await assert.rejects(run('isolated-background-busy',async()=>assert.fail('must not dispatch'),'background'),{code:'AI_CHANNEL_BUSY'});
    assert.equal((await pool.query("SELECT count(*)::int n FROM billing_tasks WHERE organization_id=$1 AND request_key='isolated-background-busy'",[org])).rows[0].n,0);
    await run('isolated-interactive',async()=>{
     await meterInterviewAudio(billingEnv,'isolated-audio',{sessionId:session,startMs:0,endMs:1000},async()=>{
      await meterInterviewAudio(billingEnv,'isolated-realtime',{sessionId:randomUUID(),startMs:0,endMs:1000},async()=>true,'realtime');
      return true;
     });return true;
    });
   release();await background;
   let calls=0;
   await assert.rejects(run('isolated-unknown',async()=>{calls++;throw Error('provider unknown')},'background'));
   await assert.rejects(run('isolated-unknown',async()=>{calls++;return true},'background'),{code:'BILLING_TASK_EXISTS'});
   assert.equal(calls,1);
   const unknown=(await pool.query("SELECT id FROM billing_tasks WHERE organization_id=$1 AND request_key='isolated-unknown'",[org])).rows[0];
   await service.resolveBillingTask(actor,unknown.id,{state:'released',reason:'隔离测试确认未成功'});
   const locks=await pool.query('SELECT count(*)::int n FROM pg_locks WHERE locktype=\'advisory\' AND classid=$1 AND granted',[1397901641]);
   assert.equal(locks.rows[0].n,0);
   await assert.rejects(run('isolated-owner-death',async()=>{
    const fetch=createBillingFetch(billingEnv,async(_url,init)=>{
     const signal=init?.signal;assert.ok(signal);
     const aborted=new Promise<never>((_resolve,reject)=>{if(signal.aborted)reject(Error('owner lost'));else signal.addEventListener('abort',()=>reject(Error('owner lost')),{once:true})});
     const owner=(await pool.query("SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND granted LIMIT 1",[1397901641])).rows[0];
     assert.ok(owner);await pool.query('SELECT pg_terminate_backend($1)',[owner.pid]);
     return aborted;
    });
    return fetch('https://provider.invalid/test');
   },'background'),/owner lost/);
   assert.equal((await readExecutionStatus(pool,org,2)).text.active,0);
   await run('isolated-after-owner-death',async()=>true,'background');
   }finally{release();await Promise.allSettled([background]);config=saved;await publish()}
  });
  await t.test('并发不透支、同请求只预占一次、规则快照与失败重试',async()=>{
   const a=await reserve('test-first');assert.equal(a.units,7);
   await assert.rejects(reserve('test-first'),{code:'BILLING_TASK_EXISTS'});
   await assert.rejects(reserve('test-first',{fingerprint:'changed'}),{code:'BILLING_KEY_CONFLICT'});
   config.rules.resume_analysis.quantity=9;await publish();
   await store.finish(a.id!,'settled',{ok:true});assert.deepEqual(await reserve('test-first'),{replayed:true,result:{ok:true}});
   const b=await reserve('test-retry');assert.equal(b.units,9);await store.finish(b.id!,'released');
   const before=await balance();const retry=await reserve('test-retry');assert.notEqual(retry.id,b.id);assert.equal(await balance(),before-9);await store.finish(retry.id!,'released');
   const attempts=(await pool.query('SELECT attempt,state FROM billing_tasks WHERE organization_id=$1 AND request_key=$2 ORDER BY attempt',[org,'test-retry'])).rows;assert.deepEqual(attempts,[{attempt:1,state:'released'},{attempt:2,state:'released'}]);
   const concurrent=await Promise.allSettled([reserve('parallel-1'),reserve('parallel-2'),reserve('parallel-3')]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,2);
   assert.equal((concurrent.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'BILLING_CONCURRENCY_LIMIT');
   for(const r of concurrent)if(r.status==='fulfilled')await store.finish(r.value.id!,'released');
   const tooBig=await Promise.allSettled([reserve('test-too-big',{amount:100})]);assert.equal((tooBig[0] as PromiseRejectedResult).reason.code,'BILLING_QUOTA_EXHAUSTED');assert.equal(await balance(),before);
  });
  await t.test('明确失败退额，结果不确定人工核对，日上限动态生效',async()=>{
   const before=await balance();await assert.rejects(store.execute({organizationId:org,operation:'resume_analysis',key:'http-failed'},async()=>{throw Object.assign(Error('拒绝'),{code:'MODEL_HTTP_ERROR'})}));assert.equal(await balance(),before);
   await assert.rejects(store.execute({organizationId:org,operation:'resume_analysis',key:'uncertain'},async()=>{throw Error('网络断开')}));assert.equal(await balance(),before-9);
   const task=(await pool.query("SELECT id FROM billing_tasks WHERE organization_id=$1 AND request_key='uncertain'",[org])).rows[0];
   await assert.rejects(reserve('uncertain'),{code:'BILLING_TASK_EXISTS'});
   await assert.rejects(service.resolveBillingTask(member,task.id,{state:'released',reason:'越权退额'}),{code:'SYSTEM_ADMIN_REQUIRED'});
   await service.resolveBillingTask(actor,task.id,{state:'released',reason:'已核实未调用成功'});assert.equal(await balance(),before);
   await service.resolveBillingTask(actor,task.id,{state:'released',reason:'重复回调'});assert.equal(await balance(),before);
   config.limits.dailyAiPoints=7;await publish();await assert.rejects(reserve('day-limit'),{code:'BILLING_DAILY_LIMIT'});config.limits.dailyAiPoints=1000;await publish();
  });
  await t.test('待核对不占执行并发，但保留预占、日用量与重复派发保护',async()=>{
   const before=await balance();const ids:string[]=[];let dispatched=0;
   for(const key of ['uncertain-slot-1','uncertain-slot-2']){
    await assert.rejects(store.execute({organizationId:org,operation:'resume_analysis',key},async()=>{throw Object.assign(Error('无效模型结果'),{code:'MODEL_RESPONSE_INVALID'})}));
    const task=(await pool.query('SELECT * FROM billing_tasks WHERE organization_id=$1 AND request_key=$2',[org,key])).rows[0];ids.push(task.id);
    assert.equal(task.state,'uncertain');assert.notEqual(task.finished_at,null);
    await assert.rejects(store.execute({organizationId:org,operation:'resume_analysis',key},async()=>{dispatched++;return true}),{code:'BILLING_TASK_EXISTS'});
   }
   assert.equal(dispatched,0);assert.equal(await balance(),before-18);
   const held=(await store.balance(org)).resources.find((r:any)=>r.resource==='ai_points');assert.equal(held!.reserved,'18');
   const snapshot=(await pool.query('SELECT * FROM billing_tasks WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows;
   const concurrent=await Promise.allSettled([reserve('after-uncertain-1'),reserve('after-uncertain-2'),reserve('after-uncertain-3')]);
   assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,2);
   assert.equal((concurrent.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.code,'BILLING_CONCURRENCY_LIMIT');
   for(const r of concurrent)if(r.status==='fulfilled')await store.finish(r.value.id!,'released');
   assert.deepEqual((await pool.query('SELECT * FROM billing_tasks WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,snapshot);
   config.limits.dailyAiPoints=1;await publish();await assert.rejects(reserve('uncertain-daily-limit'),{code:'BILLING_DAILY_LIMIT'});
   config.limits.dailyAiPoints=1000;await publish();
   for(const id of ids)await service.resolveBillingTask(actor,id,{state:'released',reason:'隔离测试核对，恢复测试额度'});
   assert.equal(await balance(),before);
  });
  await t.test('关闭扣费仍限制并发及日用量，不消耗企业余额',async()=>{
   config.enabled=false;config.limits.maxConcurrent=1;config.limits.dailyAiPoints=9;await publish();const before=await balance(other);
   const input={organizationId:other,operation:'resume_analysis' as const,key:'unbilled-first'};
   const task=await store.reserve(input);assert.equal(task.units,0);
   await assert.rejects(store.reserve({...input,key:'unbilled-concurrent'}),{code:'BILLING_CONCURRENCY_LIMIT'});
   await store.finish(task.id!,'settled',{ok:true});
   await assert.rejects(store.reserve({...input,key:'unbilled-daily'}),{code:'BILLING_DAILY_LIMIT'});
   assert.equal(await balance(other),before);config.enabled=true;config.limits.maxConcurrent=2;config.limits.dailyAiPoints=1000;await publish();
  });
  await t.test('关闭扣费的零额度待核对任务也不阻塞后续执行',async()=>{
   config.enabled=false;await publish();const before=await balance(other),ids:string[]=[];
   const input={organizationId:other,operation:'resume_analysis' as const,key:'unbilled-uncertain-1'};
   for(const key of [input.key,'unbilled-uncertain-2']){
    const task=await store.reserve({...input,key});assert.equal(task.units,0);ids.push(task.id!);await store.finish(task.id!,'uncertain');
   }
   const next=await store.reserve({...input,key:'unbilled-after-uncertain'});assert.equal(next.units,0);await store.finish(next.id!,'released');
   await assert.rejects(store.reserve(input),{code:'BILLING_TASK_EXISTS'});assert.equal(await balance(other),before);
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM billing_tasks WHERE id=ANY($1::uuid[]) AND state='uncertain' AND units=0",[ids])).rows[0].n,2);
   for(const id of ids)await service.resolveBillingTask(actor,id,{state:'released',reason:'隔离测试核对零额度任务'});
   config.enabled=true;await publish();
  });
  await t.test('试用期限与容量由当前策略生成，旧企业不被覆盖',async()=>{
   config.trial.durationDays=21;config.trial.seatLimit=13;config.trial.jobLimit=88;await publish();const id=randomUUID();try{const created=(await pool.query("INSERT INTO organizations(id,name,kind,service_status) VALUES($1,'动态试用测试','test','trial') RETURNING trial_ends_at,plan_version_id",[id])).rows[0];assert(Math.abs(+created.trial_ends_at-Date.now()-21*86400000)<10000);const plan=(await pool.query('SELECT seat_limit,job_limit FROM subscription_plan_versions WHERE id=$1',[created.plan_version_id])).rows[0];assert.deepEqual(plan,{seat_limit:13,job_limit:88});config.trial.seatLimit=19;await publish();assert.equal((await pool.query('SELECT plan_version_id FROM organizations WHERE id=$1',[id])).rows[0].plan_version_id,created.plan_version_id)}finally{await pool.query('DELETE FROM organizations WHERE id=$1',[id])}
  });
  await t.test('试用资源仅首次发放，零额度也锁定发放记录',async()=>{
   const usage=await service.enterpriseBilling(member,trial);assert.equal(usage.resources.find((r:any)=>r.resource==='ai_points')!.available,'40');assert.equal(await balance(trial,'interview_seconds'),80);
   config.trial.aiPoints=70;config.trial.ocrPages=30;await publish();await service.enterpriseBilling(member,trial);assert.equal(await balance(trial),40);assert.equal(await balance(trial,'ocr_pages'),0);
   assert.equal((await pool.query('SELECT count(*)::int n FROM billing_trial_grants WHERE organization_id=$1',[trial])).rows[0].n,3);
  });
  await t.test('双音轨/重复音频按时间并集扣费，单场面试保留规则快照',async()=>{
   await grant(100,'interview_seconds');config.rules.interview_audio={enabled:true,resource:'interview_seconds',quantity:3,unitSize:2};await publish();
   const session=randomUUID();const audio=(key:string,startMs:number,endMs:number)=>store.reserve({organizationId:org,operation:'interview_audio',key,audio:{sessionId:session,startMs,endMs}});
   const first=await audio('test-mic-1',0,1000);assert.equal(first.units,3);await assert.rejects(audio('meeting-busy',0,1000),{code:'BILLING_AUDIO_BUSY'});await store.finish(first.id!,'settled',{ok:true});
   const dup=await audio('meeting-1',0,1000);assert.equal(dup.units,0);await store.finish(dup.id!,'settled',{ok:true});
   const partial=await audio('test-mic-2',500,2000);assert.equal(partial.units,0);await store.finish(partial.id!,'settled',{ok:true});
   config.rules.interview_audio.quantity=20;await publish();const next=await audio('test-mic-3',2000,3000);assert.equal(next.units,3);await store.finish(next.id!,'uncertain');
   const overlap=await audio('meeting-2',2000,3000);assert.equal(overlap.units,0);await store.finish(overlap.id!,'settled',{ok:true});assert.equal(await balance(org,'interview_seconds'),94);
   await assert.rejects(store.reserve({organizationId:other,operation:'interview_audio',key:'test-foreign',audio:{sessionId:session,startMs:0,endMs:1000}}),{code:'BILLING_KEY_CONFLICT'});
   await service.resolveBillingTask(actor,next.id!,{state:'settled',reason:'已核实该段转写完成'});
  });
  await t.test('离线转写共享音频时长、重放结果，额度不足不派发',async()=>{
   config.limits.maxConcurrent=1;config.rules.interview_audio={enabled:true,resource:'interview_seconds',quantity:1,unitSize:1};await publish();
   const session=randomUUID(),billingEnv=bindBillingEnv({},pool,org),meter=billedRecordingChunks(billingEnv,session,'funasr');
   const wav=Buffer.alloc(32008);wav.write('data');wav.writeUInt32LE(0xffffffff,4);
   const before=await balance(org,'interview_seconds');let calls=0;
   const action=async()=>{calls++;return [{id:'one',speakerId:'one',text:'离线结果',startMs:0,endMs:1000}]};
   const first=await meter(wav,0,action);assert.equal(calls,1);assert.equal(await balance(org,'interview_seconds'),before-1);
   assert.deepEqual(await meter(wav,0,action),first);assert.equal(calls,1);
   await billedRecordingChunks(billingEnv,session,'meeting')(wav,0,action);assert.equal(calls,2);assert.equal(await balance(org,'interview_seconds'),before-1);
   const foreign=billedRecordingChunks(bindBillingEnv({},pool,other),randomUUID(),'funasr');
   await assert.rejects(foreign(wav,0,action),{code:'BILLING_QUOTA_EXHAUSTED'});assert.equal(calls,2);
   await assert.rejects(meter(Buffer.from('invalid'),0,action),/时长无效/);assert.equal(calls,2);
  });
  await t.test('实时网关鉴权、音轨互斥、跨场并发、双轨去重与不足额拦截',async()=>{
   config.limits.maxConcurrent=1;await publish();
   const candidate=randomUUID(),job=randomUUID(),application=randomUUID(),interview=randomUUID(),session=randomUUID(),secondInterview=randomUUID(),secondSession=randomUUID();
   await pool.query("INSERT INTO candidates(id,organization_id,candidate_no,name) VALUES($1,$2,$3,'实时计费测试')",[candidate,org,'CAN-'+candidate]);
   await pool.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount) VALUES($1,$2,$3,'实时计费',1)",[job,org,'JOB-'+job]);
   await pool.query("INSERT INTO applications(id,organization_id,application_no,candidate_id,job_id,status) VALUES($1,$2,$3,$4,$5,'interviewing')",[application,org,'APP-'+application,candidate,job]);
   for(const [iid,sid] of [[interview,session],[secondInterview,secondSession]]){
    await pool.query("INSERT INTO interviews(id,organization_id,application_id,interview_no,round,type,title) VALUES($1,$2,$3,$4,1,'technical','测试')",[iid,org,application,'INT-'+iid]);
    await pool.query('INSERT INTO interview_live_sessions(id,interview_id,created_by) VALUES($1,$2,$3)',[sid,iid,member]);
   }
   const upstream=new WebSocketServer({port:0,host:'127.0.0.1'});await once(upstream,'listening');
   let bytes=0;upstream.on('connection',socket=>socket.on('message',(data,binary)=>{if(binary)bytes+=(data as Buffer).length;socket.send(JSON.stringify({ok:true}))}));
   const api=createServer();const clients:WebSocket[]=[];
   attachBilledStreamGateway(api,{appName:'test',appVersion:'test',host:'127.0.0.1',port:0,nodeEnv:'test',requestIdHeader:'x-request-id'},{pool,upstreamUrl:'ws://127.0.0.1:'+ (upstream.address() as {port:number}).port,
    authenticate:async context=>{if(context.req.headers['x-fixture-auth']==='member')context.auth={method:'session',sessionId:randomUUID(),user:{id:member,name:'测试成员',email:'test@billing.test',role:'recruiter',departmentId:'',workspaceId:org}}},
    resolveEnv:async id=>bindBillingEnv({},pool,id)});
   api.listen(0,'127.0.0.1');await once(api,'listening');
   const connect=(source:string,sid=session,auth=true,origin='http://localhost:5174')=>{
    const socket=new WebSocket('ws://127.0.0.1:'+(api.address() as {port:number}).port+'/funasr-stream?sessionId='+sid+'&source='+source,{origin,headers:auth?{'x-fixture-auth':'member'}:{}});clients.push(socket);return socket;
   };
   try{
    await assert.rejects(once(connect('microphone',session,false),'open'),/403/);
    await assert.rejects(once(connect('microphone',session,true,'https://invalid.example'),'open'),/403/);
    const mic=connect('microphone');await once(mic,'open');
    await assert.rejects(once(connect('microphone'),'open'),/403/);
    await assert.rejects(once(connect('microphone',secondSession),'open'),/403/);
    const meeting=connect('meeting');await once(meeting,'open');
    const before=await balance(org,'interview_seconds');
    const first=once(mic,'message');mic.send(Buffer.alloc(32000));await first;
    const duplicate=once(meeting,'message');meeting.send(Buffer.alloc(32000));await duplicate;
    assert.equal(bytes,64000);assert.equal(await balance(org,'interview_seconds'),before-1);
    await pool.query("UPDATE billing_grants SET remaining=0 WHERE organization_id=$1 AND resource='interview_seconds'",[org]);
    const rejected=once(mic,'message');mic.send(Buffer.alloc(32000));const [message]=await rejected;
    assert.equal(JSON.parse(String(message)).type,'billing_error');assert.match(JSON.parse(String(message)).message,/额度不足/);assert.equal(bytes,64000);
   }finally{
    for(const socket of clients)socket.terminate();for(const socket of upstream.clients)socket.terminate();
    await new Promise<void>(resolve=>api.close(()=>resolve()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));
    await pool.query('DELETE FROM interviews WHERE id=ANY($1::uuid[])',[[interview,secondInterview]]);await pool.query('DELETE FROM applications WHERE id=$1',[application]);await pool.query('DELETE FROM candidates WHERE id=$1',[candidate]);await pool.query('DELETE FROM jobs WHERE id=$1',[job]);
   }
  });
  await t.test('整场按分钟向上取整，分钟内分片、双轨与重转写不重复扣除',async()=>{
   await grant(600,'interview_seconds');config.rules.interview_audio={enabled:true,resource:'interview_seconds',quantity:60,unitSize:60};await publish();
   const session=randomUUID(),before=await balance(org,'interview_seconds');
   const audio=async(key:string,startMs:number,endMs:number,expected:number)=>{const ticket=await store.reserve({organizationId:org,operation:'interview_audio',key,audio:{sessionId:session,startMs,endMs}});assert.equal(ticket.units,expected);await store.finish(ticket.id!,'settled',{ok:true})};
   await audio('minute-first-ms',0,1,60);await audio('minute-first-second',1,1000,0);await audio('minute-to-59',1000,59000,0);await audio('minute-to-60',59000,60000,0);assert.equal(await balance(org,'interview_seconds'),before-60);
   await audio('minute-second-track',0,60000,0);await audio('minute-over-boundary',60000,60001,60);await audio('minute-to-61',60001,61000,0);await audio('minute-offline-replay',0,61000,0);assert.equal(await balance(org,'interview_seconds'),before-120);
   config.rules.interview_audio.quantity=120;await publish();await audio('minute-old-snapshot',61000,121000,60);assert.equal(await balance(org,'interview_seconds'),before-180);
   const fresh=await store.reserve({organizationId:org,operation:'interview_audio',key:'minute-new-session',audio:{sessionId:randomUUID(),startMs:0,endMs:1000}});assert.equal(fresh.units,120);await store.finish(fresh.id!,'released');assert.equal(await balance(org,'interview_seconds'),before-180);
  });
  await t.test('支付快照、按月发放、增购不改变容量期限，使用后禁止全额退款',async st=>{
   const provider=await service.addProvider(actor,{name:'计费假渠道',kind:'easypay',config:{apiBase:'https://pay.example.com',pid:'fixture',pkey:'fixture-secret'},reason:'假支付测试'});await service.toggleProvider(actor,provider.id,{enabled:true,reason:'隔离启用'});
   const purchase=async(product:any)=>{
    await service.toggleProduct(actor,product.id,{active:true,reason:'隔离上架'});const version=(await pool.query('SELECT entitlement_version FROM organizations WHERE id=$1',[org])).rows[0].entitlement_version;
    const order=await service.create(member,org,{productId:product.id,providerId:provider.id,method:'alipay',mode:'redirect',expectedVersion:version},randomUUID(),'203.0.113.10');
    const evidence={outTradeNo:order.outTradeNo,transactionId:'tx_'+order.id,amountFen:order.amountFen,currency:'CNY',paid:true};await service.settle(provider.id,evidence,'query');await service.settle(provider.id,evidence,'callback');return order;
   };
   const product=await service.publishProduct(actor,{seatLimit:17,jobLimit:123,name:'自定义计费测试',amountFen:18800,durationMonths:3,billingKind:'subscription',billingEntitlements:{quotas:{ai_points:30,interview_seconds:0,ocr_pages:4},grantPeriod:'monthly',rollover:false},reason:'自定义套餐'});
   const order=await purchase(product);const grants=(await pool.query("SELECT * FROM billing_grants WHERE order_id=$1 AND resource='ai_points' ORDER BY valid_from",[order.id])).rows;assert.equal(grants.length,3);assert(grants.every(r=>Number(r.total)===30));assert.equal(new Date(grants[0].expires_at).getTime(),new Date(grants[1].valid_from).getTime());
   const orgBefore=(await pool.query('SELECT * FROM organizations WHERE id=$1',[org])).rows[0];assert.equal(orgBefore.plan_version_id,product.planVersionId);
   const addon=await service.publishProduct(actor,{name:'独立额度增购',amountFen:100,durationDays:30,billingKind:'addon',billingEntitlements:{quotas:{ai_points:2,interview_seconds:0,ocr_pages:0},grantPeriod:'once',rollover:false},reason:'增购测试'});
   const added=await purchase(addon);const orgAfter=(await pool.query('SELECT * FROM organizations WHERE id=$1',[org])).rows[0];assert.equal(orgAfter.plan_version_id,orgBefore.plan_version_id);assert.equal(orgAfter.entitlement_version,orgBefore.entitlement_version);assert.equal(+orgAfter.paid_subscription_expires_at,+orgBefore.paid_subscription_expires_at);
   assert.equal((await service.read(member,org,added.id)).billingEntitlements.quotas.ai_points,2);assert.equal((await service.refund(actor,added.id,'未使用增购退款')).status,'refunded');
   const consume=await store.reserve({organizationId:org,operation:'ocr',key:'consume-purchased-pages',amount:1});await store.finish(consume.id!,'settled',{ok:true});
   await assert.rejects(service.refund(actor,order.id,'已使用订单退款'),{code:'BILLING_QUOTA_ALREADY_USED'});
   const rollover=await service.publishProduct(actor,{seatLimit:18,jobLimit:125,name:'按月结转测试',amountFen:18800,durationMonths:2,billingKind:'subscription',billingEntitlements:{quotas:{ai_points:10,interview_seconds:0,ocr_pages:0},grantPeriod:'monthly',rollover:true},reason:'结转测试'});
   const rolled=await purchase(rollover);const rows=(await pool.query('SELECT expires_at FROM billing_grants WHERE order_id=$1',[rolled.id])).rows;assert.equal(rows.length,2);assert.equal(+rows[0].expires_at,+rows[1].expires_at);
   await st.test('永久充值只到账一次，有限期优先扣除，明确失败退回原批次',async()=>{
    const permanent=await service.publishProduct(actor,{name:'长期算力充值',description:'长期保留的转写和 OCR 额度',sortOrder:7,amountFen:300,billingKind:'addon',billingEntitlements:{quotas:{ai_points:5,interview_seconds:120,ocr_pages:7},grantPeriod:'once',rollover:false},reason:'长期额度验收'});
    const paid=await purchase(permanent);const credits=(await pool.query('SELECT * FROM billing_grants WHERE order_id=$1',[paid.id])).rows;
    assert.equal(credits.length,3);assert(credits.every(g=>g.expires_at===null));assert.equal(paid.description,'长期保留的转写和 OCR 额度');
    const current=(await pool.query('SELECT * FROM organizations WHERE id=$1',[org])).rows[0];assert.equal(current.plan_version_id,rollover.planVersionId);
    const snapshot=await store.balance(org);assert.equal(snapshot.resources.find((r:any)=>r.resource==='ocr_pages')!.permanent,'7');
    config.rules.ocr={enabled:true,resource:'ocr_pages',quantity:1,unitSize:1};await publish();
    const finite=Number(snapshot.resources.find((r:any)=>r.resource==='ocr_pages')!.available)-7;
    const used=await store.reserve({organizationId:org,operation:'ocr',key:'finite-before-permanent',amount:finite+1});
    const task=(await pool.query('SELECT allocations FROM billing_tasks WHERE id=$1',[used.id])).rows[0];assert.equal(task.allocations.at(-1).id,credits.find(g=>g.resource==='ocr_pages').id);assert.equal(task.allocations.at(-1).units,1);
    await store.finish(used.id!,'released');assert.equal(await balance(org,'ocr_pages'),finite+7);
    const expiry=current.paid_subscription_expires_at;
    await pool.query("UPDATE organizations SET paid_subscription_expires_at=now()-interval '1 second' WHERE id=$1",[org]);
    assert.equal(await balance(org,'ocr_pages'),finite+7);await assert.rejects(reserve('expired-service'),{code:'WORKSPACE_SERVICE_UNAVAILABLE'});
    await pool.query('UPDATE organizations SET paid_subscription_expires_at=$2 WHERE id=$1',[org,expiry]);
    const resumed=await reserve('resumed-service');await store.finish(resumed.id!,'released');
    await service.refund(actor,paid.id,'未使用长期充值退款');assert.equal((await pool.query('SELECT count(*)::int n FROM billing_grants WHERE order_id=$1 AND revoked_at IS NULL',[paid.id])).rows[0].n,0);
   });
   await st.test('历史余额先预览再转换，保留原订单和余额，拒绝越权与旧预览',async()=>{
    const legacy=await purchase(addon);
    await assert.rejects(service.previewCreditConversion(member,legacy.id),{code:'SYSTEM_ADMIN_REQUIRED'});
    const first=await service.previewCreditConversion(actor,legacy.id);assert.equal(first.grants.filter(g=>!g.blockedReason).length,1);
    await pool.query('UPDATE billing_grants SET remaining=remaining-1 WHERE order_id=$1',[legacy.id]);
    await assert.rejects(service.convertCredits(actor,{orderId:legacy.id,expectedDigest:first.digest,reason:'过期预览不能转换'}),{code:'VERSION_CONFLICT'});
    const fresh=await service.previewCreditConversion(actor,legacy.id);
    await service.convertCredits(actor,{orderId:legacy.id,expectedDigest:fresh.digest,reason:'按已核实剩额转换长期'});
    const g=(await pool.query('SELECT g.expires_at,g.remaining::text,c.remaining_at_conversion::text,c.previous_expires_at FROM billing_grants g JOIN billing_grant_conversions c ON c.grant_id=g.id WHERE g.order_id=$1',[legacy.id])).rows[0];
    assert.equal(g.expires_at,null);assert.equal(g.remaining,'1');assert.equal(g.remaining_at_conversion,'1');assert(g.previous_expires_at);
    assert.equal((await service.read(member,org,legacy.id)).durationDays,30);
    const converted=await service.previewCreditConversion(actor,legacy.id);await assert.rejects(service.convertCredits(actor,{orderId:legacy.id,expectedDigest:converted.digest,reason:'不允许重复转换'}),{code:'NO_CONVERTIBLE_CREDITS'});
   });
  });
 }finally{
  await pool.query('INSERT INTO billing_policy_versions(config,reason) VALUES($1,$2)',[JSON.stringify(original.config),'恢复隔离验证前配置']);
  const ids=[org,other,trial];
  await pool.query('DELETE FROM billing_grant_conversions WHERE order_id IN(SELECT id FROM payment_orders WHERE organization_id=ANY($1::uuid[]))',[ids]);
  for(const table of ['billing_tasks','billing_stream_sources','billing_audio_sessions','billing_trial_grants','billing_grants'])await pool.query('DELETE FROM '+table+' WHERE organization_id=ANY($1::uuid[])',[ids]);
  await pool.query('DELETE FROM payment_events WHERE order_id IN(SELECT id FROM payment_orders WHERE organization_id=ANY($1::uuid[]))',[ids]);
  await pool.query('UPDATE organizations SET active_payment_order_id=NULL WHERE id=ANY($1::uuid[])',[ids]);
  await pool.query('DELETE FROM payment_orders WHERE organization_id=ANY($1::uuid[])',[ids]);
  await pool.query('DELETE FROM payment_products WHERE created_by=$1',[actor]);await pool.query('DELETE FROM payment_providers WHERE created_by=$1',[actor]);
  await pool.query('DELETE FROM platform_audit_logs WHERE actor_user_id=$1 OR organization_id=ANY($2::uuid[])',[actor,ids]);
  await pool.query('DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])',[ids]);await pool.query('DELETE FROM organizations WHERE id=ANY($1::uuid[])',[ids]);
  // Immutable policy versions retain their publishing actor as an audit record in this isolated database.
  await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[member,outsider]]);await pool.end();
 }
});
