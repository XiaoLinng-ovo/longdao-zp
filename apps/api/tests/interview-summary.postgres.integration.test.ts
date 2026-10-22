import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { InterviewSummaryRepository } from '../src/interviews/interview-summary-repository.js'
import { QuestionSheetRepository } from '../src/interviews/question-sheet-repository.js'
import { createUnscoredSummary } from '../src/interviews/interview-summary.js'

test('summary migration, queue, corrections and score preference work in isolated PostgreSQL schema', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  await client.query('BEGIN')
  try {
    const schema = `summary_test_${randomUUID().replaceAll('-', '')}`
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET LOCAL search_path TO ${schema}`)
    await client.query(`CREATE TABLE users (id uuid PRIMARY KEY);
      CREATE TABLE applications (id uuid PRIMARY KEY, organization_id uuid);
      CREATE TABLE interviews (id uuid PRIMARY KEY, application_id uuid, organization_id uuid, stage text, status text);
      CREATE TABLE interview_live_sessions (id uuid PRIMARY KEY, interview_id uuid, status text, started_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE interview_live_segments (id uuid PRIMARY KEY, session_id uuid, text text, role text, role_confidence numeric, start_ms integer, end_ms integer, status text);
      CREATE TABLE interview_live_analyses (id uuid PRIMARY KEY, segment_id uuid, scores jsonb)`)
    await client.query(await readFile(new URL('../../../../db/migrations/0041_interview_transcript_summary.sql', import.meta.url), 'utf8'))
    const actor = randomUUID(), org = randomUUID(), app = randomUUID(), interview = randomUUID(), session = randomUUID(), segment = randomUUID()
    await client.query('INSERT INTO users VALUES ($1)', [actor])
    await client.query('INSERT INTO applications VALUES ($1,$2)', [app, org])
    await client.query("INSERT INTO interviews VALUES ($1,$2,$3,'initial','scheduled')", [interview, app, org])
    await client.query("INSERT INTO interview_live_sessions (id,interview_id,status) VALUES ($1,$2,'active')", [session, interview])
    const fakePool = { query: (sql: string, values: unknown[]) => client.query(sql, values) } as never
    const summaries = new InterviewSummaryRepository(fakePool), sheets = new QuestionSheetRepository(fakePool)
    await assert.rejects(summaries.request(interview, actor), /先结束/)
    await client.query("INSERT INTO interview_live_segments VALUES ($1,$2,'回答全文','candidate',.95,0,1000,'transcribed')", [segment, session])
    assert.equal((await summaries.latest(interview))!.revision, 1)
    assert.equal((await summaries.latest(interview))!.status, 'none')
    await client.query("INSERT INTO interview_live_analyses VALUES ($1,$2,'[{\"score\":9}]')", [randomUUID(), segment])
    await client.query("UPDATE interview_live_sessions SET status='completed' WHERE id=$1", [session])
    assert.deepEqual(await sheets.listCompletedLiveRecordingScores(app), [])
    assert.equal((await summaries.request(interview, actor)).status, 'pending')
    // A new summary must not silently substitute a reference-question segment score.
    assert.deepEqual(await sheets.listCompletedLiveRecordingScores(app), [])
    const job = await summaries.claim(); assert.ok(job)
    assert.equal(job.applicationId, app)
    assert.equal((await summaries.request(interview, actor)).status, 'generating')
    assert.equal(await summaries.claim(), null)
    const report = { ...createUnscoredSummary([]), overallScore: 72 }
    await client.query("UPDATE interview_live_segments SET status='analyzed' WHERE id=$1", [segment])
    assert.equal((await summaries.latest(interview))!.revision, job.revision)
    assert.equal(await summaries.save(job, report, null), true)
    assert.deepEqual(await sheets.listCompletedLiveRecordingScores(app), [{ stage: 'initial', score: 72 }])
    await summaries.request(interview, actor)
    assert.equal((await summaries.latest(interview))!.report!.overallScore, 72, 'regeneration preserves the previous report while pending')
    const failedRegeneration = await summaries.claim(); assert.ok(failedRegeneration)
    assert.equal(await summaries.save(failedRegeneration, createUnscoredSummary([]), '模型证据校验失败'), true)
    const afterFailedRegeneration = (await summaries.latest(interview))!
    assert.equal(afterFailedRegeneration.status, 'ready')
    assert.equal(afterFailedRegeneration.report!.overallScore, 72, 'failed regeneration preserves the previous scored report')
    assert.match(afterFailedRegeneration.error!, /证据校验失败/)
    await summaries.request(interview, actor)
    const outdated = await summaries.claim(); assert.ok(outdated)
    await client.query("UPDATE interview_live_segments SET role='interviewer',role_confidence=1 WHERE id=$1", [segment])
    const corrected = (await summaries.latest(interview))!
    assert.equal(corrected.status, 'pending'); assert.equal(corrected.report, null)
    assert.equal(corrected.revision, outdated.revision + 1)
    assert.equal(await summaries.save(outdated, report, null), false)
    assert.equal((await client.query('SELECT count(*) FROM interview_live_analyses')).rows[0].count, '0')
    const retry = await summaries.claim(); assert.ok(retry)
    assert.equal(await summaries.save(retry, createUnscoredSummary([]), '模型超时'), true)
    assert.deepEqual(await sheets.listCompletedLiveRecordingScores(app), [])
    const pending = await summaries.request(interview, actor)
    assert.ok(pending.report, 'a failed summary retains its complete transcript while retrying'); assert.equal(pending.error, null)
    await summaries.claim()
    await client.query("UPDATE interview_live_sessions SET updated_at=now()-interval '16 minutes' WHERE id=$1", [session])
    assert.ok(await summaries.claim(), 'stale worker claims can be recovered')
    await client.query('DELETE FROM interview_live_segments WHERE id=$1', [segment])
    assert.equal((await summaries.latest(interview))!.status, 'pending')
    assert.equal((await summaries.latest(interview))!.revision, corrected.revision + 1)
  } finally {
    await client.query('ROLLBACK')
    client.release(); await pool.end()
  }
})
