import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { createInterviewObjectStorageFromEnv, createObjectStorageFromEnv } from '@smartrecruit-pro/object-storage'
import { attachBilledStreamGateway } from './interviews/billed-stream-gateway.js'
import { createPlatformAccessMiddleware } from './platform/access.js'
import { PlatformService } from './platform/service.js'
import { createSystemAdministrationAccessMiddleware } from './admin/access.js'
import { PaymentService } from './payments/service.js'
import { paymentRoutes } from './payments/routes.js'
import { loadConfig, type AppConfig } from './config.js'
import { compose, type RequestContext } from './http.js'
import { errorMiddleware } from './error-middleware.js'
import { requestIdMiddleware } from './middleware.js'
import { attachAuth } from './auth/middleware.js'
import { createAccountWriteSecurityMiddleware } from './auth/account-write-security.js'
import { AuthService, createAuthSessionStore } from './auth/auth-service.js'
import { createWorkspaceContextMiddleware } from './auth/workspace-context.js'
import { createIdempotencyMiddleware } from './idempotency.js'
import { PostgresIdempotencyStore } from './idempotency-postgres.js'
import { createDatabasePool } from './db/connection.js'
import { checkReleaseReadiness } from './db/release-readiness.js'
import { createRouteMiddleware, notFoundMiddleware } from './routes.js'
import { startQuestionSheetPoll } from './interviews/question-sheet-service.js'
import { createConfiguredQuestionPreparationService } from './interviews/question-preparation-runtime.js'
import { startQuestionPreparationPoll } from './interviews/question-preparation-service.js'
import { createConfiguredQuestionSheetService } from './interviews/question-sheet-runtime.js'
import { createConfiguredInterviewSummaryService, startInterviewSummaryPoll } from './interviews/interview-summary-service.js'
import { createConfiguredInterviewTranscriptPostprocessService, startInterviewTranscriptPostprocessPoll } from './interviews/interview-transcript-postprocess-service.js'
import { createConfiguredLiveAudioTranscriptionService, startLiveAudioTranscriptionPoll } from './interviews/live-audio-transcription.js'
import { createResumeUploadAdmission } from './recruiting/upload-admission.js'
import { analysisQueueDepth } from './recruiting/analysis-capacity.js'
import { tenantBackgroundService } from './db/tenant-background.js'
import { ObjectCleanupService } from './recruiting/object-cleanup.js'
import { createConfiguredPersistentFullAudioTranscription, startPersistentFullAudioPoll } from './interviews/persistent-full-audio.js'
import { startBackgroundPoll } from './background-poll.js'
import { createShutdownBudget, runWithRuntimeSignal, type ShutdownBudget } from '@smartrecruit-pro/runtime-lifecycle'

interface AppOptions { paymentService?: PaymentService; poolFactory?: () => Pool; preflight?: (pool: Pool) => Promise<void> }
export type HttpApp = ((req: IncomingMessage, res: ServerResponse) => void) & {
  pool: Pool
  authenticate(context: RequestContext): Promise<void>
  stopAccepting(): void
  close(): Promise<void>
  readonly shutdownBudget: ShutdownBudget
}
export type HttpServer = Server & { closeAsync(): Promise<void> }

export function createApp(config: AppConfig = loadConfig(), options: AppOptions = {}): HttpApp {
  const budget = createShutdownBudget(config.shutdownTimeoutMs ?? 10000)
  return runWithRuntimeSignal(budget.signal, () => createScopedApp(config, options, budget))
}

function createScopedApp(config: AppConfig, options: AppOptions, budget: ShutdownBudget): HttpApp {
  const pool = (options.poolFactory ?? createDatabasePool)()
  let routes: ReturnType<typeof createRouteMiddleware>
  let auth: AuthService
  let pipeline: ReturnType<typeof compose>
  try {
    auth = new AuthService(createAuthSessionStore(process.env, pool))
    routes = createRouteMiddleware(pool, auth)
    const uploadAdmission = createResumeUploadAdmission({
      ...(process.env.NODE_ENV === 'test' ? {} : { queueDepth: (workspaceId: string) => analysisQueueDepth(pool, workspaceId) }),
    })
    pipeline = compose([
      errorMiddleware, requestIdMiddleware,
      async (context, next) => { await attachAuth(context, auth); await next() },
      createAccountWriteSecurityMiddleware(),
      createWorkspaceContextMiddleware(undefined, pool),
      createSystemAdministrationAccessMiddleware(auth),
      createPlatformAccessMiddleware(new PlatformService(pool)),
      uploadAdmission,
      paymentRoutes(options.paymentService ?? new PaymentService(pool)),
      createIdempotencyMiddleware(process.env.NODE_ENV === 'test' ? {} : { store: new PostgresIdempotencyStore(pool) }),
      routes.middleware, notFoundMiddleware,
    ])
  } catch (error) {
    void pool.end().catch(() => console.warn('启动失败后的数据库资源回收失败'))
    throw error
  }
  let accepting = true, closing: Promise<void> | undefined
  const requests = new Set<Promise<void>>()
  const app = (req: IncomingMessage, res: ServerResponse) => {
    if (!accepting) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
      res.end(JSON.stringify({ ok: false, error: 'SERVER_CLOSING' }))
      return
    }
    let url: URL
    try { url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost')) }
    catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
      res.end(JSON.stringify({ ok: false, error: 'INVALID_REQUEST_URL' }))
      return
    }
    const context: RequestContext = { req, res, config, requestId: '', auth: undefined, url }
    const work = Promise.resolve(runWithRuntimeSignal(budget.signal, () => pipeline(context, async () => undefined))).catch(() => {
      if (!res.headersSent) { res.writeHead(500); res.end() }
      else if (!res.writableEnded) res.destroy()
    })
    requests.add(work)
    void work.then(() => requests.delete(work))
  }
  return Object.assign(app, {
    pool, shutdownBudget: budget, authenticate: (context: RequestContext) => runWithRuntimeSignal(budget.signal, () => attachAuth(context, auth)),
    stopAccepting: () => { accepting = false },
    close: () => {
      accepting = false
      return closing ??= budget.run('接口请求、路由与连接池', async () => {
        try { await Promise.all(requests); await routes.close() }
        finally { await pool.end() }
      })
    },
  })
}

function buildHttpServer(config: AppConfig, options: AppOptions = {}) {
  const app = createApp(config, options)
  const server = createServer(app) as HttpServer
  app.shutdownBudget.signal.addEventListener('abort', () => server.closeAllConnections(), { once: true })
  let stopGateway: () => Promise<void>
  try { stopGateway = attachBilledStreamGateway(server, config, { pool: app.pool, authenticate: app.authenticate }) }
  catch (error) { void app.close().catch(() => undefined); throw error }
  const stoppers: Array<() => Promise<void>> = []
  let closing: Promise<void> | undefined, httpClosing: Promise<void> | undefined
  const drain = () => {
    app.stopAccepting()
    return closing ??= app.shutdownBudget.run('HTTP网关与后台任务', async () => {
      const outcomes = await Promise.allSettled([stopGateway(), ...stoppers.map(stop => stop())])
      try {
        const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map(item => item.reason), '后台任务关闭失败')
      } finally { await app.close() }
    })
  }
  const close = server.close.bind(server)
  const closeAll = () => httpClosing ??= app.shutdownBudget.run('HTTP监听与全部资源', async () => {
    app.stopAccepting()
    const nativeClose = new Promise<void>((resolve, reject) => close(error => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
      else resolve()
    }))
    const outcomes = await Promise.allSettled([nativeClose, drain()])
    const failures = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (failures.length === 1) throw failures[0]!.reason
    if (failures.length) throw new AggregateError(failures.map(item => item.reason), '服务器及资源关闭失败')
  })
  server.close = ((callback?: (error?: Error) => void) => {
    void closeAll().then(() => callback?.(), failure => {
      if (callback) callback(failure)
      else console.warn('服务器关闭失败，请检查残余资源')
    })
    return server
  }) as typeof server.close
  server.closeAsync = closeAll
  server.once('close', () => { void drain().catch(() => console.warn('服务器资源关闭失败')) })
  return { server, app, stoppers }
}

export function createHttpServer(config: AppConfig = loadConfig(), options: AppOptions = {}): HttpServer {
  return buildHttpServer(config, options).server
}

function startBackgroundServices(pool: Pool, stoppers: Array<() => Promise<void>>, options: AppOptions): void {
  if (process.env.NODE_ENV === 'test') return
  const enabled = (key: string) => (process.env[key] ?? '').toLowerCase() !== 'off'
  if (enabled('OBJECT_CLEANUP_POLL')) {
    const resumes = createObjectStorageFromEnv(process.env, process.env.RECRUITING_QUARANTINE_ROOT || resolve(process.cwd(), '../../data/resumes/quarantine'))
    const interviews = createInterviewObjectStorageFromEnv(process.env)
    const cleanup = new ObjectCleanupService(pool, resumes, interviews)
    const stop = startBackgroundPoll({ intervalMs: 10_000, immediate: false, run: async () => { await cleanup.processPending() },
      onError: () => console.warn('文件清理任务执行失败，请检查数据库迁移及存储状态') })
    let closing: Promise<void> | undefined
    stoppers.push(() => closing ??= (async () => {
      try { await stop() } finally { await Promise.all([resumes.close?.(), interviews.close?.()]) }
    })())
  }
  if (enabled('INTERVIEW_QUESTION_PREPARATION_POLL')) stoppers.push(startQuestionPreparationPoll(tenantBackgroundService(createConfiguredQuestionPreparationService({ pool }), 'processPending', pool)))
  if (enabled('QUESTION_SHEET_POLL')) {
    const interval = Number(process.env.QUESTION_SHEET_POLL_MS ?? '5000')
    stoppers.push(startQuestionSheetPoll({ service: tenantBackgroundService(createConfiguredQuestionSheetService(pool), 'processPendingGeneration', pool), pollIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 5000 }))
  }
  if (enabled('INTERVIEW_AUDIO_POLL')) {
    stoppers.push(startLiveAudioTranscriptionPoll(tenantBackgroundService(createConfiguredLiveAudioTranscriptionService(pool), 'processPending', pool)))
    stoppers.push(startPersistentFullAudioPoll(createConfiguredPersistentFullAudioTranscription(pool)))
  }
  if (enabled('INTERVIEW_TRANSCRIPT_POSTPROCESS_POLL')) stoppers.push(startInterviewTranscriptPostprocessPoll(tenantBackgroundService(createConfiguredInterviewTranscriptPostprocessService(pool), 'processPending', pool)))
  if (enabled('INTERVIEW_SUMMARY_POLL')) stoppers.push(startInterviewSummaryPoll(tenantBackgroundService(createConfiguredInterviewSummaryService(pool), 'processPending', pool)))
  const payments = options.paymentService ?? new PaymentService(pool)
  stoppers.push(startBackgroundPoll({ intervalMs: 60_000, immediate: false, run: async () => { await payments.reconcile() },
    onError: () => console.warn('支付核对任务执行失败，已保留待核对状态') }))
}

export async function startServer(config: AppConfig = loadConfig(), options: AppOptions = {}): Promise<HttpServer> {
  const { server, app, stoppers } = buildHttpServer(config, options)
  try {
    await (options.preflight ?? checkReleaseReadiness)(app.pool)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
      const onListening = () => { server.off('error', onError); resolve() }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(config.port, config.host)
    })
    runWithRuntimeSignal(app.shutdownBudget.signal, () => startBackgroundServices(app.pool, stoppers, options))
    return server
  } catch (error) {
    try { await server.closeAsync() }
    catch (failure) { throw new AggregateError([error, failure], '服务器启动及回收失败') }
    throw error
  }
}
