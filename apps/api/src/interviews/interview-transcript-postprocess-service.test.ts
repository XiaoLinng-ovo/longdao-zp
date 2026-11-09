import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InterviewTranscriptPostprocessService } from './interview-transcript-postprocess-service.js'
import type { TranscriptPostprocessJob, TranscriptVersionInput } from './interview-transcript-postprocess-repository.js'
import type { RawTranscriptSnapshot } from './transcript-postprocessing.js'

const job: TranscriptPostprocessJob = { sessionId: 'session-1', applicationId: 'application-1',
  claim: 'claim-1', attempts: 1, phase: 'offline_reidentification' }

function fixture(speakerConfirmed: boolean) {
  const snapshot: RawTranscriptSnapshot = {
    fingerprint: 'fingerprint-1',
    sessionDurationMs: 5000,
    segments: [{ id: 'segment-1', speakerId: 'voice-1', role: 'candidate', confidence: .9,
      speakerConfirmed, text: '\u6211\u8d1f\u8d23\u7cfb\u7edf\u5f00\u53d1\u3002', startMs: 1000, endMs: 2500, audioSource: 'microphone' }],
    manifest: [{ id: 'audio-1', sessionId: job.sessionId, sessionStartedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z', objectKey: 'audio-1', offsetMs: 0, endMs: 5000,
      byteLength: 100, contentType: 'audio/webm', audioSource: 'microphone', sourceMultipleSpeakers: true,
      sourceRole: 'unknown' }],
  }
  let published: TranscriptVersionInput | undefined
  const repository = {
    async claim() { return job },
    async load() { return snapshot },
    async updatePhase() { return true },
    async retry() {},
    async publish(_job: TranscriptPostprocessJob, _fingerprint: string, input: TranscriptVersionInput) {
      published = input
      return 'published' as const
    },
  }
  const service = new InterviewTranscriptPostprocessService(repository as never,
    { async reidentify() { return { segments: [], warnings: [], routes: [] } } },
    { async correct({ turns }) { return { turns, corrections: [], uncertainties: [], warnings: [] } } },
    { async getApplicationJobContext() { return null } }, async () => ({}))
  return { service, getPublished: () => published }
}

describe('interview transcript postprocess service role review', () => {
  it('publishes a review-required version while mixed-source speaker roles are unconfirmed', async () => {
    const f = fixture(false)
    assert.equal(await f.service.processPending(), true)
    assert.equal(f.getPublished()?.roleReviewRequired, true)
    assert.ok(f.getPublished()?.warnings.some(warning => warning.includes('\u89d2\u8272\u590d\u6838\u672a\u5b8c\u6210')))
    assert.equal(f.getPublished()?.turns[0]?.speakerConfirmed, false)
  })

  it('clears the review requirement after raw segments are manually confirmed', async () => {
    const f = fixture(true)
    assert.equal(await f.service.processPending(), true)
    assert.equal(f.getPublished()?.roleReviewRequired, false)
    assert.ok(!f.getPublished()?.warnings.some(warning => warning.includes('\u89d2\u8272\u590d\u6838\u672a\u5b8c\u6210')))
    assert.equal(f.getPublished()?.turns[0]?.speakerConfirmed, true)
  })
})
