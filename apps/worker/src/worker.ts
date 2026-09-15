import type { Server } from 'node:http'
import type { Pool as PgPool } from 'pg'
import type { WorkerConfig } from './config.js'
import { HealthStateStore, startHealthServer } from './health.js'
import { createTaskExecutor, type TaskExecutor } from './runner.js'
import { createWorkerPool, loadWorkerPoolConfig } from './db/pool.js'
import { startPersistedPoll } from './db/persisted-poll.js'

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
}

export async function startWorker(config: WorkerConfig, options: StartWorkerOptions = {}): Promise<WorkerRuntime> {
  const now = options.now ?? (() => new Date().toISOString())
  const health = new HealthStateStore(config, now)
  const executor = options.executor ?? createTaskExecutor({ now })
  const healthServer = await startHealthServer(config, health)

  let stopPoll: (() => void) | undefined
  let pool: PgPool | undefined

  if (config.pollPostgres) {
    pool = options.pool ?? createWorkerPool(loadWorkerPoolConfig())
    stopPoll = startPersistedPoll({
      pool,
      maxAttempts: config.maxAttempts,
      leaseDurationMs: config.leaseDurationMs,
      pollIntervalMs: config.pollIntervalMs,
      now,
    })
    health.setDependency('postgres', 'ok')
  }

  health.setState('ready')

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    health.setState('stopping')
    stopPoll?.()
    if (pool) { try { await pool.end() } catch { /* pool already closed */ } }
    await new Promise<void>((resolve, reject) => {
      healthServer.close((error) => (error ? reject(error) : resolve()))
    })
    health.setState('stopped')
  }

  return { config, executor, health, healthServer, close }
}