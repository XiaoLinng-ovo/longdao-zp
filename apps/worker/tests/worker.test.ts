import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'
import { classifyFailure, shouldRetryFailure, WorkerFailure } from '../src/errors.js'
import { createResumeAnalysisHandler, type ResumeAnalysisResult } from '../src/handlers/resume-analysis.js'
import { InMemoryIdempotencyStore, createTaskExecutor } from '../src/runner.js'
import { beginTaskAttempt, createTask, hasAttemptsRemaining, TaskExhaustedError, TaskValidationError } from '../src/task.js'
import { HealthStateStore, createHealthServer } from '../src/health.js'
import { startWorker } from '../src/worker.js'

const basePayload = {
  applicationId: 'app-1',
  resumeId: 'resume-1',
  fileName: 'resume.txt',
  mimeType: 'text/plain',
  text: '张三\nTypeScript Node.js PostgreSQL',
  source: 'test' as const,
}

void describe('worker task runtime', () => {
  it('validates task envelopes and advances attempts', () => {
    const task = createTask({ type: 'resume-analysis', payload: basePayload, maxAttempts: 2, idempotencyKey: 'idem-1' })
    assert.equal(task.attempts, 0)
    assert.equal(hasAttemptsRemaining(task), true)
    const started = beginTaskAttempt(task, new Date('2026-09-09T00:00:00.000Z'))
    assert.equal(started.attempts, 1)
    assert.equal(started.updatedAt, '2026-09-09T00:00:00.000Z')
    assert.throws(() => beginTaskAttempt({ ...started, attempts: 2 }), TaskExhaustedError)
    assert.throws(() => createTask({ type: 'resume-analysis', payload: basePayload, maxAttempts: 0, idempotencyKey: 'bad' }), TaskValidationError)
  })

  it('classifies retryable failures only while attempts remain', () => {
    assert.deepEqual(classifyFailure(new WorkerFailure('temporary queue outage', { category: 'dependency_unavailable' })), {
      category: 'dependency_unavailable',
      message: 'temporary queue outage',
      retryable: true,
    })
    assert.equal(shouldRetryFailure(new Error('invalid required field'), 1, 3), false)
    assert.equal(shouldRetryFailure(new WorkerFailure('timeout', { category: 'timeout' }), 1, 3), true)
    assert.equal(shouldRetryFailure(new WorkerFailure('timeout', { category: 'timeout' }), 3, 3), false)
  })

  it('runs resume analysis with an advisory-only result and de-duplicates successes', async () => {
    let calls = 0
    const store = new InMemoryIdempotencyStore()
    const executor = createTaskExecutor({
      idempotencyStore: store,
      now: () => '2026-09-09T00:00:00.000Z',
      handlers: {
        'resume-analysis': async (task, context) => {
          calls += 1
          return createResumeAnalysisHandler()(task, context)
        },
      },
    })
    const task = createTask({ type: 'resume-analysis', payload: basePayload, maxAttempts: 3, idempotencyKey: 'idem-success' })
    const first = await executor.execute<ResumeAnalysisResult>(task)
    const second = await executor.execute<ResumeAnalysisResult>(task)
    assert.equal(first.status, 'completed')
    assert.equal(first.attempts, 1)
    assert.equal(second.status, 'skipped')
    assert.equal(second.attempts, 1)
    assert.equal(calls, 1)
    assert.equal(first.result?.safety.advisoryOnly, true)
    assert.equal(first.result?.safety.applicationStatusMutation, 'none')
    assert.equal(first.result?.analysis.engine, 'deterministic-rules')
    assert.ok(first.result?.analysis.report.assessment)
  })

  it('does not invoke the handler twice for concurrent duplicate deliveries', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const executor = createTaskExecutor({
      handlers: {
        'resume-analysis': async () => {
          calls += 1
          await gate
          return { taskType: 'resume-analysis', status: 'completed', safety: { advisoryOnly: true, applicationStatusMutation: 'none' } } as ResumeAnalysisResult
        },
      },
    })
    const task = createTask({ type: 'resume-analysis', payload: basePayload, maxAttempts: 3, idempotencyKey: 'idem-concurrent' })
    const firstPromise = executor.execute<ResumeAnalysisResult>(task)
    const secondPromise = executor.execute<ResumeAnalysisResult>(task)
    await new Promise((resolve) => setImmediate(resolve))
    release()
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    assert.equal(first.status, 'completed')
    assert.equal(second.status, 'skipped')
    assert.equal(calls, 1)
  })

  it('returns a retryable result for transient handler failures', async () => {
    const executor = createTaskExecutor({
      handlers: {
        'resume-analysis': async () => {
          throw new WorkerFailure('model timeout', { category: 'timeout', code: 'MODEL_TIMEOUT' })
        },
      },
    })
    const task = createTask({ type: 'resume-analysis', payload: basePayload, maxAttempts: 2, idempotencyKey: 'idem-timeout' })
    const result = await executor.execute(task)
    assert.equal(result.status, 'failed')
    assert.equal(result.attempts, 1)
    assert.equal(result.retryable, true)
    assert.equal(result.failure?.code, 'MODEL_TIMEOUT')
  })

  it('rejects unsupported task types with a stable validation failure', async () => {
    const executor = createTaskExecutor()
    const result = await executor.execute({
      id: 'task-unsupported',
      type: 'offer-send',
      payload: {},
      attempts: 0,
      maxAttempts: 3,
      idempotencyKey: 'idem-unsupported',
      createdAt: '2026-09-09T00:00:00.000Z',
    })
    assert.equal(result.status, 'failed')
    assert.equal(result.retryable, false)
    assert.equal(result.failure?.code, 'UNSUPPORTED_TASK_TYPE')
  })
})

void describe('worker health', () => {
  let server: ReturnType<typeof createHealthServer> | undefined
  after(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  it('serves health and readiness probes', async () => {
    const config = loadConfig({ WORKER_HEALTH_PORT: '0', WORKER_ID: 'test-worker' }, 'test-host')
    const state = new HealthStateStore(config, () => '2026-09-09T00:00:00.000Z')
    server = createHealthServer(state)
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).status, 'starting')
    const readyBefore = await fetch(`${base}/ready`)
    assert.equal(readyBefore.status, 503)
    state.setState('ready')
    const readyAfter = await fetch(`${base}/ready`)
    assert.equal(readyAfter.status, 200)
  })

  it('loads ClamAV scanning only when a host is configured', () => {
    const disabled = loadConfig({}, 'test-host')
    const enabled = loadConfig({ CLAMAV_HOST: 'clamav', CLAMAV_PORT: '3311', CLAMAV_TIMEOUT_MS: '45000' }, 'test-host')
    assert.equal(disabled.clamavHost, undefined)
    assert.equal(enabled.clamavHost, 'clamav')
    assert.equal(enabled.clamavPort, 3311)
    assert.equal(enabled.clamavTimeoutMs, 45_000)
  })

  it('reports ClamAV as not configured when no scanner host is set', () => {
    const state = new HealthStateStore(loadConfig({}, 'test-host'))
    assert.equal(state.snapshot().externalDependencies.clamav, 'not_configured')
  })

  it('loads one OpenAI-compatible model only when all required settings exist', () => {
    const disabled = loadConfig({ OPENAI_BASE_URL: 'https://llm.example/v1' }, 'test-host')
    const enabled = loadConfig({
      OPENAI_BASE_URL: 'https://llm.example/v1/',
      OPENAI_API_KEY: 'secret',
      OPENAI_MODEL: 'resume-model',
      OPENAI_TIMEOUT_MS: '45000',
    }, 'test-host')
    assert.equal(disabled.openai, undefined)
    assert.deepEqual(enabled.openai, {
      baseUrl: 'https://llm.example/v1/', apiKey: 'secret', model: 'resume-model', timeoutMs: 45_000,
    })
    assert.equal(enabled.leaseDurationMs, 75_000)
    assert.equal(enabled.useLlmAnalysis, false)
    assert.equal(loadConfig({ WORKER_USE_LLM_ANALYSIS: 'true' }, 'test-host').useLlmAnalysis, true)
    assert.equal(loadConfig({ WORKER_LEASE_DURATION_MS: '200000' }, 'test-host').leaseDurationMs, 200_000)
  })

  it('loads bounded worker concurrency from environment', () => {
    assert.equal(loadConfig({}, 'test-host').concurrency, 3)
    assert.equal(loadConfig({ WORKER_CONCURRENCY: '8' }, 'test-host').concurrency, 8)
    assert.throws(() => loadConfig({ WORKER_CONCURRENCY: '0' }, 'test-host'), /WORKER_CONCURRENCY/)
    assert.throws(() => loadConfig({ WORKER_CONCURRENCY: '21' }, 'test-host'), /WORKER_CONCURRENCY/)
  })

  it('reports selected object storage readiness when the worker starts', async () => {
    const config = loadConfig({ WORKER_HEALTH_PORT: '0', WORKER_ID: 'storage-health-worker' }, 'test-host')
    const runtime = await startWorker(config, {
      storage: {
        kind: 'local', put: async () => undefined, get: async () => Buffer.alloc(0), delete: async () => undefined,
        health: async () => true,
      },
    })
    try {
      assert.equal(runtime.health.snapshot().externalDependencies.objectStorage, 'ok')
    } finally {
      await runtime.close()
    }
  })

  it('reports unavailable object storage without preventing worker readiness', async () => {
    const config = loadConfig({ WORKER_HEALTH_PORT: '0', WORKER_ID: 'storage-unavailable-worker' }, 'test-host')
    const runtime = await startWorker(config, {
      storage: {
        kind: 'local', put: async () => undefined, get: async () => Buffer.alloc(0), delete: async () => undefined,
        health: async () => false,
      },
    })
    try {
      assert.equal(runtime.health.snapshot().externalDependencies.objectStorage, 'unavailable')
      assert.equal(runtime.health.snapshot().status, 'ready')
    } finally {
      await runtime.close()
    }
  })
})

