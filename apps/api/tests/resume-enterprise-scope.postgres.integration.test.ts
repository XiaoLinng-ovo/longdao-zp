import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository, RepositoryNotFoundError } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryClient, RepositoryPool } from '../src/recruiting/repositories/types.js'

test('resume, task and result inherit persisted enterprise; foreign parents and reads are rejected', async (t) => {
  if (shouldSkipPostgresIntegration()) { t.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  let sequence = 0
  const savepoints: string[] = []
  const query: RepositoryClient['query'] = async (sql, values = []) => {
    let statement = sql
    if (sql === 'BEGIN') { const name = `resume_scope_${++sequence}`; savepoints.push(name); statement = `SAVEPOINT ${name}` }
    else if (sql === 'COMMIT') statement = `RELEASE SAVEPOINT ${savepoints.pop()!}`
    else if (sql === 'ROLLBACK') statement = `ROLLBACK TO SAVEPOINT ${savepoints.pop()!}`
    return await client.query(statement, [...values]) as never
  }
  const adapter: RepositoryPool = { query, async connect() { return { query, release() {} } }, async end() {} }
  const orgA = randomUUID(), orgB = randomUUID()
  const parents: Array<{ org: string; candidate: string; job: string; app: string }> = []
  const repoA = new NormalizedRecruitingRepository(adapter, { organizationId: orgA }), repoB = repoA.withOrganization(orgB)
  const notFound = (error: unknown) => error instanceof RepositoryNotFoundError
  await client.query('BEGIN')
  try {
    for (const org of [orgA, orgB]) {
      const candidate = randomUUID(), job = randomUUID(), app = randomUUID()
      await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'Resume scope rollback fixture','test')", [org])
      await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'Fixture')", [candidate,org,`CAN-${candidate}`])
      await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'Fixture',1)", [job,org,`JOB-${job}`])
      await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'human_review')", [app,org,`APP-${app}`,candidate,job])
      parents.push({org,candidate,job,app})
    }
    const a = parents[0]!, b = parents[1]!
    const upload = { storageKey: `fixture/${randomUUID()}`, originalFilename:'fixture.txt', mimeType:'text/plain',sizeBytes:7,contentHash:randomUUID(),scanStatus:'clean' }
    const resumeA = await repoA.createResume({...upload,candidateId:a.candidate,applicationId:a.app})
    assert.equal((await client.query('SELECT organization_id FROM resumes WHERE id=$1',[resumeA.id])).rows[0].organization_id,orgA)
    const resumeB = await repoB.createResume({...upload,storageKey:randomUUID(),contentHash:randomUUID(),candidateId:b.candidate,applicationId:b.app})
    await assert.rejects(repoA.createResume({...upload,storageKey:randomUUID(),candidateId:b.candidate}),notFound)
    await assert.rejects(repoA.createResume({...upload,storageKey:randomUUID(),candidateId:a.candidate,applicationId:b.app}),notFound)
    await assert.rejects(repoA.getResume(resumeB.id),notFound)
    assert.deepEqual((await repoA.listResumes()).map(r=>r.id),[resumeA.id])
    const noApp = await repoA.createResume({...upload,storageKey:randomUUID(),contentHash:randomUUID(),candidateId:a.candidate})
    const noAppTask = await repoA.createAnalysisTask({resumeId:noApp.id,idempotencyKey:randomUUID()})
    assert.equal((await client.query('SELECT organization_id FROM analysis_tasks WHERE id=$1',[noAppTask.id])).rows[0].organization_id,orgA)
    const noAppResult = await repoA.createAnalysisResult({analysisTaskId:noAppTask.id,resumeId:noApp.id,result:{fixture:true}})
    assert.equal((await client.query('SELECT organization_id FROM analysis_results WHERE id=$1',[noAppResult.id])).rows[0].organization_id,orgA)
    // Trusted internal unscoped callers must also derive ownership from persisted parents.
    const internal=new NormalizedRecruitingRepository(adapter)
    const internalResume=await internal.createResume({...upload,storageKey:randomUUID(),contentHash:randomUUID(),candidateId:a.candidate})
    const internalTask=await internal.createAnalysisTask({resumeId:internalResume.id,idempotencyKey:randomUUID()})
    const internalResult=await internal.createAnalysisResult({analysisTaskId:internalTask.id,resumeId:internalResume.id,result:{fixture:true}})
    for(const [table,id] of [['resumes',internalResume.id],['analysis_tasks',internalTask.id],['analysis_results',internalResult.id]])assert.equal((await client.query('SELECT organization_id FROM '+table+' WHERE id=$1',[id])).rows[0].organization_id,orgA)
    const taskA = await repoA.createAnalysisTask({resumeId:resumeA.id,applicationId:a.app,idempotencyKey:randomUUID()})
    const taskB = await repoB.createAnalysisTask({resumeId:resumeB.id,applicationId:b.app,idempotencyKey:randomUUID()})
    assert.equal((await client.query('SELECT organization_id FROM analysis_tasks WHERE id=$1',[taskA.id])).rows[0].organization_id,orgA)
    await assert.rejects(repoA.createAnalysisTask({resumeId:resumeB.id,applicationId:b.app,idempotencyKey:randomUUID()}),notFound)
    await assert.rejects(repoA.createAnalysisTask({resumeId:resumeA.id,applicationId:b.app,idempotencyKey:randomUUID()}),notFound)
    await assert.rejects(repoA.getAnalysisTask(taskB.id),notFound)
    await assert.rejects(repoA.updateAnalysisTask(taskB.id,{status:'failed'}),notFound)
    assert.ok((await repoA.listAnalysisTasks()).every(task=>[taskA.id,noAppTask.id,internalTask.id].includes(task.id)))
    const resultA = await repoA.createAnalysisResult({analysisTaskId:taskA.id,resumeId:resumeA.id,applicationId:a.app,result:{fixture:true}})
    const resultB = await repoB.createAnalysisResult({analysisTaskId:taskB.id,resumeId:resumeB.id,applicationId:b.app,result:{fixture:true}})
    assert.equal((await client.query('SELECT organization_id FROM analysis_results WHERE id=$1',[resultA.id])).rows[0].organization_id,orgA)
    await assert.rejects(repoA.createAnalysisResult({analysisTaskId:taskB.id,resumeId:resumeB.id,applicationId:b.app,result:{fixture:true}}),notFound)
    await assert.rejects(repoA.createAnalysisResult({analysisTaskId:taskA.id,resumeId:resumeB.id,applicationId:a.app,result:{fixture:true}}),notFound)
    await assert.rejects(repoA.getAnalysisResult(resultB.id),notFound)
    await assert.rejects(repoA.getAnalysisResultByTask(taskB.id),notFound)
    await assert.rejects(repoA.reviewAnalysisResult(resultB.id,'approved',{}),notFound)
    assert.deepEqual(new Set((await repoA.listAnalysisResults()).map(result=>result.id)),new Set([resultA.id,noAppResult.id,internalResult.id]))
  } finally { await client.query('ROLLBACK');client.release();await pool.end() }
})

