import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LiveAudioTranscriptionRepository, type AudioTranscriptionJob, type TranscribedSegmentInput } from './live-audio-transcription-repository.js'

const job: AudioTranscriptionJob = { objectKey: 'audio-key', sessionId: 'session', contentType: 'audio/webm',
  offsetMs: 0, endMs: 15000, claim: 'owned-claim', attempts: 1 }
const segment: TranscribedSegmentInput = { speakerId: 'speaker', role: 'unknown', confidence: .35,
  text: 'Saved answer.', startMs: 0, endMs: 15000, audioObjectKey: job.objectKey }

test('completion writes all segments and finishes the job on the same transaction connection', async () => {
  const calls: string[] = []
  let released = false
  const client = {
    query: async (sql: string) => {
      calls.push(sql)
      if (sql.startsWith('SELECT object_key')) return { rowCount: 1, rows: [{}] }
      if (sql.startsWith('INSERT INTO interview_live_segments')) return { rowCount: 1, rows: [{ id: 'saved', session_id: job.sessionId,
        speaker_id: segment.speakerId, role: 'unknown', role_confidence: .35, text: segment.text, start_ms: 0, end_ms: 15000, status: 'transcribed' }] }
      return { rowCount: 1, rows: [] }
    }, release: () => { released = true },
  }
  const repository = new LiveAudioTranscriptionRepository({ connect: async () => client,
    query: async () => { throw new Error('must not escape the transaction') } } as never)
  assert.equal(await repository.complete(job, [segment]), true)
  assert.equal(calls[0], 'BEGIN'); assert.equal(calls.at(-1), 'COMMIT')
  assert.ok(calls.findIndex(sql => sql.startsWith('INSERT INTO interview_live_segments')) < calls.findIndex(sql => sql.startsWith('UPDATE interview_audio_transcription_jobs')))
  assert.equal(released, true)
})

test('an expired claim cannot write duplicate segments or acknowledge another worker task', async () => {
  const calls: string[] = []
  let released = false
  const repository = new LiveAudioTranscriptionRepository({ connect: async () => ({
    query: async (sql: string) => { calls.push(sql); return { rowCount: 0, rows: [] } }, release: () => { released = true },
  }) } as never)
  assert.equal(await repository.complete(job, [segment]), false)
  assert.deepEqual(calls.map(sql => sql.split(' ')[0]), ['BEGIN', 'SELECT', 'SELECT', 'ROLLBACK'])
  assert.equal(released, true)
})

test('a failed segment write rolls back the entire completion and releases the connection', async () => {
  const calls: string[] = [], failure = new Error('database temporarily unavailable')
  let released = false
  const repository = new LiveAudioTranscriptionRepository({ connect: async () => ({
    query: async (sql: string) => {
      calls.push(sql)
      if (sql.startsWith('INSERT')) throw failure
      return { rowCount: 1, rows: [{}] }
    }, release: () => { released = true },
  }) } as never)
  await assert.rejects(repository.complete(job, [segment]), failure)
  assert.equal(calls.at(-1), 'ROLLBACK')
  assert.equal(calls.some(sql => sql.startsWith('UPDATE interview_audio_transcription_jobs')), false)
  assert.equal(released, true)
})

test('retries retain the audio job with bounded backoff and the original claim guard', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const repository = new LiveAudioTranscriptionRepository({ query: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values }); return { rows: [] }
  } } as never)
  for (const attempts of [1, 2, 20]) await repository.retry({ ...job, attempts }, new Error('x'.repeat(900)))
  assert.deepEqual(calls.map(row => row.values[3]), [5, 10, 300])
  for (const row of calls) {
    assert.equal(row.values[0], job.objectKey); assert.equal(row.values[1], job.claim)
    assert.equal(String(row.values[2]).length, 600)
    assert.ok(row.sql.includes('WHERE object_key=$1 AND claim=$2::uuid'))
    assert.ok(row.sql.includes("attempts>=3 THEN 'failed' ELSE 'pending'"))
  }
})
