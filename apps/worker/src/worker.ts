import { resolvePersistedEnterpriseAiEnv } from './handlers/enterprise-ai-task-scope.js'
import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import { createEnterpriseResumeAnalyzer } from './handlers/enterprise-resume-analyzer.js'
import type { Server } from 'node:http'
import type { Pool as PgPool } from 'pg'
import type { WorkerConfig } from './config.js'
import { HealthStateStore, startHealthServer } from './health.js'
import { createTaskExecutor, type TaskExecutor } from './runner.js'
import { createWorkerPool, createWorkerTenantPool, loadWorkerPoolConfig } from './db/pool.js'
import { checkReleaseReadiness } from './db/release-readiness.js'
import { discoverWorkerTenants } from './db/tenant-discovery.js'
import { startPersistedPoll } from './db/persisted-poll.js'
import { createConcurrencyBudget } from './db/concurrency-budget.js'
import { loadSharedAnalysisBudget } from './db/shared-analysis-budget.js'
import { createPostgresAnalysisTaskStore } from './db/analysis-task-store.js'
import { ClamdClient } from './security/clamd-client.js'
import { startResumeScanPoll } from './security/resume-scan.js'
import { resolve } from 'node:path'
import { createObjectStorageFromEnv, type ObjectStorage } from '@smartrecruit-pro/object-storage'
import { createResumeAnalysisHandler } from './handlers/resume-analysis.js'
import { createShutdownBudget, runWithRuntimeSignal, type ShutdownBudget } from '@smartrecruit-pro/runtime-lifecycle'

export interface WorkerRuntime {
  readonly config: WorkerConfig
  readonly executor: TaskExecutor
  readonly health: HealthStateStore
  readonly healthServer: Server
  close(): Promise<void>
}

export function isTenantSchemaRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TENANT_SCHEMA_ROUTING === 'on'
}

export interface StartWorkerOptions {
  executor?: TaskExecutor
  now?: () => string
  /** Pool used when DB polling is enabled; creates one from env when omitted. */
  pool?: PgPool
  storage?: ObjectStorage
  preflight?: (pool: PgPool) => Promise<void>
  logger?: Pick<Console, 'error' | 'warn' | 'log'>
}

export async function startWorker(config: WorkerConfig, options: StartWorkerOptions = {}): Promise<WorkerRuntime> {
  const budget = createShutdownBudget(config.shutdownTimeoutMs)
  return runWithRuntimeSignal(budget.signal, () => startScopedWorker(config, options, budget))
}

async function startScopedWorker(config: WorkerConfig, options: StartWorkerOptions, budget: ShutdownBudget): Promise<WorkerRuntime> {
  const now = options.now ?? (() => new Date().toISOString())
  const health = new HealthStateStore(config, now)
  const schemaRoutingEnabled = isTenantSchemaRoutingEnabled()
  const poolOptions = config.pollPostgres && !options.pool ? loadWorkerPoolConfig() : undefined
  let pool: PgPool | undefined = config.pollPostgres ? options.pool ?? createWorkerPool(poolOptions) : undefined
  if (pool) {
    try { await (options.preflight ?? (pool => checkReleaseReadiness(pool, config.quarantineRoot, options.storage)))(pool) }
    catch (error) {
      if (pool !== options.pool) await pool.end()
      throw error
    }
  }
  const aiStore = pool ? new EnterpriseAiStore(pool) : undefined
  const llmHandlers = pool && aiStore && config.useLlmAnalysis
    ? { handlers: { 'resume-analysis': createResumeAnalysisHandler({ analyze: createEnterpriseResumeAnalyzer(input => resolvePersistedEnterpriseAiEnv(pool!, aiStore, input)) }) } }
    : {}
  const executor = options.executor ?? createTaskExecutor({
    now,
    ...llmHandlers,
  })
  const healthServer = await startHealthServer(config, health).catch(async error => {
    if (pool && pool !== options.pool) await pool.end()
    throw error
  })

  let stopPoll: (() => void | Promise<void>) | undefined
  let stopResumeScanPoll: (() => Promise<void>) | undefined
  type TenantRuntime = { pool: PgPool; stop: () => Promise<void>; stopScan?: () => Promise<void>; closing?: Promise<void> }
  const tenantStops = new Map<string, TenantRuntime>()
  const closeTenant = (tasks: TenantRuntime): Promise<void> => tasks.closing ??= (async () => {
    try {
      const outcomes = await Promise.allSettled([tasks.stop(), tasks.stopScan?.()])
      const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, '企业后台任务回收失败')
    }
    finally { await tasks.pool.end() }
  })()
  const acquirePermit = createConcurrencyBudget(config.concurrency)
  let discoveryClosed = false
  let discoveryTask: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let ownedStorage: ObjectStorage | undefined
  budget.signal.addEventListener('abort', () => healthServer.closeAllConnections(), { once: true })
  const close = (): Promise<void> => {
    if (closing) return closing
    health.setState('stopping')
    discoveryClosed = true
    closing = budget.run('Worker任务、存储与连接池', async () => {
      const healthClosing = new Promise<void>((resolve, reject) => healthServer.close(error => error ? reject(error) : resolve()))
      void healthClosing.catch(() => undefined)
      // Stop every claimant before waiting for any one loop to drain.
      const outcomes = await Promise.allSettled([
        stopPoll?.(), stopResumeScanPoll?.(),
        ...[...tenantStops.values()].map(closeTenant),
      ])
      const resources = await Promise.allSettled([
        ownedStorage?.close?.(),
        pool && pool !== options.pool ? pool.end() : Promise.resolve(),
        healthClosing,
      ])
      health.setState('stopped')
      const errors = [...outcomes, ...resources].filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, '后台服务资源回收失败')
    }).catch(error => { health.setState('degraded'); throw error })
    return closing
  }
  try {
  const storage = options.storage ?? createObjectStorageFromEnv(process.env, config.quarantineRoot ?? resolve(process.cwd(), '../../data/resumes/quarantine'))
  if (!options.storage) ownedStorage = storage
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
    const startForPool = (tenantPool: PgPool, tenantAiStore: EnterpriseAiStore): { stop: () => Promise<void>; stopScan?: () => Promise<void> } => {
      const tenantExecutor = config.useLlmAnalysis
        ? createTaskExecutor({ now, handlers: { 'resume-analysis': createResumeAnalysisHandler({ analyze: createEnterpriseResumeAnalyzer(input => resolvePersistedEnterpriseAiEnv(tenantPool, tenantAiStore, input)) }) } })
        : executor
      const stop = startPersistedPoll({ pool: tenantPool, maxAttempts: config.maxAttempts, leaseDurationMs: config.leaseDurationMs,
        pollIntervalMs: config.pollIntervalMs, concurrency: config.concurrency, acquirePermit, sharedBudget:loadSharedAnalysisBudget(), now, storage, executor: tenantExecutor, ...(options.logger ? { logger: options.logger } : {}) })
      const stopScan = config.clamavHost ? startResumeScanPoll({ store: createPostgresAnalysisTaskStore(tenantPool),
        scanner: new ClamdClient({ host: config.clamavHost, port: config.clamavPort, timeoutMs: config.clamavTimeoutMs }),
        storage, pollIntervalMs: config.pollIntervalMs }) : undefined
      return { stop, ...(stopScan ? { stopScan } : {}) }
    }
    if (poolOptions && schemaRoutingEnabled) {
      const controlPool = pool!
      let discoveryRunning = false
      const discover = async (failStartup = false) => {
        if (discoveryRunning || discoveryClosed) return
        discoveryRunning = true
        try {
          const ready = await discoverWorkerTenants(controlPool)
          const active = new Set<string>()
          for (const row of ready) {
            if (discoveryClosed) break
            const expected = `company_${row.organization_id.replaceAll('-', '').toLowerCase()}`
            if (row.schema_name !== expected) throw new Error('INVALID_TENANT_SCHEMA')
            active.add(row.organization_id)
            if (tenantStops.has(row.organization_id)) continue
            const tenantPool = createWorkerTenantPool(poolOptions, row.schema_name, controlPool)
            const tasks = startForPool(tenantPool, new EnterpriseAiStore(tenantPool))
            tenantStops.set(row.organization_id, { pool: tenantPool, ...tasks })
          }
          for (const [organizationId, tasks] of tenantStops) {
            if (active.has(organizationId)) continue
            await closeTenant(tasks)
            tenantStops.delete(organizationId)
          }
          if (!discoveryClosed) {
            health.setDependency('postgres', 'ok')
            health.setState('ready')
          }
        } catch (error) {
          if (!discoveryClosed) {
            health.setDependency('postgres', 'error')
            health.setState('degraded')
          }
          const stopped = await Promise.allSettled([...tenantStops.values()].map(closeTenant))
          tenantStops.clear()
          ;(options.logger ?? console).error('[tenant-worker-discovery]', error instanceof Error ? error.message : String(error))
          if (failStartup) {
            const failures = stopped.filter(result => result.status === 'rejected').map(result => result.reason)
            if (failures.length) throw new AggregateError([error, ...failures], '公司发现及后台任务回收失败')
            throw error
          }
        } finally { discoveryRunning = false }
      }
      discoveryTask = discover(true)
      await discoveryTask
      const discoveryTimer = setInterval(() => { if (!discoveryRunning) discoveryTask = discover() }, Math.max(1000, config.pollIntervalMs * 5))
      discoveryTimer.unref?.()
      stopPoll = async () => { discoveryClosed = true; clearInterval(discoveryTimer); await discoveryTask }
      pool = controlPool
    } else {
    stopPoll = startPersistedPoll({
      pool: pool!,
      maxAttempts: config.maxAttempts,
      leaseDurationMs: config.leaseDurationMs,
      pollIntervalMs: config.pollIntervalMs,
      concurrency: config.concurrency,
      sharedBudget: loadSharedAnalysisBudget(),
      now,
      storage,
      executor,
      ...(options.logger ? { logger: options.logger } : {}),
    })
    health.setDependency('postgres', 'ok')
    if (config.clamavHost) {
      stopResumeScanPoll = startResumeScanPoll({
        store: createPostgresAnalysisTaskStore(pool!),
        scanner: new ClamdClient({ host: config.clamavHost, port: config.clamavPort, timeoutMs: config.clamavTimeoutMs }),
        storage,
        pollIntervalMs: config.pollIntervalMs,
      })
    }
    }
  }

  health.setState('ready')

  return { config, executor, health, healthServer, close }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], '后台服务启动失败且资源回收异常') }
    throw error
  }
}
