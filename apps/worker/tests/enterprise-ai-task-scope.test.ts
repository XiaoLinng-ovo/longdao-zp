import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { EnterpriseAiError } from '@smartrecruit-pro/enterprise-ai'
import { resolvePersistedEnterpriseAiEnv } from '../src/handlers/enterprise-ai-task-scope.js'
import { createTask } from '../src/task.js'
import type { ResumeAnalysisTaskPayload } from '../src/handlers/resume-analysis.js'
const task=createTask<'resume-analysis',ResumeAnalysisTaskPayload>({type:'resume-analysis',maxAttempts:3,idempotencyKey:'scope',payload:{resumeId:'resume-a',applicationId:'application-a',fileName:'fixture.txt',text:'fixture'}})
// Simulate a malicious extra payload field. The persisted relationship, not this value, determines configuration.
Object.assign(task.payload,{organizationId:'attacker-tenant'})
const input={task,content:{fileName:'fixture.txt',text:'fixture'},context:{taskId:task.id,attempt:1,maxAttempts:3,idempotencyKey:'scope',now:()=> '2026-10-12'}}
test('worker resolver uses persisted task, resume, candidate, application and job scope',async()=>{
  let actualSql='',actualValues: unknown[]=[]
  const pool={query:async(sql:string,values:unknown[])=>{actualSql=sql;actualValues=values;return {rows:[{organization_id:'persisted-tenant'}]}}} as unknown as Pick<Pool,'query'>
  const result=await resolvePersistedEnterpriseAiEnv(pool,{runtimeEnv:async id=>{assert.equal(id,'persisted-tenant');return {OPENAI_MODEL:'persisted-model'}}},input)
  assert.deepEqual(actualValues,[task.id,'resume-a','application-a']);assert.ok(!actualValues.includes('attacker-tenant'))
  for (const parent of ['r','c','a','j']) assert.match(actualSql,new RegExp(`${parent}\\.organization_id = t\\.organization_id`))
  assert.match(actualSql,/organization_service_available\(t\.organization_id\)/)
  assert.match(actualSql,/a.candidate_id = r.candidate_id/);assert.equal(result.OPENAI_MODEL,'persisted-model')
})
test('worker scope mismatch fails closed, not a process-global fallback',async()=>{
  const pool={query:async()=>({rows:[]})} as unknown as Pick<Pool,'query'>
  let calls = 0
  await assert.rejects(resolvePersistedEnterpriseAiEnv(pool,{runtimeEnv:async()=>{calls++;return {}}},input), (error: unknown) => {
    assert.ok(error instanceof EnterpriseAiError)
    assert.equal(error.code, 'ANALYSIS_WORKSPACE_MISMATCH')
    assert.match(error.message, /企业归属不一致/u)
    assert.doesNotMatch(error.message, /请先选择/u)
    return true
  })
  assert.equal(calls, 0)
})
