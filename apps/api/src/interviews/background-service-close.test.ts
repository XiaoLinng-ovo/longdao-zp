import assert from 'node:assert/strict'
import { it } from 'node:test'
import { InterviewSummaryService } from './interview-summary-service.js'
import { QuestionSheetService } from './question-sheet-service.js'
import type { QuestionSheetRepository } from './question-sheet-repository.js'
import { createConfiguredInterviewSummaryService } from './interview-summary-service.js'
import { createConfiguredQuestionSheetService } from './question-sheet-runtime.js'
import { createConfiguredInterviewTranscriptPostprocessService } from './interview-transcript-postprocess-service.js'
import { createConfiguredQuestionPreparationService } from './question-preparation-runtime.js'
import type { Pool } from 'pg'

for (const kind of ['summary', 'sheets']) {
  it(kind + ' 关闭等待在途领取且不会重复释放资源', async () => {
    let release!: () => void, entered!: () => void, closes = 0, claims = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const claim = async () => { claims++; entered(); await gate; return null }
    const closeResources = async () => { closes++ }
    const service = kind === 'summary'
      ? new InterviewSummaryService({ claim } as never, {} as never, {} as never, async () => ({}), undefined, closeResources)
      : new QuestionSheetService({ claimPendingGeneration: claim } as unknown as QuestionSheetRepository, { closeResources })
    const run = () => service instanceof InterviewSummaryService ? service.processPending() : service.processPendingGeneration()
    const pending = run()
    await started
    const closing = service.close()
    assert.equal(service.close(), closing)
    await run()
    assert.equal(claims, 1)
    assert.equal(closes, 0)
    release()
    await pending
    await closing
    assert.equal(closes, 1)
  })
}

it('面试后台服务关闭不释放外部注入的共享连接池', async () => {
  let closed = 0
  const pool = { async end() { closed++ } } as unknown as Pool
  const services = [createConfiguredInterviewSummaryService(pool), createConfiguredQuestionSheetService(pool),
    createConfiguredInterviewTranscriptPostprocessService(pool), createConfiguredQuestionPreparationService({ pool })]
  try { await Promise.all(services.map(service => service.close())); assert.equal(closed, 0) }
  finally { await Promise.allSettled(services.map(service => service.close())) }
})
