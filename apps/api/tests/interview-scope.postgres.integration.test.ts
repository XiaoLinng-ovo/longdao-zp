import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository, RepositoryNotFoundError } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryClient, RepositoryPool } from '../src/recruiting/repositories/types.js'
import { RecruitingService } from '../src/recruiting/service.js'

test('PostgreSQL interviews and feedback remain in their enterprise throughout the interview workflow', async (context) => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  // All fixtures and repository writes stay on this connection and roll back.
  let queryQueue: Promise<void> = Promise.resolve()
  let rejectScheduleAudit = false
  const query: RepositoryClient['query'] = async (sql, values = []) => {
    if (rejectScheduleAudit && sql.includes('INSERT INTO workflow_events')) throw new Error('simulated audit failure')
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
  const orgA = randomUUID(), orgB = randomUUID(), userA = randomUUID(), userB = randomUUID()
  const appA = randomUUID(), appB = randomUUID()
  const repoA = new NormalizedRecruitingRepository(repositoryPool, { organizationId: orgA })
  const repoB = repoA.withOrganization(orgB)
  const serviceA = new RecruitingService(undefined, undefined, undefined, repoA)
  const serviceB = new RecruitingService(undefined, undefined, undefined, repoB)
  const notFound = (error: unknown) => error instanceof RepositoryNotFoundError
  await client.query('BEGIN')
  try {
    for (const [org, user, app] of [[orgA, userA, appA], [orgB, userB, appB]]) {
      const candidate = randomUUID(), job = randomUUID()
      await client.query("INSERT INTO organizations (id, name, kind) VALUES ($1, 'interview-scope-test', 'test')", [org])
      // Same name in two enterprises must still resolve to the current enterprise's user.
      await client.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, '企业面试测试用户')", [user, `${user}@example.invalid`])
      await client.query('INSERT INTO organization_members (organization_id, user_id) VALUES ($1, $2)', [org, user])
      await client.query("INSERT INTO candidates (id, organization_id, candidate_no, name) VALUES ($1, $2, $3, '面试范围测试候选人')", [candidate, org, `CAN-${candidate}`])
      await client.query("INSERT INTO jobs (id, organization_id, job_no, title, headcount) VALUES ($1, $2, $3, '面试范围测试岗位', 1)", [job, org, `JOB-${job}`])
      await client.query("INSERT INTO applications (id, organization_id, application_no, candidate_id, job_id, status) VALUES ($1, $2, $3, $4, $5, 'interviewing')", [app, org, `APP-${app}`.toUpperCase(), candidate, job])
    }
    const interviewA = await serviceA.createInterview({ applicationId: appA, title: '企业 A 面试', participants: [{ userId: '企业面试测试用户', role: 'interviewer' }] }, userA)
    const interviewB = await serviceB.createInterview({ applicationId: appB, title: '企业 B 面试', participants: [{ userId: userB, role: 'interviewer' }] }, userB)
    assert.equal(interviewA.participants[0]?.userId, userA)
    assert.equal((await client.query('SELECT organization_id FROM interviews WHERE id=$1', [interviewA.id])).rows[0].organization_id, orgA)
    assert.deepEqual((await serviceA.listInterviews()).map((row) => row.id), [interviewA.id])
    assert.deepEqual((await serviceB.listInterviews()).map((row) => row.id), [interviewB.id])
    assert.equal((await serviceA.listInterviews(appB)).length, 0)
    assert.equal((await repoA.listInterviews(interviewB.applicationId)).length, 0)
    assert.equal((await repoA.listInterviews(`APP-${appA}`)).length, 1)
    assert.equal((await repoA.getInterview(interviewA.code)).id, interviewA.id)
    await assert.rejects(repoA.getInterview(interviewB.id), notFound)
    await assert.rejects(repoA.getInterview(interviewB.code), notFound)
    await assert.rejects(serviceA.getInterview(interviewB.id), /未找到面试/)
    await assert.rejects(serviceA.assertInterviewInScope(interviewB.id), /未找到面试/)
    await assert.rejects(repoA.createInterview({ applicationId: appB, title: '跨企业创建', round: 1 }), notFound)
    await assert.rejects(repoA.createInterview({ applicationId: appA, title: '跨企业面试官', round: 1, participants: [{ userId: userB, role: 'interviewer', required: true }] }), /当前企业/)
    await assert.rejects(repoA.updateInterview(interviewB.id, { status: 'cancelled' }), notFound)
    await assert.rejects(repoA.deleteInterview(interviewB.code), notFound)
    assert.equal((await repoB.getInterview(interviewB.id)).status, 'scheduled')

    const feedbackA = await serviceA.submitFeedback(interviewA.id, { interviewerId: userA, overallScore: 86 }, userA)
    const feedbackB = await serviceB.submitFeedback(interviewB.id, { interviewerId: userB, overallScore: 72 }, userB)
    assert.equal((await client.query('SELECT organization_id FROM interview_feedback WHERE id=$1', [feedbackA.id])).rows[0].organization_id, orgA)
    assert.deepEqual((await repoA.listInterviewFeedback()).map((row) => row.id), [feedbackA.id])
    assert.equal((await repoA.getInterviewFeedbackForInterviewer(interviewA.id, '企业面试测试用户'))?.id, feedbackA.id)
    await assert.rejects(repoA.listInterviewFeedback(interviewB.id), notFound)
    await assert.rejects(repoA.getInterviewFeedback(feedbackB.id), notFound)
    await assert.rejects(repoA.updateInterviewFeedback(feedbackB.id, { status: 'locked' }), notFound)
    await assert.rejects(repoA.createInterviewFeedback({ interviewId: interviewB.id, interviewerId: userA }), notFound)
    assert.equal((await repoB.getInterviewFeedback(feedbackB.id)).status, 'submitted')

    const updated = await serviceA.updateInterviewSchedule(interviewA.code, {
      scheduledStartAt: '2026-10-17T14:00:00+08:00', scheduledEndAt: '2026-10-17T15:00:00+08:00', location: 'B会议室', meetingUrl: 'https://meeting.example/rescheduled',
    }, userA)
    assert.equal(updated.id, interviewA.id)
    assert.equal(updated.scheduledStartAt, '2026-10-17T06:00:00.000Z')
    assert.equal((await serviceA.getInterview(interviewA.id)).location, 'B会议室')
    assert.deepEqual(updated.participants, interviewA.participants)
    assert.equal((await repoA.listInterviewFeedback(interviewA.id))[0]?.id, feedbackA.id)
    assert.equal((await repoA.getApplication(appA)).status, 'interviewing')
    const audit = (await client.query("SELECT * FROM workflow_events WHERE subject_id=$1 AND event_type='update'", [interviewA.id])).rows
    assert.equal(audit.length, 1)
    assert.equal(audit[0].actor_user_id, userA)
    assert.equal(audit[0].metadata.after.location, 'B会议室')
    await serviceA.updateInterviewSchedule(interviewA.id, { scheduledEndAt: null, meetingUrl: null }, userA)
    assert.equal((await repoA.getInterview(interviewA.id)).scheduledEndAt, null)
    assert.equal((await repoA.getInterview(interviewA.id)).meetingUrl, null)
    await assert.rejects(serviceA.updateInterviewSchedule(interviewB.id, { location: '跨企业修改' }, userA), notFound)
    await assert.rejects(serviceA.updateInterviewSchedule(interviewA.id, { scheduledEndAt: '2026-10-17T05:00:00Z' }, userA), /结束时间必须晚于/)
    rejectScheduleAudit = true
    await assert.rejects(serviceA.updateInterviewSchedule(interviewA.id, { location: 'must roll back' }, userA), /simulated audit failure/)
    rejectScheduleAudit = false
    assert.equal((await repoA.getInterview(interviewA.id)).location, 'B会议室')

    // Legacy mismatched rows cannot leak into a list or break its application assembly.
    const mismatched = randomUUID()
    await client.query("INSERT INTO interviews (id, organization_id, interview_no, application_id, round, type, title) VALUES ($1, $2, $3, $4, 2, 'other', 'mismatched fixture')", [mismatched, orgA, `INT-${mismatched}`, appB])
    const mismatchedFeedback = randomUUID()
    await client.query('INSERT INTO interview_feedback (id, organization_id, interview_id, interviewer_id) VALUES ($1, $2, $3, $4)', [mismatchedFeedback, orgB, interviewA.id, userB])
    assert.deepEqual((await serviceA.listInterviews()).map((row) => row.id), [interviewA.id])
    assert.deepEqual((await serviceB.listInterviews()).map((row) => row.id), [interviewB.id])
    await assert.rejects(repoA.getInterview(mismatched), notFound)
    await assert.rejects(repoA.updateInterview(mismatched, { status: 'cancelled' }), notFound)
    await assert.rejects(repoA.deleteInterview(mismatched), notFound)
    assert.deepEqual((await repoB.listInterviewFeedback()).map((row) => row.id), [feedbackB.id])
    await assert.rejects(repoB.getInterviewFeedback(mismatchedFeedback), notFound)
    await assert.rejects(repoB.updateInterviewFeedback(mismatchedFeedback, { status: 'locked' }), notFound)

    await serviceA.lockFeedback(interviewA.id, userA, userA)
    assert.equal((await serviceA.getInterview(interviewA.id)).feedbackStatus, 'locked')
    await serviceA.concludeInterview(interviewA.id, 'continue', userA)
    assert.equal((await serviceA.getInterview(interviewA.id)).status, 'completed')
    await assert.rejects(serviceA.updateInterviewSchedule(interviewA.id, { location: '不能改历史' }, userA), /不能修改安排/)
    await serviceA.deleteInterview(interviewA.id, userA)
    assert.equal((await serviceA.listInterviews()).length, 0)
    assert.equal((await repoA.listInterviewFeedback()).length, 0)
    assert.equal((await repoB.getInterview(interviewB.id)).status, 'scheduled')
    assert.equal((await repoB.getInterviewFeedback(feedbackB.id)).status, 'submitted')
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
