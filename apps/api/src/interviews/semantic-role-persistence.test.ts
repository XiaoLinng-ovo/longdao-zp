import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveInterviewSessionRepository } from './live-session-repository.js'

test('live writes preserve role review and store absence as SQL NULL for acoustic backfill', async () => {
  const calls: unknown[][] = []
  const repository = new LiveInterviewSessionRepository({ async query(_sql: string, values: unknown[]) {
    calls.push(values)
    return { rows: [{ id: 'segment', session_id: 'session', speaker_id: values[1], role: values[2],
      role_confidence: values[3], text: values[4], start_ms: values[5], end_ms: values[6],
      role_review: values[10] ? JSON.parse(String(values[10])) : null, status: 'transcribed' }] }
  } } as never)
  const input = { speakerId: 'shared', role: 'candidate' as const, confidence: .95,
    text: '我负责项目开发', startMs: 0, endMs: 1000 }
  const review = { method: 'semantic_context' as const, status: 'inferred' as const, confidence: .95,
    reason: '本人项目经历', model: 'test', promptVersion: 'v1' }
  const saved = await repository.addSegment('session', { ...input, roleReview: review })
  assert.deepEqual(saved.roleReview, review)
  assert.equal(saved.speakerConfirmed, false)
  await repository.addSegment('session', input)
  assert.equal(calls[1]?.[10], null)
})
