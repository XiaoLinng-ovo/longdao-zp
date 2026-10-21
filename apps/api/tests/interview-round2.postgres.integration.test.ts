import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { QuestionSheetRepository } from '../src/interviews/question-sheet-repository.js'
import { NormalizedRecruitingRepository } from '../src/recruiting/repositories/postgres-repository.js'
import type { RepositoryPool } from '../src/recruiting/repositories/types.js'

test('复试流转：第二轮独立建档、幂等、企业隔离、回滚和旧结论补齐', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  const query = async (sql: string, values: unknown[] = []) => client.query(
    sql === 'BEGIN' ? 'SAVEPOINT round2_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT round2_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT round2_test' : sql, values,
  )
  const executor = { query, release() {} }
  const fixturePool = { query, async connect() { return executor } } as unknown as Pool
  const repository = new QuestionSheetRepository(fixturePool)
  const fixtures = [0, 1].map(() => ({ org: randomUUID(), user: randomUUID(), candidate: randomUUID(), job: randomUUID(), app: randomUUID(), initial: randomUUID() }))
  await client.query('BEGIN')
  try {
    for (const f of fixtures) {
      await client.query("INSERT INTO organizations (id,name,kind) VALUES ($1,'round2-test','test')", [f.org])
      await client.query("INSERT INTO users (id,email,display_name) VALUES ($1,$2,'round2-test')", [f.user, f.user + '@example.invalid'])
      await client.query('INSERT INTO organization_members (organization_id,user_id) VALUES ($1,$2)', [f.org, f.user])
      await client.query("INSERT INTO candidates (id,organization_id,candidate_no,name) VALUES ($1,$2,$3,'round2-test')", [f.candidate, f.org, 'CAN-' + f.candidate])
      await client.query("INSERT INTO jobs (id,organization_id,job_no,title,headcount) VALUES ($1,$2,$3,'round2-test',1)", [f.job, f.org, 'JOB-' + f.job])
      await client.query("INSERT INTO applications (id,organization_id,application_no,candidate_id,job_id,status) VALUES ($1,$2,$3,$4,$5,'interviewing')", [f.app, f.org, 'APP-' + f.app, f.candidate, f.job])
      await client.query("INSERT INTO interviews (id,organization_id,application_id,interview_no,round,stage,type,title,status,scheduled_start_at,participants) VALUES ($1,$2,$3,$4,1,'initial','technical','初试','completed','2026-10-01T01:00:00Z',$5::jsonb)", [f.initial, f.org, f.app, 'INT-' + f.initial, JSON.stringify([{ userId: f.user, role: 'interviewer', required: true }])])
    }
    const a = fixtures[0]!, b = fixtures[1]!
    assert.equal(await repository.findNextRound(a.app), null)
    const first = await repository.recordStageDecision(a.app, 'initial', 'advanced', a.user)
    const repeat = await repository.recordStageDecision(a.app, 'initial', 'advanced', a.user)
    assert.ok(first.nextInterview)
    assert.equal(repeat.nextInterview?.id, first.nextInterview.id)
    assert.equal(repeat.decidedAt, first.decidedAt)
    const rounds = (await client.query('SELECT * FROM interviews WHERE application_id=$1 ORDER BY round', [a.app])).rows
    assert.equal(rounds.length, 2)
    assert.equal(rounds[0].id, a.initial)
    assert.equal(rounds[0].status, 'completed')
    assert.equal(rounds[1].round, 2)
    assert.equal(rounds[1].stage, 'final')
    assert.equal(rounds[1].status, 'scheduled')
    assert.equal(rounds[1].scheduled_start_at, null)
    assert.equal(rounds[1].organization_id, a.org)
    assert.deepEqual(rounds[1].participants, rounds[0].participants)
    assert.equal((await client.query("SELECT count(*) FROM workflow_events WHERE subject_id=$1 AND event_type='advance_to_final_interview'", [a.app])).rows[0].count, '1')
    const scoped = new NormalizedRecruitingRepository(fixturePool as unknown as RepositoryPool, { organizationId: a.org })
    assert.equal((await scoped.listInterviews(a.app)).length, 2)
    assert.equal((await scoped.listInterviews(b.app)).length, 0)
    await assert.rejects(repository.recordStageDecision(a.app, 'initial', 'rejected', a.user), /已进入复试/)
    assert.equal((await client.query("SELECT decision FROM interview_stage_reviews WHERE application_id=$1 AND stage='initial'", [a.app])).rows[0].decision, 'advanced')

    // A missing actor fails after insertion; the entire advancement must roll back.
    await assert.rejects(repository.recordStageDecision(b.app, 'initial', 'advanced', randomUUID()))
    assert.equal(await repository.findNextRound(b.app), null)
    assert.equal((await client.query('SELECT count(*) FROM interview_stage_reviews WHERE application_id=$1', [b.app])).rows[0].count, '0')

    // Old releases stored only the decision. Explicitly confirming again repairs it.
    await client.query("INSERT INTO interview_stage_reviews (application_id,stage,decision,decided_by,decided_at,organization_id) VALUES ($1,'initial','advanced',$2,'2026-10-01T02:00:00Z',$3)", [b.app,b.user,b.org])
    const repaired = await repository.recordStageDecision(b.app, 'initial', 'advanced', b.user)
    assert.equal(repaired.nextInterview?.round, 2)
    assert.equal(repaired.decidedAt, '2026-10-01T02:00:00.000Z')
    assert.equal((await repository.findNextRound(b.app))?.id, repaired.nextInterview?.id)

    // Replays never resurrect a completed second round or reset an Offer status.
    await client.query("UPDATE interviews SET status='completed' WHERE id=$1", [first.nextInterview.id])
    await client.query("UPDATE applications SET status='offer_approval' WHERE id=$1", [a.app])
    const completed = await repository.recordStageDecision(a.app, 'initial', 'advanced', a.user)
    assert.equal(completed.nextInterview?.id, first.nextInterview.id)
    assert.equal(completed.nextInterview?.status, 'completed')
    assert.equal((await client.query('SELECT status FROM applications WHERE id=$1', [a.app])).rows[0].status, 'offer_approval')

    // Replaying an initial decision must not resurrect a cancelled second round.
    await client.query("UPDATE interviews SET status='cancelled' WHERE id=$1", [repaired.nextInterview!.id])
    const cancelled = await repository.recordStageDecision(b.app, 'initial', 'advanced', b.user)
    assert.equal(cancelled.nextInterview?.id, repaired.nextInterview?.id)
    assert.equal(cancelled.nextInterview?.status, 'cancelled')
    assert.equal((await repository.findNextRound(b.app))?.status, 'cancelled')
    assert.equal((await client.query("SELECT count(*) FROM interviews WHERE application_id=$1 AND stage='final'", [b.app])).rows[0].count, '1')
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
