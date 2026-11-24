import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EnterpriseAiError } from '@smartrecruit-pro/enterprise-ai'
import { createEnterpriseResumeAnalyzer } from '../src/handlers/enterprise-resume-analyzer.js'
import { createResumeAnalysisHandler, type ResumeAnalysisTaskPayload } from '../src/handlers/resume-analysis.js'
import { createTask } from '../src/task.js'
import { classifyFailure } from '../src/errors.js'
const makeTask=(id: string, extra: Partial<ResumeAnalysisTaskPayload>={})=>createTask<'resume-analysis',ResumeAnalysisTaskPayload>({type:'resume-analysis',maxAttempts:3,idempotencyKey:id,payload:{resumeId:id,fileName:'resume.txt',text:'五年 TypeScript 开发经验',source:'test',...extra}})
const context={taskId:'task',attempt:1,maxAttempts:3,idempotencyKey:'test',now:()=> '2026-10-12T00:00:00.000Z'}
test('concurrent enterprise tasks use distinct keys and models, never process-global credentials', async t => {
  const calls: Array<{key:string|null;model:string;redirect:RequestRedirect|undefined}>=[]
  t.mock.method(globalThis,'fetch',async (_input: unknown,init?: RequestInit)=>{
    calls.push({key:new Headers(init?.headers).get('authorization'),model:JSON.parse(String(init?.body)).model,redirect:init?.redirect})
    return new Response('unavailable',{status:502})
  })
  const handler=createResumeAnalysisHandler({analyze:createEnterpriseResumeAnalyzer(async input=>({OPENAI_BASE_URL:'https://tenant.example/v1',OPENAI_API_KEY:`key-${input.task.payload.resumeId}`,OPENAI_MODEL:`model-${input.task.payload.resumeId}`}))})
  const results=await Promise.allSettled([handler(makeTask('A',{jobRequirements:['TypeScript']}),context),handler(makeTask('B',{jobRequirements:['TypeScript']}),context)])
  assert.ok(results.every(x=>x.status==='rejected'))
  assert.deepEqual(calls.map(x=>x.key).sort(),['Bearer key-A','Bearer key-B'])
  assert.deepEqual(calls.map(x=>x.model).sort(),['model-A','model-B']);assert.ok(calls.every(x=>x.redirect==='error'))
})
test('no AI config uses safe basic extraction, including already-resolved file content, without network calls', async t => {
  t.mock.method(globalThis,'fetch',()=>{throw new Error('must not call global provider')})
  const task=makeTask('basic',{storageKey:'fixture.txt'});delete task.payload.text
  const handler=createResumeAnalysisHandler({loadText:async()=>({fileName:'fixture.txt',text:'五年 TypeScript 开发经验'}),analyze:createEnterpriseResumeAnalyzer(async()=>({}))})
  const result=await handler(task,context)
  assert.equal(result.status,'completed');assert.notEqual(result.analysis.engine,'llm-suggestion');assert.equal(result.safety.autoHire,false)
})
test('semantic job scoring cannot silently fall back when tenant AI is missing', async()=> {
  const handler=createResumeAnalysisHandler({analyze:createEnterpriseResumeAnalyzer(async()=>({}))})
  await assert.rejects(handler(makeTask('semantic',{jobRequirements:['TypeScript']}),context),{code:'ENTERPRISE_AI_NOT_CONFIGURED'})
})
test('decryption failure fails closed and is not retried as a global provider call',async()=>{
  const handler=createResumeAnalysisHandler({analyze:createEnterpriseResumeAnalyzer(async()=>{throw new EnterpriseAiError('AI_SECRET_DECRYPTION_FAILED','安全错误',503)})})
  try {await handler(makeTask('broken'),context);assert.fail('expected rejection')} catch(error) {
    const failure=classifyFailure(error);assert.equal(failure.code,'AI_SECRET_DECRYPTION_FAILED');assert.equal(failure.retryable,false)
  }
})
