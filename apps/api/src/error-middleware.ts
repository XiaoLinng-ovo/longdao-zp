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

    console.error(`[${context.requestId}] unhandled request error`, error);
    sendError(context, 500, 'INTERNAL_ERROR', '服务器内部错误');
  }
};
