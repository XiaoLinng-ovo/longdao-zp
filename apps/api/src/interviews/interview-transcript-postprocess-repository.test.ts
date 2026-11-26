import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InterviewTranscriptPostprocessRepository, type TranscriptPostprocessJob, type TranscriptVersionInput } from './interview-transcript-postprocess-repository.js'
import { rawSnapshotFingerprint, type RawTranscriptSegment } from './transcript-postprocessing.js'

const job: TranscriptPostprocessJob = { sessionId: 'session-1', applicationId: 'application-1',
  claim: '00000000-0000-4000-8000-000000000001', attempts: 1, phase: 'offline_reidentification' }
const emptyVersion: TranscriptVersionInput = { turns: [], evidence: [], corrections: [], uncertainties: [], warnings: [], audioRoutes: ['live-realtime'] }
const raw = (text: string): RawTranscriptSegment => ({ id: 'segment-1', speakerId: 'voice-1', role: 'candidate',
  confidence: .9, text, startMs: 0, endMs: 1000 })

function fixture(overrides: { currentFingerprint?: string; pointer?: string | null; insertId?: string; existingId?: string; paused?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, ...(values ? { values } : {}) })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (sql.includes('FROM interview_transcript_postprocess_jobs j')) return { rows: [{
        status: 'processing', claim: job.claim, session_status: overrides.paused ? 'paused' : 'completed', ended_at: '2026-01-01T00:00:01Z',
        corrected_transcript_version_id: overrides.pointer ?? null, summary_status: 'pending', summary_report: null,
      }] }
      if (sql.startsWith('SELECT * FROM interview_live_segments')) return { rows: overrides.currentFingerprint === 'changed'
        ? [{ id: 'segment-1', session_id: job.sessionId, speaker_id: 'voice-1', role: 'candidate', role_confidence: .9,
            text: '新到的实时字幕', start_ms: 0, end_ms: 1000 }]
        : [] }
      if (sql.includes('FROM interview_audio_recordings')) return { rows: [] }
      if (sql.startsWith('SELECT started_at,ended_at FROM interview_live_sessions')) return { rows: [{
        started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z',
      }] }
      if (sql.startsWith('INSERT INTO interview_transcript_versions')) return { rows: overrides.insertId ? [{ id: overrides.insertId }] : [] }
      if (sql.startsWith('SELECT id FROM interview_transcript_versions')) return { rows: overrides.existingId ? [{ id: overrides.existingId }] : [] }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { repository: new InterviewTranscriptPostprocessRepository({ async connect() { return client } } as never), calls }
}

describe('transcript postprocess transactional publication', () => {
  it('completes a stopped session after canonical publication in the same transaction', async () => {
    const f = fixture({ paused: true, insertId: 'canonical-version' })
    assert.equal(await f.repository.publish(job, rawSnapshotFingerprint([], [], 1000), emptyVersion), 'published')
    const completed = f.calls.findIndex(call => call.sql.startsWith("UPDATE interview_live_sessions SET status='completed'"))
    const published = f.calls.findIndex(call => call.sql.startsWith("UPDATE interview_transcript_postprocess_jobs SET status='completed'"))
    assert.ok(completed > published)
    assert.equal(f.calls.at(-1)!.sql, 'COMMIT')
  })
  it('stops retrying exhausted postprocess jobs without losing the claim guard', async () => {
    let captured = ''
    let parameters: unknown[] = []
    const repository = new InterviewTranscriptPostprocessRepository({ query: async (sql: string, values: unknown[]) => { captured = sql; parameters = values } } as never)
    await repository.retry({ ...job, attempts: 3 }, new Error('synthetic failure'))
    assert.match(captured, /attempts>=3 THEN 'failed' ELSE 'pending'/u)
    assert.ok(captured.includes('claim=$2::uuid'))
    assert.equal(parameters[1], job.claim)
  })

  it('prefers ready pending work over stale processing claims', async () => {
    let captured = ''
    const repository = new InterviewTranscriptPostprocessRepository({ async query(sql: string) {
      captured = sql
      return { rows: [], rowCount: 0 }
    } } as never)

    assert.equal(await repository.claim(), null)
    assert.match(captured, /ORDER BY \(q\.status='pending'\) DESC/iu)
  })

  it('can claim only one explicitly requested interview', async () => {
    let captured = ''
    let capturedValues: unknown[] | undefined
    const repository = new InterviewTranscriptPostprocessRepository({ async query(sql: string, values?: unknown[]) {
      captured = sql
      capturedValues = values
      return { rows: [], rowCount: 0 }
    } } as never)

    assert.equal(await repository.claim('00000000-0000-4000-8000-000000000123'), null)
    assert.match(captured, /\$2::uuid IS NULL OR q\.session_id=\$2::uuid/iu)
    assert.equal(capturedValues?.[1], '00000000-0000-4000-8000-000000000123')
  })

  it('discards a result when raw evidence changed during recognition', async () => {
    const f = fixture({ currentFingerprint: 'changed' })
    const expected = rawSnapshotFingerprint([raw('旧字幕')], [], 1000)
    const outcome = await f.repository.publish(job, expected, emptyVersion)

    assert.equal(outcome, 'stale')
    assert.ok(!f.calls.some(call => call.sql.startsWith('INSERT INTO interview_transcript_versions')))
    assert.ok(!f.calls.some(call => call.sql.startsWith('UPDATE interview_live_sessions')))
    assert.ok(f.calls.some(call => call.sql.includes("error='原始字幕或录音清单已变化")))
    assert.equal(f.calls.at(-1)!.sql, 'COMMIT')
  })

  it('reuses an immutable version and does not invalidate an already-pending summary twice', async () => {
    const f = fixture({ pointer: '00000000-0000-4000-8000-000000000099',
      existingId: '00000000-0000-4000-8000-000000000099' })
    const expected = rawSnapshotFingerprint([], [], 1000)
    const outcome = await f.repository.publish(job, expected, emptyVersion)

    assert.equal(outcome, 'published')
    const insert = f.calls.find(call => call.sql.startsWith('INSERT INTO interview_transcript_versions'))
    assert.match(insert!.sql, /ON CONFLICT \(session_id,content_fingerprint\) DO NOTHING/u)
    const sessionUpdate = f.calls.find(call => call.sql.startsWith('UPDATE interview_live_sessions'))
    assert.equal(sessionUpdate!.values?.[2], false)
    assert.ok(!f.calls.some(call => call.sql.startsWith('UPDATE interview_transcript_versions')))
    assert.ok(f.calls.some(call => call.sql.includes("status='completed'")))
    assert.equal(f.calls.at(-1)!.sql, 'COMMIT')
  })
})
