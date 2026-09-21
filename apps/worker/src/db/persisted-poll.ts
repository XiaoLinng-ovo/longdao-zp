import {
  PostgresAnalysisTaskStore,
  PostgresIdempotencyStore,
  createPostgresAnalysisTaskStore,
  type PgPool,
} from './analysis-task-store.js'
import { createResumePayloadResolver } from './payload.js'
import { processNextPersistedResumeAnalysis } from '../handlers/persisted-resume-analysis.js'
import { createTaskExecutor, type TaskExecutor } from '../runner.js'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'

export interface PersistedPollOptions {
  pool: PgPool
  maxAttempts: number
  leaseDurationMs: number
  pollIntervalMs: number
  concurrency?: number
  quarantineRoot?: string
  storage?: ObjectStorage
  executor?: TaskExecutor
  store?: PostgresAnalysisTaskStore
  /** Injectable logger keeps tests quiet and production output structured. */
  logger?: Pick<Console, 'error' | 'warn' | 'log'>
  now?: () => string
}

/**
 * Repeatedly claims and executes persisted resume-analysis tasks.
 * The returned function stops the interval without closing the pool; callers
 * own the pool lifecycle so multiple loops can share a single pool for tests.
 */
export function startPersistedPoll(options: PersistedPollOptions): () => void {
  const store = options.store ?? createPostgresAnalysisTaskStore(options.pool)
  const executor = options.executor ?? createTaskExecutor({
    idempotencyStore: new PostgresIdempotencyStore(store),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const resolver = createResumePayloadResolver(store, {
    ...(options.quarantineRoot === undefined ? {} : { quarantineRoot: options.quarantineRoot }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  })
  const logger = options.logger ?? console
  const concurrency = options.concurrency ?? 1
  let stopped = false

  const sleep = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.pollIntervalMs)
      timer.unref?.()
    })
  }

  const consume = async (): Promise<void> => {
    while (!stopped) {
      try {
        const outcome = await processNextPersistedResumeAnalysis({
          store,
          executor,
          claim: {
            maxAttempts: options.maxAttempts,
            leaseDurationMs: options.leaseDurationMs,
            ...(options.now === undefined ? {} : { now: options.now() }),
          },
          payloadFor: resolver,
        })
        if (outcome === undefined) {
          await sleep()
          continue
        }
        if (outcome.execution.status === 'failed') {
          logger.warn(`[persisted-poll] task ${outcome.lease.task.id} failed: ${outcome.execution.failure?.message ?? 'unknown'}`)
        } else if (outcome.execution.status === 'completed') {
          logger.log(`[persisted-poll] task ${outcome.lease.task.id} completed`)
        }
      } catch (error: unknown) {
        logger.error(`[persisted-poll] poll tick failed: ${error instanceof Error ? error.message : String(error)}`)
        await sleep()
      }
    }
  }

  for (let index = 0; index < concurrency; index += 1) void consume()
  return () => { stopped = true }
}
