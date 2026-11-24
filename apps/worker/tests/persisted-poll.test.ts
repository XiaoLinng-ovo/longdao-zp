import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import type { AnalysisTaskRecord, PgPool, PostgresAnalysisTaskStore } from '../src/db/analysis-task-store.js'
import { startPersistedPoll } from '../src/db/persisted-poll.js'
import { createTaskExecutor } from '../src/runner.js'
import { createConcurrencyBudget } from '../src/db/concurrency-budget.js'

test('stopping interrupts a long idle wait and is idempotent', { timeout: 5000 }, async () => {
  let claimed = 0
  const stop = startPersistedPoll({
    pool: {} as PgPool, maxAttempts: 3, leaseDurationMs: 360_000, pollIntervalMs: 60_000,
    store: { async claimNextTask() { claimed++; return undefined } } as unknown as PostgresAnalysisTaskStore,
  })
  await delay(20)
  try {
    assert.equal(claimed, 1)
    const closing = stop()
    assert.equal(stop(), closing)
    await closing
    assert.equal(claimed, 1)
  } finally { await stop() }
})

test('stopping cancels a queued shared permit without waiting for another company', { timeout: 5000 }, async () => {
  const acquire = createConcurrencyBudget(1)
  const release = await acquire()
  let claimed = 0
  const stop = startPersistedPoll({
    pool: {} as PgPool, maxAttempts: 3, leaseDurationMs: 360_000, pollIntervalMs: 60_000,
    acquirePermit: acquire,
    store: { async claimNextTask() { claimed++; return undefined } } as unknown as PostgresAnalysisTaskStore,
  })
  try {
    await stop()
    assert.equal(claimed, 0)
  } finally { release(); await stop() }
  ;(await acquire())()
})

test('stopping still drains an active claim before releasing dependencies', { timeout: 5000 }, async () => {
  let finish!: () => void
  let entered!: () => void
  const claimed = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<undefined>(resolve => { finish = () => resolve(undefined) })
  const stop = startPersistedPoll({
    pool: {} as PgPool, maxAttempts: 3, leaseDurationMs: 360_000, pollIntervalMs: 60_000,
    store: { claimNextTask() { entered(); return gate } } as unknown as PostgresAnalysisTaskStore,
  })
  await claimed
  let closed = false
  const closing = stop().then(() => { closed = true })
  try {
    await delay(20)
    assert.equal(closed, false)
    finish()
    await closing
    assert.equal(closed, true)
  } finally { finish(); await closing }
})

for (const concurrency of [1, 3, 5]) {
  test(`persisted batch limits in-flight work to ${concurrency} and continues after a bad file`, { timeout: 5000 }, async () => {
    const timestamp = '2026-10-19T00:00:00.000Z'
    const pending: AnalysisTaskRecord[] = Array.from({ length: 12 }, (_, index) => ({
      id: `task-${index}`, resumeId: `resume-${index}`, status: 'processing', attempts: 1,
      idempotencyKey: `fixture-${index}`, availableAt: timestamp, createdAt: timestamp,
    }))
    let inFlight = 0
    let peak = 0
    const completed: string[] = []
    const failed: string[] = []
    const errors: string[] = []
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const settled = () => {
      inFlight--
      if (completed.length + failed.length === 12) finish()
    }
    const store = {
      async claimNextTask() {
        const task = pending.shift()
        if (!task) return undefined
        peak = Math.max(peak, ++inFlight)
        return { task, attempt: 1, maxAttempts: 3 }
      },
      async getResumeAnalysisSource(resumeId: string) {
        return { resumeId, candidateId: 'candidate-1', storageKey: resumeId, originalFilename: 'resume.txt', mimeType: 'text/plain' }
      },
      async saveExtractedCandidate() {},
      async completeTask(input: { taskId: string }) { completed.push(input.taskId); settled() },
      async failTask(input: { taskId: string }) { failed.push(input.taskId); settled() },
    } as unknown as PostgresAnalysisTaskStore
    const storage: ObjectStorage = {
      kind: 'local', async put() {}, async delete() {}, async health() { return true },
      async get(key) {
        await delay(5)
        if (key === 'resume-0') throw new Error('fixture unreadable resume')
        return Buffer.from('John Smith\nSkills: Java and PostgreSQL\nExperience: 5 years in backend development')
      },
    }
    const stop = startPersistedPoll({
      pool: {} as PgPool, store, storage, executor: createTaskExecutor(),
      maxAttempts: 3, leaseDurationMs: 360_000, pollIntervalMs: 5, concurrency,
      logger: { log() {}, warn() {}, error(message: string) { errors.push(message) } },
    })
    try {
      await done
      assert.equal(peak, concurrency)
      assert.equal(inFlight, 0)
      assert.equal(pending.length, 0)
      assert.equal(completed.length, 11)
      assert.equal(new Set(completed).size, 11)
      assert.deepEqual(failed, ['task-0'])
      assert.equal(errors.length, 1)
      assert.match(errors[0]!, /fixture unreadable resume/)
    } finally {
      await stop()
    }
  })
}
