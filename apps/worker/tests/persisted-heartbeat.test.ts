import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import type { PostgresAnalysisTaskStore } from '../src/db/analysis-task-store.js'
import { processNextPersistedResumeAnalysis } from '../src/handlers/persisted-resume-analysis.js'
import { createTaskExecutor } from '../src/runner.js'
import { resumeAnalysisHandler } from '../src/handlers/resume-analysis.js'

const task = { id: 'heartbeat-task', resumeId: 'resume', applicationId: 'application', status: 'processing', attempts: 1, idempotencyKey: 'key', createdAt: '2026-11-13', availableAt: '2026-11-13' }
function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

for (const failPayload of [false, true]) {
  test('慢续租不重叠，终态与释放等待已发心跳：' + (failPayload ? '读取失败' : '执行完成'), { timeout: 5000 }, async () => {
    const entered = gate(), renewal = gate(), execution = gate()
    const events: string[] = []
    let calls = 0, active = 0, peak = 0
    const store = {
      sharedBudget: { platform: 1, workspace: 1 },
      claimNextTask: async () => ({ task, attempt: 1, maxAttempts: 3 }),
      heartbeat: async () => {
        calls++; active++; peak = Math.max(peak, active); events.push('heartbeat-start'); entered.release()
        await renewal.wait
        active--; events.push('heartbeat-end')
      },
      completeTask: async () => { assert.equal(active, 0); events.push('complete') },
      failTask: async () => { assert.equal(active, 0); events.push('fail') },
      releaseExecutionSlot: async () => { assert.equal(active, 0); events.push('release') },
    } as unknown as PostgresAnalysisTaskStore
    const executor = createTaskExecutor({ handlers: { 'resume-analysis': async (envelope, context) => {
      await execution.wait
      return resumeAnalysisHandler({ ...envelope, payload: { ...envelope.payload, text: 'Synthetic engineer resume with TypeScript and database experience' } }, context)
    } } })
    const running = processNextPersistedResumeAnalysis({ store, executor, claim: { maxAttempts: 3, leaseDurationMs: 300 },
      payloadFor: async () => { if (failPayload) { await execution.wait; throw new Error('payload failed') } return { resumeId: 'resume', fileName: 'resume.txt' } },
    })
    const settled = running.then(() => 'completed', error => error.message)
    try {
      await entered.wait
      await delay(250)
      assert.equal(calls, 1)
      assert.equal(peak, 1)
      execution.release()
      await delay(25)
      assert.deepEqual(events, ['heartbeat-start'])
      renewal.release()
      assert.equal(await settled, failPayload ? 'payload failed' : 'completed')
      assert.deepEqual(events, ['heartbeat-start', 'heartbeat-end', failPayload ? 'fail' : 'complete', 'release'])
      await delay(120)
      assert.equal(calls, 1)
    } finally { execution.release(); renewal.release(); await settled }
  })
}

test('续租失败不写完成状态，并在释放前排空', { timeout: 5000 }, async () => {
  const renewed = gate(), execution = gate()
  const events: string[] = []
  const store = {
    sharedBudget: { platform: 1, workspace: 1 },
    claimNextTask: async () => ({ task, attempt: 1, maxAttempts: 3 }),
    heartbeat: async () => { events.push('heartbeat-failed'); renewed.release(); throw new Error('lease lost') },
    completeTask: async () => { events.push('unexpected-complete') },
    releaseExecutionSlot: async () => { events.push('release') },
  } as unknown as PostgresAnalysisTaskStore
  const executor = createTaskExecutor({ handlers: { 'resume-analysis': async (envelope, context) => {
    await execution.wait
    return resumeAnalysisHandler({ ...envelope, payload: { ...envelope.payload, text: 'Synthetic engineer resume with TypeScript and database experience' } }, context)
  } } })
  const running = processNextPersistedResumeAnalysis({ store, executor, claim: { maxAttempts: 3, leaseDurationMs: 300 },
    payloadFor: () => ({ resumeId: 'resume', fileName: 'resume.txt' }),
  })
  const rejected = assert.rejects(running, /ANALYSIS_TASK_LEASE_LOST/)
  try { await renewed.wait; execution.release(); await rejected; assert.deepEqual(events, ['heartbeat-failed', 'release']) }
  finally { execution.release(); await rejected }
})
