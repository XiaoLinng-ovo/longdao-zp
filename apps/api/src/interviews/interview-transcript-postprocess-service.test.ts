import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InterviewTranscriptPostprocessService } from './interview-transcript-postprocess-service.js'
import type { TranscriptPostprocessJob, TranscriptVersionInput } from './interview-transcript-postprocess-repository.js'
import type { RawTranscriptSnapshot } from './transcript-postprocessing.js'
import { SemanticRoleReviewer } from './semantic-role-review.js'

const job: TranscriptPostprocessJob = { sessionId: 'session-1', applicationId: 'application-1',
  claim: 'claim-1', attempts: 1, phase: 'offline_reidentification' }

function fixture(speakerConfirmed: boolean, reviewer?: SemanticRoleReviewer) {
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
    { async getApplicationJobContext() { return null } }, async () => reviewer
      ? ({ OPENAI_BASE_URL: 'https://model.test/v1', OPENAI_API_KEY: 'test', OPENAI_MODEL: 'test-model' }) : ({}), reviewer)
  return { service, getPublished: () => published }
}

describe('interview transcript postprocess service role review', () => {
  it('publishes context-inferred roles and provenance without marking them manually confirmed', async () => {
    const reviewer = new SemanticRoleReviewer(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const input = JSON.parse(request.messages[1].content)
      return Response.json({ choices: [{ message: { content: JSON.stringify({ turns: input.turnsToReview.map((row: { turnId: string }) => ({
        turnId: row.turnId, role: 'candidate', confidence: .95, mixed: false, reason: '说明本人负责的项目工作',
      })) }) } }] })
    })
    const f = fixture(false, reviewer)
    await f.service.processPending()
    assert.equal(f.getPublished()?.roleReviewRequired, false)
    assert.equal(f.getPublished()?.turns[0]?.roleReview?.status, 'inferred')
    assert.equal(f.getPublished()?.turns[0]?.speakerConfirmed, false)
    assert.equal(f.getPublished()?.evidence.length, 1)
  })

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

describe('转写后处理资源关闭', () => {
  for (const blockedStage of ['claim', 'correct', 'review', 'publish']) {
    it('等待 ' + blockedStage + ' 完成后才释放资源且不再领取新任务', async () => {
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const events: string[] = []
      let claims = 0
      const stage = async (name: string) => {
        events.push(name)
        if (name === blockedStage) { enter(); await gate }
      }
      const repository = {
        async claim() { claims++; await stage('claim'); return job },
        async load() { return { fingerprint: 'test', sessionDurationMs: 0, manifest: [], segments: [] } },
        async updatePhase() { return true },
        async retry() { assert.fail('不应进入重试') },
        async publish() { await stage('publish'); return 'published' as const },
      }
      const service = new InterviewTranscriptPostprocessService(repository,
        { async reidentify() { return { segments: [], warnings: [], routes: [] } }, async close() { events.push('reidentifier-close') } },
        { async correct({ turns }) { await stage('correct'); return { turns, corrections: [], uncertainties: [], warnings: [] } } },
        { async getApplicationJobContext() { return null } }, async () => ({}),
        { async review(turns: never[]) { await stage('review'); return { turns, warnings: [] } } } as unknown as SemanticRoleReviewer,
        async () => { events.push('resources-close') })
      const work = service.processPending()
      await entered
      const closing = service.close()
      assert.equal(service.close(), closing)
      assert.equal(await service.processPending(), false)
      assert.equal(await service.processSession('session-2'), false)
      assert.equal(claims, 1)
      await new Promise(resolve => setImmediate(resolve))
      assert.ok(!events.includes('resources-close'))
      assert.ok(!events.includes('reidentifier-close'))
      release()
      await work
      await closing
      assert.deepEqual(events.slice(-3), ['publish', 'reidentifier-close', 'resources-close'])
    })
  }

  it('离线资源关闭失败仍释放自有依赖并向调用方返回失败', async () => {
    let released = 0
    const service = new InterviewTranscriptPostprocessService({} as never,
      { async reidentify() { throw new Error('禁止推理') }, async close() { throw new Error('关闭失败') } },
      {} as never, {} as never, async () => ({}), undefined, async () => { released++ })
    await assert.rejects(service.close(), /关闭失败/)
    assert.equal(released, 1)
    await assert.rejects(service.close(), /关闭失败/)
    assert.equal(released, 1)
  })
})
