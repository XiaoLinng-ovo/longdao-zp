import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FunAsrError } from './funasr-client.js'
import { LiveAudioTranscriptionService } from './live-audio-transcription.js'
import type { AudioTranscriptionJob, TranscribedSegmentInput } from './live-audio-transcription-repository.js'
import type { LiveSegment, LiveSession } from './live-session-repository.js'
import type { SpeakerSegment } from './role-mapper.js'
import { SessionVoiceprintTracker } from './voiceprint-tracker.js'

const job: AudioTranscriptionJob = { objectKey: 'saved-audio', sessionId: 'session-1', contentType: 'audio/webm',
  offsetMs: 15000, endMs: 30000, claim: 'claim-1', attempts: 1 }
const session: LiveSession = { id: job.sessionId, interviewId: 'interview-1', status: 'active', externalStatus: 'ready',
  startedAt: '2026-10-26T00:00:00Z', createdBy: 'recruiter', currentQuestion: '' }
const speech: SpeakerSegment = { id: 'speech-1', speakerId: 'speaker-1', text: 'I delivered the project.', startMs: 0, endMs: 16000 }

function harness(options: { job?: AudioTranscriptionJob | null; status?: string; readError?: Error;
  transcribeError?: Error; rows?: SpeakerSegment[]; segments?: LiveSegment[]; pending?: number } = {}) {
  const completed: Array<{ job: AudioTranscriptionJob; segments: TranscribedSegmentInput[] }> = []
  const retried: unknown[] = [], forgotten: string[] = []
  let transcribed = 0
  const voices = new SessionVoiceprintTracker()
  voices.forget = id => { forgotten.push(id) }
  const service = new LiveAudioTranscriptionService({
    claim: async () => options.job === null ? null : options.job ?? job,
    complete: async (claimed, segments) => { completed.push({ job: claimed, segments }); return true },
    retry: async (_claimed, error) => { retried.push(error) },
    progress: async () => ({ pendingCount: options.pending ?? 0, retryingCount: 0 }),
    relabelFromEvidence: async () => 0,
  }, { get: async () => ({ session: { ...session, status: options.status ?? 'active' }, segments: options.segments ?? [] }) }, {
    read: async key => { assert.equal(key, job.objectKey); if (options.readError) throw options.readError; return Buffer.from('audio') },
  }, voices, async (audio, contentType) => {
    transcribed++
    assert.equal(Buffer.from(audio).toString(), 'audio'); assert.equal(contentType, 'audio/webm')
    if (options.transcribeError) throw options.transcribeError
    return options.rows ?? [speech]
  })
  return { service, completed, retried, forgotten, transcribed: () => transcribed }
}

test('an idle transcription queue performs no storage or recognition work', async () => {
  const h = harness({ job: null })
  assert.equal(await h.service.processPending(), false)
  assert.equal(h.transcribed(), 0); assert.deepEqual(h.completed, [])
})

test('background recognition reads saved audio and clamps timestamps to the real recording', async () => {
  const h = harness({ rows: [speech, { ...speech, id: 'out-of-range', startMs: 16000, endMs: 17000 }] })
  assert.equal(await h.service.processPending(), true)
  assert.equal(h.completed.length, 1); assert.equal(h.completed[0]!.segments.length, 1)
  const segment = h.completed[0]!.segments[0]!
  assert.equal(segment.audioObjectKey, job.objectKey)
  assert.deepEqual([segment.startMs, segment.endMs], [15000, 30000])
  assert.deepEqual(h.retried, [])
})

test('a recognition outage retries without deleting the already saved audio', async () => {
  const error = new FunAsrError('UPSTREAM', 'temporarily offline')
  const h = harness({ transcribeError: error })
  assert.equal(await h.service.processPending(), true)
  assert.deepEqual(h.retried, [error]); assert.deepEqual(h.completed, [])
})

test('a persisted streaming checkpoint survives a recognition outage without inventing a speaker role', async () => {
  const text = 'The complete answer was preserved in the stream.'
  const h = harness({ job: { ...job, checkpoint: { text, endMs: job.endMs, complete: true } },
    transcribeError: new FunAsrError('TIMEOUT', 'recognition timeout') })
  await h.service.processPending()
  const segment = h.completed[0]!.segments[0]!
  assert.equal(segment.text, text); assert.equal(segment.role, 'unknown'); assert.ok(segment.confidence < .6)
  assert.deepEqual([segment.startMs, segment.endMs], [job.offsetMs, job.endMs])
})

test('storage failures retry even when a text checkpoint is available', async () => {
  const error = new Error('storage offline')
  const h = harness({ job: { ...job, checkpoint: { text: 'Saved stream.', endMs: job.endMs, complete: true } }, readError: error })
  await h.service.processPending()
  assert.equal(h.transcribed(), 0); assert.deepEqual(h.completed, []); assert.deepEqual(h.retried, [error])
})

for (const checkpoint of [
  { text: 'Only the first few words.', endMs: job.endMs, complete: false },
  { text: ' ', endMs: job.endMs, complete: true },
]) test(`recognition retries rather than finalizing an incomplete or empty checkpoint: ${JSON.stringify(checkpoint)}`, async () => {
  const error = new FunAsrError('TIMEOUT', 'recognition timeout')
  const h = harness({ job: { ...job, checkpoint }, transcribeError: error })
  await h.service.processPending()
  assert.deepEqual(h.completed, [])
  assert.deepEqual(h.retried, [error])
})

test('unexpected recognition failures do not silently commit an empty transcript', async () => {
  const error = new Error('unexpected decoder error')
  const h = harness({ job: { ...job, checkpoint: { text: 'Saved stream.', endMs: job.endMs, complete: true } }, transcribeError: error })
  await h.service.processPending()
  assert.deepEqual(h.completed, []); assert.deepEqual(h.retried, [error])
})

test('a completed interview continues transcribing in the background and releases voice state only after draining', async () => {
  const remaining = harness({ status: 'completed', pending: 1 })
  await remaining.service.processPending()
  assert.equal(remaining.completed.length, 1); assert.deepEqual(remaining.forgotten, [])
  const drained = harness({ status: 'completed' })
  await drained.service.processPending()
  assert.equal(drained.completed.length, 1); assert.deepEqual(drained.forgotten, [job.sessionId])
})

test('background transcription preserves an in-room human speaker correction', async () => {
  const h = harness({ segments: [{ id: 'earlier', sessionId: job.sessionId, speakerId: 'chunk_15000:speaker-1',
    text: 'Earlier correction.', role: 'interviewer', confidence: 1, startMs: 0, endMs: 1000, status: 'transcribed' }] })
  await h.service.processPending()
  assert.equal(h.completed[0]!.segments[0]!.role, 'interviewer')
  assert.equal(h.completed[0]!.segments[0]!.confidence, 1)
})

test('background transcription infers opening roles without source overrides and preserves them across later chunks', async () => {
  const opening = harness({ job: { ...job, source: { id: 'microphone', role: 'unknown', multipleSpeakers: true } }, rows: [
    { id: 'q', speakerId: 'speaker_0', text: '请介绍一下你的工作经历？', startMs: 0, endMs: 2000, speakerVerified: true, speakerEmbedding: [1, 0] },
    { id: 'a', speakerId: 'speaker_1', text: '我有五年开发经验。', startMs: 2200, endMs: 4000, speakerVerified: true, speakerEmbedding: [0, 1] },
  ] })
  await opening.service.processPending()
  const rows = opening.completed[0]!.segments
  assert.deepEqual(rows.map(row => row.role), ['interviewer', 'candidate'])
  assert.ok(rows.every(row => row.confidence < 1 && row.speakerId.startsWith('microphone:voice_')))
  const later = harness({ job: { ...job, source: { id: 'microphone', role: 'unknown', multipleSpeakers: true } },
    segments: rows.map((row, index) => ({ ...row, id: 'opening-' + index, sessionId: job.sessionId, status: 'transcribed' })),
    rows: [{ id: 'reverse', speakerId: rows[1]!.speakerId.replace('microphone:', ''),
      text: '请介绍一下你们团队的项目？', startMs: 0, endMs: 2000, speakerVerified: true }] })
  await later.service.processPending()
  assert.equal(later.completed[0]!.segments[0]!.role, 'candidate')
  assert.equal(later.completed[0]!.segments[0]!.confidence, .82)
  assert.deepEqual(later.retried, [])
})
