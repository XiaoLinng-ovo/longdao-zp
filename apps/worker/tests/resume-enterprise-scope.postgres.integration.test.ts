import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { PostgresAnalysisTaskStore, PostgresIdempotencyStore, type PgClient } from '../src/db/analysis-task-store.js'
import { resolvePersistedEnterpriseAiEnv } from '../src/handlers/enterprise-ai-task-scope.js'
import { createTask } from '../src/task.js'
import type { ResumeAnalysisTaskPayload } from '../src/handlers/resume-analysis.js'

const skip = !process.env.DATABASE_URL?.trim() || ['true', '1'].includes(process.env.POSTGRES_INTEGRATION_SKIP ?? '')
test('persisted worker scope and completion keep enterprise ownership, including resume-only tasks', {skip}, async () => {
  const pool = new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000})
  const client = await pool.connect(), org = randomUUID(), foreign = randomUUID(), candidate = randomUUID(), job = randomUUID(), app = randomUUID()
  const query: PgClient['query'] = async (sql, values = []) => {
    const statement = sql === 'BEGIN' ? 'SAVEPOINT worker_completion' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT worker_completion' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT worker_completion' : sql
    return await client.query(statement, values) as never
  }
  const store = new PostgresAnalysisTaskStore({async connect(){return {query,release(){}}}})
  const resolverPool = {query} as unknown as Pick<Pool,'query'>
  await client.query('BEGIN')
  try {
    for (const id of [org,foreign]) await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'Worker scope rollback fixture','test')",[id])
    await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'Fixture')",[candidate,org,'CAN-'+candidate])
    await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'Fixture',1)",[job,org,'JOB-'+job])
    await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'human_review')",[app,org,'APP-'+app,candidate,job])
    for(const applicationId of [app, null]) {
      const resume = randomUUID(), taskId = randomUUID()
      await client.query("INSERT INTO resumes (id,organization_id,candidate_id,storage_key,original_filename,mime_type,size_bytes,scan_status,content_hash) VALUES ($1,$2,$3,$4,'fixture.txt','text/plain',7,'clean',$5)",[resume,org,candidate,resume,randomUUID()])
      await client.query("INSERT INTO analysis_tasks (id,organization_id,resume_id,application_id,status,attempts,idempotency_key) VALUES ($1,$2,$3,$4,'processing',1,$5)",[taskId,org,resume,applicationId,taskId])
      const task = createTask<'resume-analysis',ResumeAnalysisTaskPayload>({id:taskId,type:'resume-analysis',maxAttempts:3,idempotencyKey:taskId,payload:{resumeId:resume,...(applicationId?{applicationId}:{}),fileName:'fixture.txt',text:'fixture'}})
      Object.assign(task.payload,{organizationId:foreign})
      const input = {task,content:{fileName:'fixture.txt',text:'fixture'},context:{taskId,attempt:1,maxAttempts:3,idempotencyKey:taskId,now:()=>new Date().toISOString()}}
      let calls = 0
      const env = await resolvePersistedEnterpriseAiEnv(resolverPool,{async runtimeEnv(id){calls++;assert.equal(id,org);return {OPENAI_MODEL:'fixture'}}},input)
      assert.equal(env.OPENAI_MODEL,'fixture');assert.equal(calls,1)
      await store.completeTask({taskId,attempt:1,result:{fixture:true}})
      assert.ok(await new PostgresIdempotencyStore(store).get(taskId))
      const saved = (await client.query('SELECT organization_id,status FROM analysis_tasks WHERE id=$1',[taskId])).rows[0]
      assert.equal(saved.status,'completed');assert.equal(saved.organization_id,org)
      assert.equal((await client.query('SELECT organization_id FROM analysis_results WHERE analysis_task_id=$1',[taskId])).rows[0].organization_id,org)
      await client.query("UPDATE analysis_tasks SET organization_id=$2,status='processing' WHERE id=$1",[taskId,foreign])
      calls=0
      await assert.rejects(resolvePersistedEnterpriseAiEnv(resolverPool,{async runtimeEnv(){calls++;return {}}},input),{code:'ANALYSIS_WORKSPACE_MISMATCH'})
      assert.equal(calls,0)
      assert.equal(await new PostgresIdempotencyStore(store).get(taskId),undefined)
      await assert.rejects(store.completeTask({taskId,attempt:1,result:{fixture:true}}),/could not be stored/u)
      await client.query("UPDATE analysis_tasks SET status='completed' WHERE id=$1",[taskId])
      await assert.rejects(store.completeTask({taskId,attempt:1,result:{fixture:true}}),/has no result/u)
    }
  }finally{await client.query('ROLLBACK');client.release();await pool.end()}
})
