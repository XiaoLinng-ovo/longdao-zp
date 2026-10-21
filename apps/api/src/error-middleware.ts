import type { Middleware } from './http.js';
import { HttpError } from './http.js';
import { sendError } from './response.js';

export const errorMiddleware: Middleware = async (context, next) => {
  try {
    await next();
  } catch (error) {
    // Route adapters may wrap a PostgreSQL error in HttpError(500); normalize
    // capacity conflicts before the generic HttpError branch as well.
    const capacityCode = (error as { code?: string })?.code;
    if (capacityCode === 'P5501' || capacityCode === 'P5502') {
      sendError(context, 409, capacityCode === 'P5501' ? 'SEAT_LIMIT_EXCEEDED' : 'JOB_LIMIT_EXCEEDED', capacityCode === 'P5501' ? '企业成员席位已用满，请联系企业管理员或平台运营调整套餐' : '企业岗位容量已用满，请联系管理员整理岗位或调整套餐');
      return;
    }

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
