import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'
import { OFFER_ELIGIBILITY_SQL } from '../src/recruiting/offer-eligibility.js'
import { LiveInterviewSessionRepository } from '../src/interviews/live-session-repository.js'

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

test('conclusion closes the running live session and blocks reopening it afterwards', async context => {
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
