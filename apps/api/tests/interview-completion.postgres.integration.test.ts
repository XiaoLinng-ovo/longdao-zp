import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'
import { OFFER_ELIGIBILITY_SQL } from '../src/recruiting/offer-eligibility.js'
import { LiveInterviewSessionRepository } from '../src/interviews/live-session-repository.js'
import { QuestionSheetRepository } from '../src/interviews/question-sheet-repository.js'

test('stage confirmation atomically preserves first-round scores, concludes it and reuses one scheduled second round', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  const query = (sql: string, values: readonly unknown[] = []) => client.query(
    sql === 'BEGIN' ? 'SAVEPOINT stage_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT stage_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT stage_test' : sql, [...values])
  const executor = { query, release() {} }
  const fixturePool = { query, async connect() { return executor }, async end() {} }
  const f = { org: randomUUID(), user: randomUUID(), candidate: randomUUID(), job: randomUUID(), app: randomUUID(), initial: randomUUID() }
  await client.query('BEGIN')
  try {
    await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'stage-test','test')", [f.org])
    await client.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'stage-test')", [f.user, f.user + '@example.invalid'])
    await client.query('INSERT INTO organization_members (organization_id,user_id) VALUES ($1,$2)', [f.org, f.user])
    await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'stage-test')", [f.candidate, f.org, f.candidate])
    await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'stage-test',1)", [f.job, f.org, f.job])
    await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'interviewing')", [f.app, f.org, f.app, f.candidate, f.job])
    await client.query("INSERT INTO interviews (id,organization_id,application_id,interview_no,round,stage,type,title,participants) VALUES ($1,$2,$3,$4,1,'initial','technical','初试','[]')", [f.initial, f.org, f.app, f.initial])
    await client.query("INSERT INTO interview_stage_reviews (application_id,stage,organization_id,ai_score,sheet_scores) VALUES ($1,'initial',$2,88,$3)", [f.app, f.org, JSON.stringify({ hr_screen: 90, hiring_department: 86 })])
    const sheets = new QuestionSheetRepository(fixturePool as never)
    const recruiting = new NormalizedRecruitingRepository(fixturePool as RepositoryPool, { organizationId: f.org })
    const sessions = new LiveInterviewSessionRepository(fixturePool as never)
    const session = await sessions.create(f.initial, f.user)
    const assertUnchanged = async () => {
      assert.equal((await recruiting.getInterview(f.initial)).status, 'scheduled')
      assert.equal((await recruiting.listInterviews(f.app)).length, 1)
      assert.equal((await client.query('SELECT decision FROM interview_stage_reviews WHERE application_id=$1', [f.app])).rows[0].decision, null)
      assert.equal((await client.query("SELECT count(*)::int AS n FROM workflow_events WHERE subject_id=$1 AND event_type='conclude'", [f.initial])).rows[0].n, 0)
    }
    await assert.rejects(sheets.recordStageDecision(f.app, 'initial', 'advanced', f.user), { code: 'INTERVIEW_SESSION_NOT_ENDED' })
    await assertUnchanged()
    await client.query("UPDATE interview_live_sessions SET status='completed', ended_at=now() WHERE id=$1", [session.id])
    const failingExecutor = { ...executor, query: (sql: string, values?: readonly unknown[]) => {
      if (sql.startsWith('INSERT INTO interviews')) throw new Error('injected second-round failure')
      return query(sql, values)
    } }
    const failing = new QuestionSheetRepository({ async connect() { return failingExecutor } } as never)
    await assert.rejects(failing.recordStageDecision(f.app, 'initial', 'advanced', f.user), /injected second-round failure/)
    await assertUnchanged()
    const first = await sheets.recordStageDecision(f.app, 'initial', 'advanced', f.user)
    const second = await sheets.recordStageDecision(f.app, 'initial', 'advanced', f.user)
    assert.equal(second.nextInterview?.id, first.nextInterview?.id)
    assert.equal(second.decidedAt, first.decidedAt)
    assert.equal(second.aiScore, 88)
    assert.deepEqual(second.sheetScores, { hr_screen: 90, hiring_department: 86 })
    const rounds = await recruiting.listInterviews(f.app)
    assert.equal(rounds.length, 2)
    assert.equal(rounds.find(row => row.id === f.initial)?.status, 'completed')
    const final = rounds.find(row => row.round === 2)!
    assert.equal(final.status, 'scheduled')
    assert.equal(final.scheduledStartAt, null)
    assert.equal((await recruiting.listInterviewResults([f.initial])).get(f.initial)?.outcome, 'continue')
    assert.equal((await client.query("SELECT count(*)::int AS n FROM workflow_events WHERE subject_id=$1 AND event_type='conclude'", [f.initial])).rows[0].n, 1)
    await assert.rejects(sessions.create(final.id, f.user), { code: 'INTERVIEW_SCHEDULE_INCOMPLETE' })
    await client.query('UPDATE interviews SET scheduled_start_at=now(), participants=$2 WHERE id=$1', [final.id, JSON.stringify([{ userId: f.user, role: 'interviewer', required: true }])])
    await sheets.recordStageDecision(f.app, 'initial', 'advanced', f.user)
    assert.ok((await recruiting.getInterview(final.id)).scheduledStartAt)
    assert.equal((await sessions.create(final.id, f.user)).status, 'active')
  } finally {
    await client.query('ROLLBACK'); client.release(); await pool.end()
  }
})

test('direct completion persists round results, ready AI scores, Offer eligibility and enterprise isolation atomically', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  const query = (sql: string, values: readonly unknown[] = []) => client.query(
    sql === 'BEGIN' ? 'SAVEPOINT completion_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT completion_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT completion_test' : sql, [...values])
  const executor = { query, release() {} }
  const fixturePool = { query, async connect() { return executor } } as unknown as RepositoryPool
  const f = { org: randomUUID(), user: randomUUID(), candidate: randomUUID(), job: randomUUID(), app: randomUUID(), initial: randomUUID() }
  await client.query('BEGIN')
  try {
    await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'completion-test','test')", [f.org])
    await client.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'completion-test')", [f.user, f.user + '@example.invalid'])
    await client.query('INSERT INTO organization_members (organization_id,user_id) VALUES ($1,$2)', [f.org, f.user])
    await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'completion-test')", [f.candidate, f.org, 'CAN-' + f.candidate])
    await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'completion-test',1)", [f.job, f.org, 'JOB-' + f.job])
    await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'interviewing')", [f.app, f.org, 'APP-' + f.app, f.candidate, f.job])
    await client.query("INSERT INTO interviews (id,organization_id,application_id,interview_no,round,stage,type,title,participants) VALUES ($1,$2,$3,$4,1,'initial','technical','初试','[]')", [f.initial, f.org, f.app, 'INT-' + f.initial])
    const repository = new NormalizedRecruitingRepository(fixturePool, { organizationId: f.org })
    await assert.rejects(repository.concludeInterview(f.initial, 'offer', f.user, true), (e: any) => e.code === 'INVALID_INTERVIEW_OUTCOME')
    // 会话记录必须在结论之前写入：结论后数据库触发器会拒绝任何新会话。
    await client.query("INSERT INTO interview_live_sessions (interview_id,status,created_by,summary_status,summary_report,started_at) VALUES ($1,'completed',$2,'ready',$3::jsonb,'2026-10-01T01:00:00Z')", [f.initial, f.user, JSON.stringify({ version: 'whole-dialogue-v2', overallScore: 0 })])
    await repository.concludeInterview(f.initial, 'continue', f.user, true)
    await repository.concludeInterview(f.initial, 'continue', f.user, true)
    const rounds = await repository.listInterviews(f.app)
    assert.equal(rounds.length, 2)
    const final = rounds.find(i => i.round === 2)!
    await assert.rejects(repository.concludeInterview(final.id, 'continue', f.user), (e: any) => e.code === 'INVALID_INTERVIEW_OUTCOME')
    assert.equal((await client.query('SELECT status FROM applications WHERE id=$1', [f.app])).rows[0].status, 'interviewing')
    assert.equal((await repository.getInterview(final.id)).status, 'scheduled')
    assert.equal((await client.query('SELECT count(*)::int AS count FROM interview_feedback WHERE interview_id=$1', [f.initial])).rows[0].count, 0)
    assert.equal((await client.query("SELECT count(*)::int AS count FROM workflow_events WHERE subject_id=$1 AND event_type='conclude'", [f.initial])).rows[0].count, 1)
    await repository.concludeInterview(final.id, 'offer', f.user, true)
    assert.equal((await client.query("SELECT decision FROM interview_stage_reviews WHERE application_id=$1 AND stage='final'", [f.app])).rows[0].decision, 'hired')
    assert.equal((await client.query('SELECT a.id FROM applications a WHERE a.id=$1 AND ' + OFFER_ELIGIBILITY_SQL, [f.app])).rows.length, 1)
    let results = await repository.listInterviewResults([f.initial, final.id])
    assert.equal(results.get(f.initial)?.outcome, 'continue')
    assert.equal(results.get(f.initial)?.aiScore, 0)
    assert.equal(results.get(final.id)?.outcome, 'offer')
    assert.equal(results.get(final.id)?.aiScore, null)
    await client.query("UPDATE interview_live_sessions SET summary_status='generating', summary_report=NULL, started_at='2026-10-02T01:00:00Z' WHERE interview_id=$1", [f.initial])
    results = await repository.listInterviewResults([f.initial])
    assert.equal(results.get(f.initial)?.aiScore, null)
    assert.equal(results.get(f.initial)?.aiScoreStatus, 'generating')
    const other = new NormalizedRecruitingRepository(fixturePool, { organizationId: randomUUID() })
    assert.equal((await other.listInterviewResults([f.initial])).size, 0)
    await assert.rejects(repository.concludeInterview(f.initial, 'reject', f.user, true), (e: any) => e.code === 'INTERVIEW_ALREADY_CONCLUDED')

    const cancelled = randomUUID()
    await client.query("INSERT INTO interviews (id,organization_id,application_id,interview_no,round,stage,type,title,participants) VALUES ($1,$2,$3,$4,2,'final','technical','取消的复试','[]')", [cancelled, f.org, f.app, 'INT-' + cancelled])
    await client.query("UPDATE applications SET status = 'interviewing' WHERE id = $1", [f.app])
    await repository.concludeInterview(cancelled, 'cancelled', f.user, true)
    await repository.concludeInterview(cancelled, 'cancelled', f.user, true)
    const cancelledInterview = await repository.getInterview(cancelled)
    assert.equal(cancelledInterview.status, 'cancelled')
    assert.equal((await repository.listInterviewResults([cancelled])).get(cancelled)?.outcome, 'cancelled')
    assert.equal((await client.query("SELECT status FROM applications WHERE id = $1", [f.app])).rows[0].status, 'interviewing')
    assert.equal((await client.query("SELECT count(*)::int AS count FROM interview_stage_reviews WHERE application_id=$1 AND stage='final'", [f.app])).rows[0].count, 1)
    assert.equal((await client.query("SELECT decision FROM interview_stage_reviews WHERE application_id=$1 AND stage='final'", [f.app])).rows[0].decision, 'hired')
    assert.equal((await client.query("SELECT count(*)::int AS count FROM workflow_events WHERE subject_id=$1 AND event_type='conclude'", [cancelled])).rows[0].count, 1)
  } finally {
    await client.query('ROLLBACK'); client.release(); await pool.end()
  }
})

test('conclusion requires stopped audio and at most 30 unresolved roles without losing corrected results', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  const query = (sql: string, values: readonly unknown[] = []) => client.query(
    sql === 'BEGIN' ? 'SAVEPOINT live_session_guard' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT live_session_guard' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT live_session_guard' : sql, [...values])
  const executor = { query, release() {} }
  const fixturePool = { query, async connect() { return executor } } as unknown as RepositoryPool
  const f = { org: randomUUID(), user: randomUUID(), candidate: randomUUID(), job: randomUUID(), app: randomUUID(), interview: randomUUID() }
  await client.query('BEGIN')
  try {
    await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'live-session-guard','test')", [f.org])
    await client.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'live-session-guard')", [f.user, f.user + '@example.invalid'])
    await client.query('INSERT INTO organization_members (organization_id,user_id) VALUES ($1,$2)', [f.org, f.user])
    await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'live-session-guard')", [f.candidate, f.org, 'CAN-' + f.candidate])
    await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'live-session-guard',1)", [f.job, f.org, 'JOB-' + f.job])
    await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'interviewing')", [f.app, f.org, 'APP-' + f.app, f.candidate, f.job])
    await client.query("INSERT INTO interviews (id,organization_id,application_id,interview_no,round,stage,type,title,participants) VALUES ($1,$2,$3,$4,1,'initial','technical','面试','[]')", [f.interview, f.org, f.app, 'INT-' + f.interview])

    const recruiting = new NormalizedRecruitingRepository(fixturePool, { organizationId: f.org })
    const liveSessions = new LiveInterviewSessionRepository(fixturePool as never)
    const session = await liveSessions.create(f.interview, f.user)
    assert.equal(session.status, 'active')

    await assert.rejects(recruiting.concludeInterview(f.interview, 'continue', f.user, true), { code: 'INTERVIEW_SESSION_NOT_ENDED', status: 409 })
    const stopped = await liveSessions.end(session.id)
    assert.equal(stopped.status, 'paused')
    assert.equal(stopped.completionReview?.phase, 'processing')
    const turns = Array.from({ length: 31 }, (_, index) => ({ id: 'turn-' + index, speakerId: 'voice-' + index,
      role: 'unknown', confidence: .35, text: '纠正后的正文' + index, startMs: index * 1000, endMs: index * 1000 + 900,
      audioSource: 'meeting', evidenceIds: ['evidence-' + index], roleReasons: [] }))
    const evidence = [{ id: 'evidence-0', text: '原始证据' }], corrections = [{ reason: '纠错记录' }], uncertainties = [{ reason: '保留的不确定项' }]
    const versionId = randomUUID()
    await client.query(`INSERT INTO interview_transcript_versions(id,session_id,content_fingerprint,turns,evidence,corrections,uncertainties,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [versionId, session.id, versionId, JSON.stringify(turns), JSON.stringify(evidence),
      JSON.stringify(corrections), JSON.stringify(uncertainties), JSON.stringify({ warnings: ['保留的警告'], roleReviewRequired: true })])
    await client.query("UPDATE interview_transcript_postprocess_jobs SET status='completed' WHERE session_id=$1", [session.id])
    await client.query('UPDATE interview_live_sessions SET corrected_transcript_version_id=$2 WHERE id=$1', [session.id, versionId])
    const blocked = await liveSessions.end(session.id)
    assert.equal(blocked.status, 'paused')
    assert.equal(blocked.endedAt, stopped.endedAt)
    assert.equal(blocked.completionReview?.phase, 'review_required')
    assert.equal(blocked.completionReview?.unresolvedCount, 31)
    await assert.rejects(recruiting.concludeInterview(f.interview, 'continue', f.user, true), { code: 'INTERVIEW_SESSION_NOT_ENDED', status: 409 })
    const reviewed = await liveSessions.correctTranscriptRoles(session.id, versionId, ['turn-0'], 'candidate', f.user)
    assert.equal(reviewed.completionReview?.phase, 'ready')
    assert.equal(reviewed.completionReview?.unresolvedCount, 30)
    assert.equal(reviewed.segments[0]?.text, turns[0]!.text)
    assert.equal(reviewed.segments[0]?.speakerConfirmed, true)
    const nextId = reviewed.completionReview!.versionId!
    assert.notEqual(nextId, versionId)
    const original = (await client.query('SELECT * FROM interview_transcript_versions WHERE id=$1', [versionId])).rows[0]
    const current = (await client.query('SELECT * FROM interview_transcript_versions WHERE id=$1', [nextId])).rows[0]
    assert.deepEqual(original.turns, turns)
    for (const field of ['evidence', 'corrections', 'uncertainties']) assert.deepEqual(current[field], original[field])
    assert.ok(current.metadata.warnings.includes('保留的警告'))
    await assert.rejects(liveSessions.correctTranscriptRoles(session.id, versionId, ['turn-1'], 'candidate', f.user), { code: 'TRANSCRIPT_VERSION_CONFLICT', status: 409 })
    const ended = await liveSessions.end(session.id)
    assert.equal(ended.status, 'completed')
    assert.equal(ended.endedAt, stopped.endedAt)
    assert.equal(ended.completionReview?.unresolvedCount, 30)
    assert.equal((await liveSessions.end(session.id)).endedAt, stopped.endedAt)
    assert.equal((await client.query('SELECT status FROM interview_transcript_postprocess_jobs WHERE session_id=$1', [session.id])).rows[0].status, 'completed')
    await recruiting.concludeInterview(f.interview, 'continue', f.user, true)
    const closed = await client.query('SELECT status, ended_at FROM interview_live_sessions WHERE id=$1', [session.id])
    assert.equal(closed.rows[0].status, 'completed')
    assert.ok(closed.rows[0].ended_at)

    await assert.rejects(liveSessions.create(f.interview, f.user), (error: any) => error.code === 'INTERVIEW_ALREADY_COMPLETED' && error.status === 409)
    assert.equal((await client.query('SELECT count(*)::int AS count FROM interview_live_sessions WHERE interview_id=$1', [f.interview])).rows[0].count, 1)
    // 绕过仓储层直接写库时数据库触发器仍然兜底；异常会中止当前事务，
    // 因此包在 savepoint 里，失败后回滚到该点继续后续断言。
    await client.query('SAVEPOINT direct_insert')
    await assert.rejects(
      client.query('INSERT INTO interview_live_sessions (interview_id, created_by) VALUES ($1::uuid,$2::uuid)', [f.interview, f.user]),
      (error: any) => String(error.message).includes('INTERVIEW_ALREADY_COMPLETED'),
    )
    await client.query('ROLLBACK TO SAVEPOINT direct_insert')
  } finally {
    await client.query('ROLLBACK'); client.release(); await pool.end()
  }
})
