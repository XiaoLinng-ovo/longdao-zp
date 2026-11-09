import { createPlatformAccessMiddleware } from './platform/access.js'
import { createSystemAdministrationAccessMiddleware } from './admin/access.js'
import { PaymentService } from './payments/service.js'
import { paymentRoutes } from './payments/routes.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadConfig, type AppConfig } from './config.js';
import { compose, type Middleware, type RequestContext } from './http.js';
import { errorMiddleware } from './error-middleware.js';
import { requestIdMiddleware } from './middleware.js';
import { attachAuth } from './auth/middleware.js';
import { createWorkspaceContextMiddleware } from './auth/workspace-context.js';
import { createIdempotencyMiddleware } from './idempotency.js';
import { PostgresIdempotencyStore } from './idempotency-postgres.js';
import { createDatabasePool } from './db/connection.js';
import routeMiddleware, { notFoundMiddleware } from './routes.js';
import { startQuestionSheetPoll } from './interviews/question-sheet-service.js';
import { createConfiguredQuestionPreparationService } from './interviews/question-preparation-runtime.js';
import { startQuestionPreparationPoll } from './interviews/question-preparation-service.js';
import { createConfiguredQuestionSheetService } from './interviews/question-sheet-runtime.js';
import { createConfiguredInterviewSummaryService, startInterviewSummaryPoll } from './interviews/interview-summary-service.js';
import { createConfiguredInterviewTranscriptPostprocessService, startInterviewTranscriptPostprocessPoll } from './interviews/interview-transcript-postprocess-service.js';
import { createConfiguredLiveAudioTranscriptionService, startLiveAudioTranscriptionPoll } from './interviews/live-audio-transcription.js';
import { createResumeUploadAdmission } from './recruiting/upload-admission.js';
import { tenantBackgroundService } from './db/tenant-background.js'

/**
 * 面试表生成是分钟级的模型调用，放在 API 进程内做后台轮询，避免阻塞请求。
 * 与 worker 的轮询写法一致；单实例部署下由 updated_at 顺序领取任务。
 */
function startQuestionSheetPollResolved(registry: ReturnType<typeof createDatabasePool>): () => void {
  if (process.env.NODE_ENV === 'test' || (process.env.QUESTION_SHEET_POLL ?? '').toLowerCase() === 'off') return () => undefined
  const interval = Number(process.env.QUESTION_SHEET_POLL_MS ?? '5000')
  const service = tenantBackgroundService(createConfiguredQuestionSheetService(), 'processPendingGeneration', registry)
  return startQuestionSheetPoll({ service, pollIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 5000 })
}

const authMiddleware: Middleware = async (context, next) => {
  await attachAuth(context);
  await next();
};

function buildIdempotencyMiddleware(): Middleware {
  // 测试模式走内存实现（无外部依赖）；其余环境用 PostgreSQL，幂等跨实例/跨重启保留。
  if (process.env.NODE_ENV === 'test') return createIdempotencyMiddleware();
  return createIdempotencyMiddleware({ store: new PostgresIdempotencyStore(createDatabasePool()) });
}

export type HttpApp = ((req: IncomingMessage, res: ServerResponse) => void) & { close(): Promise<void> }

export function createApp(config: AppConfig = loadConfig(), options: { paymentService?: PaymentService } = {}): HttpApp {
  const uploadPool = process.env.NODE_ENV === 'test' ? undefined : createDatabasePool()
  const schemaRegistryPool = process.env.TENANT_SCHEMA_ROUTING === 'on' ? createDatabasePool() : undefined
  const uploadAdmission = createResumeUploadAdmission({
    ...(uploadPool ? { queueDepth: async (workspaceId: string) => {
      const result = await uploadPool.query<{ total: number; workspace: number }>(
        `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE organization_id = $1::uuid)::int AS workspace
         FROM analysis_tasks WHERE status IN ('queued', 'processing')`, [workspaceId],
      )
      return result.rows[0]!
    } } : {}),
  })
  const pipeline = compose([
    errorMiddleware,
    requestIdMiddleware,
    authMiddleware,
    // Reject stale-tab writes/reads before any cached response can be replayed.
    createWorkspaceContextMiddleware(undefined, schemaRegistryPool),
    createSystemAdministrationAccessMiddleware(),
    createPlatformAccessMiddleware(),
    uploadAdmission,
    paymentRoutes(options.paymentService ?? new PaymentService(createDatabasePool())),
    // 幂等键需要操作人身份与原始请求体，因此排在 auth 之后、路由之前。
    buildIdempotencyMiddleware(),
    routeMiddleware,
    notFoundMiddleware
  ]);

  const app = (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);
    const context: RequestContext = {
      req,
      res,
      config,
      requestId: '',
      auth: undefined,
      url
    };

    void pipeline(context, async () => undefined);
  };
  return Object.assign(app, { close: async () => { await Promise.all([uploadPool?.end(), schemaRegistryPool?.end()]) } });
}

export function createHttpServer(config: AppConfig = loadConfig(), options: { paymentService?: PaymentService } = {}): Server {
  const app = createApp(config, options);
  const server = createServer(app);
  server.once('close', () => { void app.close().catch(error => console.error('Failed to close resume upload pool', error)) });
  return server;
}

export async function startServer(config: AppConfig = loadConfig()): Promise<Server> {
  const server = createHttpServer(config);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });
  // Do not claim background jobs until the port is bound; a failed startup must stay idle.
  const backgroundRegistry = createDatabasePool()
  const stopPreparationPoll = process.env.NODE_ENV === 'test' || process.env.INTERVIEW_QUESTION_PREPARATION_POLL === 'off'
    ? () => undefined : startQuestionPreparationPoll(tenantBackgroundService(createConfiguredQuestionPreparationService(), 'processPending', backgroundRegistry))
  const stopQuestionSheetPoll = startQuestionSheetPollResolved(backgroundRegistry)
  const stopAudioPoll = process.env.NODE_ENV === 'test' || process.env.INTERVIEW_AUDIO_POLL === 'off'
    ? () => undefined : startLiveAudioTranscriptionPoll(tenantBackgroundService(createConfiguredLiveAudioTranscriptionService(), 'processPending', backgroundRegistry))
  const stopTranscriptPostprocessPoll = process.env.NODE_ENV === 'test' || process.env.INTERVIEW_TRANSCRIPT_POSTPROCESS_POLL === 'off'
    ? () => undefined : startInterviewTranscriptPostprocessPoll(tenantBackgroundService(createConfiguredInterviewTranscriptPostprocessService(), 'processPending', backgroundRegistry))
  const stopSummaryPoll = process.env.NODE_ENV === 'test' || process.env.INTERVIEW_SUMMARY_POLL === 'off'
    ? () => undefined : startInterviewSummaryPoll(tenantBackgroundService(createConfiguredInterviewSummaryService(), 'processPending', backgroundRegistry))
  const paymentService = new PaymentService(createDatabasePool())
  let paymentRunning = false
  const paymentTimer = process.env.NODE_ENV === 'test' ? undefined : setInterval(() => {
    if (paymentRunning) return
    paymentRunning = true
    void paymentService.reconcile().catch(() => undefined).finally(() => { paymentRunning = false })
  }, 60_000)
  paymentTimer?.unref()
  server.once('close', () => {
    stopPreparationPoll()
    stopQuestionSheetPoll()
    stopAudioPoll()
    stopTranscriptPostprocessPoll()
    stopSummaryPoll()
    void backgroundRegistry.end().catch(() => undefined)
    if (paymentTimer) clearInterval(paymentTimer)
  })
  return server;
}
