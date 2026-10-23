import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { LiveInterviewSessionRepository } from '../src/interviews/live-session-repository.js'

test('recognition alternatives round-trip through PostgreSQL and migration is idempotent', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Shadow real tables in this connection: never create or change candidate data.
    for (const table of ['interview_live_sessions', 'interview_live_segments', 'interview_live_analyses']) {
      await client.query('CREATE TEMP TABLE ' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS) ON COMMIT DROP')
    }
    await client.query('ALTER TABLE pg_temp.interview_live_segments DROP COLUMN IF EXISTS transcript_comparison')
    const sql = await readFile(new URL('../../../../db/migrations/0048_live_transcript_comparison.sql', import.meta.url), 'utf8')
    await client.query(sql)
    await client.query(sql)
    const sessionId = randomUUID()
    await client.query("INSERT INTO interview_live_sessions (id,interview_id,created_by) VALUES ($1,$2,$3)", [sessionId, randomUUID(), randomUUID()])
    const comparison = { streamingText: '我负责平台的开发。', offlineText: '我负责平台开发。团队八个人。我还负责测试。',
      streamingComplete: false, selectedSource: 'offline' as const, startMs: 15000, endMs: 30000 }
    const repository = new LiveInterviewSessionRepository({ query: client.query.bind(client) } as never)
    const saved = await repository.addSegment(sessionId, { speakerId: 'voice_test', role: 'candidate', confidence: .82,
      text: comparison.offlineText, startMs: 15000, endMs: 29000, transcriptComparison: comparison })
    assert.deepEqual(saved.transcriptComparison, comparison)
    assert.equal(saved.text, comparison.offlineText)
    const restored = await repository.get(sessionId)
    assert.equal(restored.segments.length, 1)
    assert.deepEqual(restored.segments[0]?.transcriptComparison, comparison)
    assert.equal(restored.segments[0]?.text, comparison.offlineText)
    const legacy = await repository.addSegment(sessionId, { speakerId: 'manual_candidate', role: 'candidate', confidence: 1,
      text: '历史兼容测试。', startMs: 30000, endMs: 31000 })
    assert.equal(legacy.transcriptComparison, undefined)
  } finally {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  }
})
