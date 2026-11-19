import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'
import { PostgresPreparationRepository } from '../src/interviews/question-preparation-repository.js'
import { generateLocalInterviewQuestions } from '../src/interviews/question-generator.js'

test('PostgreSQL invitation queue, lease recovery, checkpoints and overwrite protection', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  const f = { org: randomUUID(), user: randomUUID(), candidate: randomUUID(), job: randomUUID(), app: randomUUID() }
  let interviewId = ''
  const query = (sql: string, values: readonly unknown[] = []) => {
    // Keep claims strictly inside this rollback-only fixture, never touch real pending work.
    if (sql.startsWith('WITH next AS')) sql = sql.replace("WHERE i.status = 'scheduled'", "WHERE p.interview_id = '" + interviewId + "'::uuid AND i.status = 'scheduled'")
    return client.query(sql === 'BEGIN' ? 'SAVEPOINT preparation_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT preparation_test'
      : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT preparation_test' : sql, [...values])
  }
  const executor = { query, release() {} }
  const fixturePool = { query, async connect() { return executor } }
  await client.query('BEGIN')
  try {
    await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'preparation-test','test')", [f.org])
    await client.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'preparation-test')", [f.user, f.user + '@example.invalid'])
    await client.query('INSERT INTO organization_members (organization_id,user_id) VALUES ($1,$2)', [f.org, f.user])
    await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'preparation-test')", [f.candidate, f.org, 'CAN-' + f.candidate])
    await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'preparation-test',1)", [f.job, f.org, 'JOB-' + f.job])
    await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'interviewing')", [f.app, f.org, 'APP-' + f.app, f.candidate, f.job])
    const recruiting = new NormalizedRecruitingRepository(fixturePool as unknown as RepositoryPool, { organizationId: f.org })
    const interview = await recruiting.createInterview({ applicationId: f.app, title: '初试', round: 1, createdBy: f.user })
    interviewId = interview.id
    const jobs = new PostgresPreparationRepository(fixturePool as unknown as Pool)
    assert.equal((await jobs.get(interview.id))?.status, 'queued')
    await jobs.enqueue(interview.id, f.user, true)
    assert.equal((await client.query('SELECT count(*)::int AS count FROM interview_question_preparations WHERE interview_id=$1', [interview.id])).rows[0].count, 1)
    const first = (await jobs.claim())!
    assert.equal(first.status, 'generating'); assert.equal(await jobs.claim(), null)
    first.inputHash = 'hash-v1'
    const bank = generateLocalInterviewQuestions({ jobTitle: '岗位', jobRequirements: ['项目'], anonymizedResume: '负责招聘系统项目', analysisSummary: [], questionCount: 10, includeCommonQuestions: true })
    first.completedGroups.ai = bank.questions.filter(q => q.group === 'ai')
    assert.equal(await jobs.checkpoint(first), true)
    await client.query("UPDATE interview_question_preparations SET lease_until=now()-interval '1 minute' WHERE interview_id=$1", [interview.id])
    const recovered = (await jobs.claim())!
    assert.notEqual(recovered.claimToken, first.claimToken)
    assert.equal(recovered.completedGroups.ai?.length, 10)
    assert.equal(await jobs.checkpoint(first), false)
    assert.equal(await jobs.complete(first, bank.questions), false)
    const diagnostic = { stage: 'question_generation' as const, group: 'hr' as const, code: 'MODEL_HTTP_ERROR', diagnosticId: randomUUID(), httpStatus: 429, retryable: true }
    await jobs.fail(recovered, 'HR题组生成失败：HTTP 429', false, diagnostic)
    assert.deepEqual((await jobs.get(interview.id))?.failure, diagnostic)
    assert.deepEqual((await jobs.list([interview.id])).get(interview.id)?.failure, diagnostic)
    await jobs.enqueue(interview.id, f.user, true)
    assert.equal((await jobs.get(interview.id))?.failure, undefined)
    assert.equal((await jobs.get(interview.id))?.completedGroups.ai?.length, 10)
    const retried = (await jobs.claim())!
    // Simulate an explicit manual regeneration completing while the background task ran.
    const manual = [{ ...bank.questions[0]!, question: '保留人工调整后的题目' }]
    await client.query("INSERT INTO interview_resume_question_sets (interview_id,generated_by,engine,questions) VALUES ($1,$2,'llm',$3::jsonb)", [interview.id, f.user, JSON.stringify(manual)])
    assert.equal(await jobs.complete(retried, bank.questions), true)
    const saved = (await client.query('SELECT questions FROM interview_resume_question_sets WHERE interview_id=$1', [interview.id])).rows[0].questions
    assert.equal(saved[0].question, manual[0]!.question); assert.equal(saved.length, 1)
    assert.equal((await jobs.list([interview.id])).get(interview.id)?.status, 'ready')
    await jobs.enqueue(interview.id, f.user, true)
    assert.equal(await jobs.claim(), null)
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end() }
})
