import type { Server } from 'node:http'
import type { Pool as PgPool } from 'pg'
import type { WorkerConfig } from './config.js'
import { HealthStateStore, startHealthServer } from './health.js'
import { createTaskExecutor, type TaskExecutor } from './runner.js'
import { createWorkerPool, loadWorkerPoolConfig } from './db/pool.js'
import { startPersistedPoll } from './db/persisted-poll.js'
import { createPostgresAnalysisTaskStore } from './db/analysis-task-store.js'
import { ClamdClient } from './security/clamd-client.js'
import { startResumeScanPoll } from './security/resume-scan.js'
import { resolve } from 'node:path'
import { createObjectStorageFromEnv, type ObjectStorage } from '@smartrecruit-pro/object-storage'
import { createOpenAIResumeAnalyzer } from './handlers/openai-resume-analyzer.js'
import { createResumeAnalysisHandler } from './handlers/resume-analysis.js'

export interface WorkerRuntime {
  readonly config: WorkerConfig
  readonly executor: TaskExecutor
  readonly health: HealthStateStore
  readonly healthServer: Server
  close(): Promise<void>
}

export interface StartWorkerOptions {
  executor?: TaskExecutor
  now?: () => string
  /** Pool used when DB polling is enabled; creates one from env when omitted. */
  pool?: PgPool
  storage?: ObjectStorage
}

export async function startWorker(config: WorkerConfig, options: StartWorkerOptions = {}): Promise<WorkerRuntime> {
  const now = options.now ?? (() => new Date().toISOString())
  const health = new HealthStateStore(config, now)
  const executor = options.executor ?? createTaskExecutor({
    now,
    ...(config.openai === undefined ? {} : {
      handlers: {
        'resume-analysis': createResumeAnalysisHandler({ analyze: createOpenAIResumeAnalyzer(config.openai) }),
      },
    }),
  })
  const healthServer = await startHealthServer(config, health)

  let stopPoll: (() => void) | undefined
  let stopResumeScanPoll: (() => void) | undefined
  let pool: PgPool | undefined
  const storage = options.storage ?? createObjectStorageFromEnv(process.env, config.quarantineRoot ?? resolve(process.cwd(), '../../data/resumes/quarantine'))
  try {
    health.setDependency('objectStorage', await storage.health() ? 'ok' : 'unavailable')
  } catch {
    health.setDependency('objectStorage', 'error')
  }
  if (config.clamavHost) {
    try {
      await new ClamdClient({ host: config.clamavHost, port: config.clamavPort, timeoutMs: config.clamavTimeoutMs }).ping()
      health.setDependency('clamav', 'ok')
    } catch {
      health.setDependency('clamav', 'unavailable')
    }
  }

  if (config.pollPostgres) {
    pool = options.pool ?? createWorkerPool(loadWorkerPoolConfig())
    stopPoll = startPersistedPoll({
      pool,
      maxAttempts: config.maxAttempts,
      leaseDurationMs: config.leaseDurationMs,
      pollIntervalMs: config.pollIntervalMs,
      now,
      storage,
      executor,
    })
    health.setDependency('postgres', 'ok')
    if (config.clamavHost) {
      stopResumeScanPoll = startResumeScanPoll({
        store: createPostgresAnalysisTaskStore(pool),
        scanner: new ClamdClient({ host: config.clamavHost, port: config.clamavPort, timeoutMs: config.clamavTimeoutMs }),
        storage,
        pollIntervalMs: config.pollIntervalMs,
      })
    }
  }

  health.setState('ready')

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    health.setState('stopping')
    stopPoll?.()
    stopResumeScanPoll?.()
    if (pool) { try { await pool.end() } catch { /* pool already closed */ } }
    await new Promise<void>((resolve, reject) => {
      healthServer.close((error) => (error ? reject(error) : resolve()))
    })
    health.setState('stopped')
  }

  return { config, executor, health, healthServer, close }
}
