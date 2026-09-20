import type { Middleware } from './http.js';
import { HttpError } from './http.js';
import { sendError } from './response.js';

export const errorMiddleware: Middleware = async (context, next) => {
  try {
    await next();
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(context, error.status, error.code, error.message, error.details);
      return;
    }

    // 领域服务（如 AuthService.login）抛的是带 code/status 的普通 Error 而不是 HttpError 实例。
    // 这里必须保留原始状态码，否则「邮箱或密码错误」(401)、「登录尝试过于频繁」(429)、
    // 「邮箱和密码不能为空」(400) 都会被吞成 500 服务器内部错误。
    const domainError = error as Error & { code?: unknown; status?: unknown };
    if (
      typeof domainError?.code === 'string' &&
      typeof domainError?.status === 'number' &&
      domainError.status >= 400 &&
      domainError.status < 600
    ) {
      sendError(context, domainError.status, domainError.code, domainError.message);
      return;
    }

    console.error(`[${context.requestId}] unhandled request error`, error);
    sendError(context, 500, 'INTERNAL_ERROR', '服务器内部错误');
  }
};
