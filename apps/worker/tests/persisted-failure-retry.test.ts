import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkerFailure } from '../src/errors.js'
import { processNextPersistedResumeAnalysis } from '../src/handlers/persisted-resume-analysis.js'
import { createTaskExecutor } from '../src/runner.js'
import type { PostgresAnalysisTaskStore, FailTaskInput } from '../src/db/analysis-task-store.js'

const task = { id: 'task', resumeId: 'resume', applicationId: 'app', status: 'processing', attempts: 1, idempotencyKey: 'key', createdAt: '2026-10-09', availableAt: '2026-10-09' }
for (const category of ['validation', 'network'] as const) {
  test(`payload ${category} failure persists the classified retry flag`, async () => {
    let failed: FailTaskInput | undefined
    const error = new WorkerFailure('fixture', { category, code: category === 'validation' ? 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH' : 'ECONNRESET' })
    const store = {
      claimNextTask: async () => ({ task, attempt: 1, maxAttempts: 3 }),
      saveExtractedCandidate: async () => {},
      failTask: async (input: FailTaskInput) => { failed = input; return task },
    } as unknown as PostgresAnalysisTaskStore
    await assert.rejects(processNextPersistedResumeAnalysis({
      store, executor: createTaskExecutor(), claim: { maxAttempts: 3, leaseDurationMs: 60_000 },
      payloadFor: async () => { throw error }, now: () => '2026-10-13T00:00:00.000Z',
    }), (cause) => cause === error)
    assert.equal(failed?.retryable, category === 'network')
    assert.equal(failed?.attempt, 1)
    assert.equal(failed?.maxAttempts, 3)
    assert.equal(failed?.retryAt, category === 'network' ? '2026-10-13T00:00:15.000Z' : undefined)
  })
  test(`analyzer ${category} failure persists the classified retry flag`, async () => {
    let failed: FailTaskInput | undefined
    let savedName: string | undefined
    const store = {
      claimNextTask: async () => ({ task, attempt: 1, maxAttempts: 3 }),
      saveExtractedCandidate: async (input: { candidate: { fullName?: string } }) => { savedName = input.candidate.fullName },
      failTask: async (input: FailTaskInput) => { failed = input; return task },
    } as unknown as PostgresAnalysisTaskStore
    const executor = createTaskExecutor({ handlers: { 'resume-analysis': async () => { throw new WorkerFailure('fixture', { category }) } } })
    const outcome = await processNextPersistedResumeAnalysis({
      store, executor, claim: { maxAttempts: 3, leaseDurationMs: 60_000 },
      payloadFor: async () => ({ resumeId: 'resume', fileName: 'resume.txt', text: '胡 俊 杰\n技能\nPython' }),
      now: () => '2026-10-13T00:00:00.000Z',
    })
    assert.equal(outcome?.execution.status, 'failed')
    assert.equal(savedName, '胡俊杰')
    assert.equal(failed?.retryable, category === 'network')
    assert.equal(failed?.attempt, 1)
    assert.equal(failed?.retryAt, category === 'network' ? '2026-10-13T00:00:15.000Z' : undefined)
  })
}
