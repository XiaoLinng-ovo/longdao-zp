import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadConfig, type AppConfig } from './config.js';
import { compose, type Middleware, type RequestContext } from './http.js';
import { errorMiddleware } from './error-middleware.js';
import { requestIdMiddleware } from './middleware.js';
import { attachAuth } from './auth/middleware.js';
import { createIdempotencyMiddleware } from './idempotency.js';
import { PostgresIdempotencyStore } from './idempotency-postgres.js';
import { createDatabasePool } from './db/connection.js';
import routeMiddleware, { notFoundMiddleware } from './routes.js';
import { QuestionSheetRepository } from './interviews/question-sheet-repository.js';
import { QuestionSheetService, startQuestionSheetPoll } from './interviews/question-sheet-service.js';

/**
 * 面试表生成是分钟级的模型调用，放在 API 进程内做后台轮询，避免阻塞请求。
 * 与 worker 的轮询写法一致；单实例部署下由 updated_at 顺序领取任务。
 */
function startQuestionSheetPollResolved(): () => void {
  if (process.env.NODE_ENV === 'test' || (process.env.QUESTION_SHEET_POLL ?? '').toLowerCase() === 'off') return () => undefined
  const interval = Number(process.env.QUESTION_SHEET_POLL_MS ?? '5000')
  const service = new QuestionSheetService(new QuestionSheetRepository(createDatabasePool()))
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

export function createApp(config: AppConfig = loadConfig()): (req: IncomingMessage, res: ServerResponse) => void {
  const pipeline = compose([
    errorMiddleware,
    requestIdMiddleware,
    authMiddleware,
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

export function createHttpServer(config: AppConfig = loadConfig()): Server {
  return createServer(createApp(config));
}

export async function startServer(config: AppConfig = loadConfig()): Promise<Server> {
  // 面试表生成是分钟级的模型调用，放到进程内的后台轮询，避免阻塞请求。
  const stopQuestionSheetPoll = startQuestionSheetPollResolved()
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
  server.once('close', () => stopQuestionSheetPoll())
  return server;
}
