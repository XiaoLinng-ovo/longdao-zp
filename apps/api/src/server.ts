import { createPlatformAccessMiddleware } from './platform/access.js'
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
import { createConfiguredQuestionSheetService } from './interviews/question-sheet-runtime.js';
import { createConfiguredInterviewSummaryService, startInterviewSummaryPoll } from './interviews/interview-summary-service.js';
import { createConfiguredDingTalkApprovalClient } from './integrations/dingtalk/approval-client.js';
import { DingTalkApprovalWorkflow } from './integrations/dingtalk/approval-workflow.js';
import { PostgresDingTalkApprovalRepository } from './integrations/dingtalk/postgres-approval-workflow.js';

/**
 * 面试表生成是分钟级的模型调用，放在 API 进程内做后台轮询，避免阻塞请求。
 * 与 worker 的轮询写法一致；单实例部署下由 updated_at 顺序领取任务。
 */
function startQuestionSheetPollResolved(): () => void {
  if (process.env.NODE_ENV === 'test' || (process.env.QUESTION_SHEET_POLL ?? '').toLowerCase() === 'off') return () => undefined
  const interval = Number(process.env.QUESTION_SHEET_POLL_MS ?? '5000')
  const service = createConfiguredQuestionSheetService()
  return startQuestionSheetPoll({ service, pollIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 5000 })
}

/**
 * 钉钉回调可能因网络抖动或订阅配置暂时不可用而丢失；后台定期查询仍处于 pending 的实例，
 * 将最终状态补写回平台。未完整配置钉钉时不启动，避免开发环境产生无意义的连接和错误日志。
 */
function startDingTalkApprovalReconcileResolved(): () => void {
  if (process.env.NODE_ENV === 'test' || (process.env.DINGTALK_APPROVAL_RECONCILE ?? 'on').toLowerCase() === 'off' || (process.env.DINGTALK_APPROVAL_MODE ?? 'mock').trim().toLowerCase() !== 'real') return () => undefined
  const client = createConfiguredDingTalkApprovalClient()
  const callbackToken = process.env.DINGTALK_CALLBACK_TOKEN?.trim()
  const callbackAesKey = process.env.DINGTALK_CALLBACK_AES_KEY?.trim()
  const callbackCorpId = process.env.DINGTALK_CALLBACK_CORP_ID?.trim()
  if (!client || !callbackToken || !callbackAesKey || !callbackCorpId) return () => undefined

  const workflow = new DingTalkApprovalWorkflow(
    new PostgresDingTalkApprovalRepository(createDatabasePool()),
    client,
    { callbackToken, callbackAesKey, callbackCorpId },
  )
  const configuredInterval = Number(process.env.DINGTALK_APPROVAL_RECONCILE_MS ?? '300000')
  const intervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 10_000 ? configuredInterval : 300_000
  let running = false
  const run = async () => {
    if (running) return
    running = true
    try {
      await workflow.reconcilePending()
    } catch {
      // 单轮失败不应影响 API 进程；下一轮继续补偿。
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void run(), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
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

export function createApp(config: AppConfig = loadConfig(), options: { paymentService?: PaymentService } = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const pipeline = compose([
    errorMiddleware,
    requestIdMiddleware,
    authMiddleware,
    // Reject stale-tab writes/reads before any cached response can be replayed.
    createWorkspaceContextMiddleware(),
    createPlatformAccessMiddleware(),
    paymentRoutes(options.paymentService ?? new PaymentService(createDatabasePool())),
    // 幂等键需要操作人身份与原始请求体，因此排在 auth 之后、路由之前。
    buildIdempotencyMiddleware(),
    routeMiddleware,
    notFoundMiddleware
  ]);

  return (req, res) => {
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
}

export function createHttpServer(config: AppConfig = loadConfig(), options: { paymentService?: PaymentService } = {}): Server {
  return createServer(createApp(config, options));
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
  const stopQuestionSheetPoll = startQuestionSheetPollResolved()
  const stopSummaryPoll = process.env.NODE_ENV === 'test' || process.env.INTERVIEW_SUMMARY_POLL === 'off'
    ? () => undefined : startInterviewSummaryPoll(createConfiguredInterviewSummaryService())
  const stopDingTalkApprovalReconcile = startDingTalkApprovalReconcileResolved()
  const paymentService = new PaymentService(createDatabasePool())
  let paymentRunning = false
  const paymentTimer = process.env.NODE_ENV === 'test' ? undefined : setInterval(() => {
    if (paymentRunning) return
    paymentRunning = true
    void paymentService.reconcile().catch(() => undefined).finally(() => { paymentRunning = false })
  }, 60_000)
  paymentTimer?.unref()
  server.once('close', () => {
    stopQuestionSheetPoll()
    stopSummaryPoll()
    stopDingTalkApprovalReconcile()
    if (paymentTimer) clearInterval(paymentTimer)
  })
  return server;
}
