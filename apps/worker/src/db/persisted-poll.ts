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
import { EnterpriseAiError, EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import type { SharedAnalysisBudget } from './shared-analysis-budget.js'
import { setTimeout as delay } from 'node:timers/promises'

export interface PersistedPollOptions {
  pool: PgPool
  maxAttempts: number
  leaseDurationMs: number
  pollIntervalMs: number
  concurrency?: number
  acquirePermit?: (signal?: AbortSignal) => Promise<() => void>
  quarantineRoot?: string
  storage?: ObjectStorage
  executor?: TaskExecutor
  store?: PostgresAnalysisTaskStore
  sharedBudget?: SharedAnalysisBudget
  /** Injectable logger keeps tests quiet and production output structured. */
  logger?: Pick<Console, 'error' | 'warn' | 'log'>
  now?: () => string
}

/**
 * Repeatedly claims and executes persisted resume-analysis tasks.
 * The returned function stops the interval without closing the pool; callers
 * own the pool lifecycle so multiple loops can share a single pool for tests.
 */
export function startPersistedPoll(options: PersistedPollOptions): () => Promise<void> {
  const store = options.store ?? createPostgresAnalysisTaskStore(options.pool,options.sharedBudget)
  const executor = options.executor ?? createTaskExecutor({
    idempotencyStore: new PostgresIdempotencyStore(store),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const resolver = createResumePayloadResolver(store, {
    resolveBillingEnv: async task => {
      const billingPool = {connect: () => options.pool.connect(), query: async (text: string, values?: unknown[]) => { const db = await options.pool.connect(); try { return await db.query(text, values) } finally { db.release() } }}
      const result = await billingPool.query('SELECT t.organization_id FROM analysis_tasks t JOIN resumes r ON r.id=t.resume_id AND r.organization_id=t.organization_id WHERE t.id=$1 AND t.resume_id=$2 AND public.organization_service_available(t.organization_id)', [task.id,task.resumeId])
      if (!result.rows[0]) throw new EnterpriseAiError('WORKSPACE_SERVICE_UNAVAILABLE','企业服务不可用，录入的简历文件已保留',409)
      return new EnterpriseAiStore(billingPool).runtimeEnv(String(result.rows[0].organization_id))
    },
    ...(options.quarantineRoot === undefined ? {} : { quarantineRoot: options.quarantineRoot }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  })
  const logger = options.logger ?? console
  const concurrency = options.concurrency ?? 1
  let stopped = false
  const waiting = new AbortController()
  let closing: Promise<void> | undefined

  const sleep = async (): Promise<void> => {
    try { await delay(options.pollIntervalMs, undefined, { ref: false, signal: waiting.signal }) }
    catch (error) { if (!waiting.signal.aborted) throw error }
  }

  const consume = async (): Promise<void> => {
    while (!stopped) {
      let idle = false
      let release: (() => void) | undefined
      try {
        release = await options.acquirePermit?.(waiting.signal)
        if (stopped) return
        const outcome = await processNextPersistedResumeAnalysis({
          store,
          executor,
          claim: {
            maxAttempts: options.maxAttempts,
            leaseDurationMs: options.leaseDurationMs,
            ...(options.now === undefined ? {} : { now: options.now() }),
          },
          payloadFor: resolver,
          ...(options.now === undefined ? {} : { now: options.now }),
        })
        if (outcome === undefined) {
          idle = true
          continue
        }
        if (outcome.execution.status === 'failed') {
          logger.warn(`[persisted-poll] task ${outcome.lease.task.id} failed: ${outcome.execution.failure?.message ?? 'unknown'}`)
        } else if (outcome.execution.status === 'completed') {
          logger.log(`[persisted-poll] task ${outcome.lease.task.id} completed`)
        }
      } catch (error: unknown) {
        if (stopped && error === waiting.signal.reason) return
        logger.error(`[persisted-poll] poll tick failed: ${error instanceof Error ? error.message : String(error)}`)
        idle = true
      } finally {
        release?.()
        if (idle && !stopped) await sleep()
      }
    }
  }

  const consumers = Array.from({ length: concurrency }, () => consume())
  return () => {
    stopped = true
    waiting.abort()
    return closing ??= Promise.all(consumers).then(() => undefined)
  }
}
