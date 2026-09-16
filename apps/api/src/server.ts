import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { loadConfig, type AppConfig } from './config.js';
import { compose, type Middleware, type RequestContext } from './http.js';
import { errorMiddleware } from './error-middleware.js';
import { requestIdMiddleware } from './middleware.js';
import { attachAuth } from './auth/middleware.js';
import { idempotencyMiddleware } from './idempotency.js';
import routeMiddleware, { notFoundMiddleware } from './routes.js';

const authMiddleware: Middleware = async (context, next) => {
  await attachAuth(context);
  await next();
};

export function createApp(config: AppConfig = loadConfig()): (req: IncomingMessage, res: ServerResponse) => void {
  const pipeline = compose([
    errorMiddleware,
    requestIdMiddleware,
    authMiddleware,
    // 幂等键需要操作人身份与原始请求体，因此排在 auth 之后、路由之前。
    idempotencyMiddleware,
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
  return server;
}
