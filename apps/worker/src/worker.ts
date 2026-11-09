import { resolvePersistedEnterpriseAiEnv } from './handlers/enterprise-ai-task-scope.js'
import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import { createEnterpriseResumeAnalyzer } from './handlers/enterprise-resume-analyzer.js'
import type { Server } from 'node:http'
import type { Pool as PgPool } from 'pg'
import type { WorkerConfig } from './config.js'
import { HealthStateStore, startHealthServer } from './health.js'
import { createTaskExecutor, type TaskExecutor } from './runner.js'
import { createWorkerPool, createWorkerTenantPool, loadWorkerPoolConfig } from './db/pool.js'
import { startPersistedPoll } from './db/persisted-poll.js'
import { createPostgresAnalysisTaskStore } from './db/analysis-task-store.js'
import { ClamdClient } from './security/clamd-client.js'
import { startResumeScanPoll } from './security/resume-scan.js'
import { resolve } from 'node:path'
import { createObjectStorageFromEnv, type ObjectStorage } from '@smartrecruit-pro/object-storage'
import { createResumeAnalysisHandler } from './handlers/resume-analysis.js'

export interface WorkerRuntime {
  readonly config: WorkerConfig
  readonly executor: TaskExecutor
  readonly health: HealthStateStore
  readonly healthServer: Server
  close(): Promise<void>
}

export function isTenantSchemaRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TENANT_SCHEMA_ROUTING?.trim().toLowerCase() === 'on'
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
  const schemaRoutingEnabled = isTenantSchemaRoutingEnabled()
  const poolOptions = config.pollPostgres && !options.pool ? loadWorkerPoolConfig() : undefined
  let pool: PgPool | undefined = config.pollPostgres ? options.pool ?? createWorkerPool(poolOptions) : undefined
  const aiStore = pool ? new EnterpriseAiStore(pool) : undefined
  const llmHandlers = pool && aiStore && config.useLlmAnalysis
    ? { handlers: { 'resume-analysis': createResumeAnalysisHandler({ analyze: createEnterpriseResumeAnalyzer(input => resolvePersistedEnterpriseAiEnv(pool!, aiStore, input)) }) } }
    : {}
  const executor = options.executor ?? createTaskExecutor({
    now,
    ...llmHandlers,
  })
  const healthServer = await startHealthServer(config, health)

  let stopPoll: (() => void) | undefined
  let stopResumeScanPoll: (() => void) | undefined
  const tenantStops = new Map<string, { pool: PgPool; stop: () => void; stopScan?: () => void }>()
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
    const startForPool = (tenantPool: PgPool, tenantAiStore: EnterpriseAiStore): { stop: () => void; stopScan?: () => void } => {
      const tenantExecutor = config.useLlmAnalysis
        ? createTaskExecutor({ now, handlers: { 'resume-analysis': createResumeAnalysisHandler({ analyze: createEnterpriseResumeAnalyzer(input => resolvePersistedEnterpriseAiEnv(tenantPool, tenantAiStore, input)) }) } })
        : executor
      const stop = startPersistedPoll({ pool: tenantPool, maxAttempts: config.maxAttempts, leaseDurationMs: config.leaseDurationMs,
        pollIntervalMs: config.pollIntervalMs, concurrency: config.concurrency, now, storage, executor: tenantExecutor })
      const stopScan = config.clamavHost ? startResumeScanPoll({ store: createPostgresAnalysisTaskStore(tenantPool),
        scanner: new ClamdClient({ host: config.clamavHost, port: config.clamavPort, timeoutMs: config.clamavTimeoutMs }),
        storage, pollIntervalMs: config.pollIntervalMs }) : undefined
      return { stop, ...(stopScan ? { stopScan } : {}) }
    }
    if (poolOptions && schemaRoutingEnabled) {
      const controlPool = pool!
      let discoveryRunning = false
      const discover = async () => {
        if (discoveryRunning) return
        discoveryRunning = true
        try {
          const ready = await controlPool.query<{ organization_id: string; schema_name: string }>(
            `SELECT s.organization_id,s.schema_name FROM public.organization_schemas s
              JOIN public.organizations o ON o.id=s.organization_id
             WHERE s.status='ready' AND o.status='active' AND public.organization_service_available(o.id)
             ORDER BY s.organization_id`,
          )
          const active = new Set<string>()
          for (const row of ready.rows) {
            const expected = `company_${row.organization_id.replaceAll('-', '').toLowerCase()}`
            if (row.schema_name !== expected) throw new Error('INVALID_TENANT_SCHEMA')
            active.add(row.organization_id)
            if (tenantStops.has(row.organization_id)) continue
            const tenantPool = createWorkerTenantPool({ ...poolOptions, max: Math.min(poolOptions.max ?? 10, 2) }, row.schema_name)
            const tasks = startForPool(tenantPool, new EnterpriseAiStore(tenantPool))
            tenantStops.set(row.organization_id, { pool: tenantPool, ...tasks })
          }
          for (const [organizationId, tasks] of tenantStops) {
            if (active.has(organizationId)) continue
            tasks.stop(); tasks.stopScan?.()
            await (tasks.pool as import('pg').Pool).end()
            tenantStops.delete(organizationId)
          }
        } catch (error) {
          console.error('[tenant-worker-discovery]', error instanceof Error ? error.message : String(error))
        } finally { discoveryRunning = false }
      }
      void discover()
      const discoveryTimer = setInterval(() => void discover(), Math.max(1000, config.pollIntervalMs * 5))
      discoveryTimer.unref?.()
      stopPoll = () => clearInterval(discoveryTimer)
      pool = controlPool
    } else {
    stopPoll = startPersistedPoll({
      pool: pool!,
      maxAttempts: config.maxAttempts,
      leaseDurationMs: config.leaseDurationMs,
      pollIntervalMs: config.pollIntervalMs,
      concurrency: config.concurrency,
      now,
      storage,
      executor,
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

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    health.setState('stopping')
    stopPoll?.()
    stopResumeScanPoll?.()
    for (const tasks of tenantStops.values()) { tasks.stop(); tasks.stopScan?.(); await (tasks.pool as import('pg').Pool).end().catch(() => undefined) }
    if (pool && pool !== options.pool) { try { await pool.end() } catch { /* pool already closed */ } }
    await new Promise<void>((resolve, reject) => {
      healthServer.close((error) => (error ? reject(error) : resolve()))
    })
    health.setState('stopped')
  }

  return { config, executor, health, healthServer, close }
}
