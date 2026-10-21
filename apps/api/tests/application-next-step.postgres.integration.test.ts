import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository, RepositoryNotFoundError } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryClient, RepositoryPool } from '../src/recruiting/repositories/types.js'
import { RecruitingWorkflowError } from '../src/recruiting/workflow.js'
import { resumeScoreSummary } from '../src/recruiting/resume-scoring.js'
import { RecruitingService } from '../src/recruiting/service.js'

const manualDecisions = [
  ...[0, 27, 79.99, 80, 88].map(aiScore => ({ aiScore, decision: 'passed' as const })),
  ...[80, 88, 100].map(aiScore => ({ aiScore, decision: 'eliminated' as const })),
]
for (const { aiScore, decision: reviewDecision } of manualDecisions) {
test(`PostgreSQL AI score ${aiScore} can be manually ${reviewDecision}; preserves scores and enterprise scope`, async (context) => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  // All fixtures and repository writes stay on this connection and roll back.
  let queryQueue: Promise<void> = Promise.resolve()
  const query: RepositoryClient['query'] = async (sql, values = []) => {
    const statement = sql === 'BEGIN' ? 'SAVEPOINT interview_repository_test'
      : sql === 'COMMIT' ? 'RELEASE SAVEPOINT interview_repository_test'
        : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT interview_repository_test' : sql
    const pending = queryQueue.then(() => client.query(statement, [...values]))
    queryQueue = pending.then(() => undefined, () => undefined)
    const result = await pending
    return { rows: result.rows }
  }
  const executor: RepositoryClient = { query, release() {} }
  const repositoryPool: RepositoryPool = { query, async connect() { return executor }, async end() {} }
  const orgA = randomUUID(), orgB = randomUUID(), actor = randomUUID(), candidateId = randomUUID(), jobId = randomUUID()
  const applicationId = randomUUID(), resumeId = randomUUID(), taskId = randomUUID(), resultId = randomUUID()
  const repository = new NormalizedRecruitingRepository(repositoryPool, { organizationId: orgA })
  const service = new RecruitingService(undefined, undefined, undefined, repository)
  await client.query('BEGIN')
  try {
    await client.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'application-next-step-test', 'test'), ($2, 'application-next-step-other', 'test')", [orgA, orgB])
    await client.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, '流程测试面试官')", [actor, `${actor}@example.invalid`])
    await client.query('INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)', [orgA, actor])
    await client.query("INSERT INTO candidates (id, organization_id, candidate_no, name) VALUES ($1, $2, $3, '流程测试候选人')", [candidateId, orgA, `CAN-${candidateId}`.toUpperCase()])
    await client.query("INSERT INTO jobs (id, organization_id, job_no, title, headcount) VALUES ($1, $2, $3, '流程测试岗位', 1)", [jobId, orgA, `JOB-${jobId}`.toUpperCase()])
    await client.query("INSERT INTO applications (id, organization_id, application_no, candidate_id, job_id, status) VALUES ($1, $2, $3, $4, $5, 'human_review')", [applicationId, orgA, `APP-${applicationId}`.toUpperCase(), candidateId, jobId])
    await client.query("INSERT INTO resumes (id, candidate_id, application_id, storage_key, original_filename, mime_type, size_bytes, scan_status, organization_id) VALUES ($1, $2, $3, $4, 'fixture.txt', 'text/plain', 1, 'clean', $5)", [resumeId, candidateId, applicationId, `test/${resumeId}`, orgA])
    await client.query("INSERT INTO analysis_tasks (id, resume_id, application_id, status, idempotency_key, completed_at, organization_id) VALUES ($1, $2, $3, 'completed', $4, now(), $5)", [taskId, resumeId, applicationId, `test/${taskId}`, orgA])
    await client.query('INSERT INTO analysis_results (id, analysis_task_id, resume_id, application_id, result, organization_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [resultId, taskId, resumeId, applicationId, JSON.stringify({ assessment: { score: aiScore } }), orgA])
    const passed = await service.updateResumeReview(resultId, { decision: reviewDecision }, actor)
    const summary = resumeScoreSummary(resultId, passed.result)
    assert.equal(summary.aiScore, aiScore); assert.equal(summary.humanScore, undefined); assert.equal(summary.finalScore, aiScore)
    const decision = passed.result.humanDecision as { reason: string; decidedBy: string }
    assert.equal(decision.decidedBy, actor)
    if (reviewDecision === 'eliminated') {
      assert.match(decision.reason, /AI 建议通过，人工确认淘汰/)
      assert.equal(summary.decision, 'eliminated')
      assert.deepEqual(passed.result.assessment, { score: aiScore })
      assert.equal((passed.result.humanDecision as { stage: string }).stage, 'rejected')
      assert.equal((await repository.getApplication(applicationId)).status, 'rejected')
      assert.equal((await repository.listInterviews(applicationId)).length, 0)
      const otherService = new RecruitingService(undefined, undefined, undefined, repository.withOrganization(orgB))
      await assert.rejects(otherService.updateResumeReview(resultId, { decision: 'passed' }, actor), (error: unknown) => error instanceof RepositoryNotFoundError)
      return
    }
    if (aiScore < 80) assert.match(decision.reason, /人工确认通过/)
    assert.deepEqual(passed.result.assessment, { score: aiScore })
    assert.equal((passed.result.humanDecision as { stage: string }).stage, 'initial_interview')
    assert.equal(summary.decision, 'passed'); assert.equal((await repository.getApplication(applicationId)).status, 'interviewing')
    const before = (await client.query('SELECT result FROM analysis_results WHERE id=$1', [resultId])).rows[0].result
    await assert.rejects(service.createApplication({ candidateId, jobId }, actor), (error: unknown) => {
      assert.ok(error instanceof RecruitingWorkflowError)
      assert.equal(error.code, 'APPLICATION_ALREADY_EXISTS'); assert.equal(error.status, 409)
      assert.match(error.message, /安排面试/); return true
    })
    assert.deepEqual((await client.query('SELECT result FROM analysis_results WHERE id=$1', [resultId])).rows[0].result, before)
    assert.equal((await repository.getApplication(applicationId)).status, 'interviewing')
    assert.equal((await repository.listApplications(candidateId)).length, 1)
    const interview = await service.createInterview({ applicationId, title: '评分通过后的首轮面试', participants: [{ userId: actor, role: 'interviewer', required: true }] }, actor)
    assert.equal(interview.applicationId, applicationId)
    assert.equal((await service.getInterview(interview.id)).status, 'scheduled')
    assert.equal((await repository.listApplications(candidateId)).length, 1)
    assert.deepEqual((await client.query('SELECT result FROM analysis_results WHERE id=$1', [resultId])).rows[0].result, before)
    const listedCandidate = (await service.listCandidates()).find(row => row.id === candidateId)
    assert.ok(listedCandidate, 'Passed candidate remains in the enterprise directory')
    assert.equal(listedCandidate.applications[0]?.resumeReview?.finalScore, aiScore)
    const otherService = new RecruitingService(undefined, undefined, undefined, repository.withOrganization(orgB))
    await assert.rejects(otherService.createInterview({ applicationId, title: '跨企业禁止', participants: [{ userId: actor, role: 'interviewer' }] }, actor), (error: unknown) => error instanceof RepositoryNotFoundError)
    assert.equal((await repository.listInterviews(applicationId)).length, 1)
  } finally {
    await client.query('ROLLBACK'); client.release(); await pool.end()
  }
})
}
