import { randomUUID } from 'node:crypto';
import type { Middleware } from './http.js';

const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/;

export const requestIdMiddleware: Middleware = async (context, next) => {
  const configured = context.req.headers[context.config.requestIdHeader];
  const candidate = Array.isArray(configured) ? configured[0] : configured;
  const requestId = candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();

  context.requestId = requestId;
  context.res.setHeader(context.config.requestIdHeader, requestId);
  await next();
};
