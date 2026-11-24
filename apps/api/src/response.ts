import type { ServerResponse } from 'node:http';
import type { AppConfig } from './config.js';
import type { RequestContext } from './http.js';

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
  meta?: ApiMeta;
}

/**
 * 与 packages/contracts 的 PaginationMeta 保持同形（page / pageSize / total / totalPages），
 * 见 packages/contracts/src/common.ts。
 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiMeta {
  pagination?: PaginationMeta;
  warnings?: string[];
}

export interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

export function sendJson<T>(
  response: ServerResponse,
  status: number,
  body: ApiSuccess<T> | ApiErrorBody
): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-length', Buffer.byteLength(payload));
  response.end(payload);
}

export function sendSuccess<T>(context: RequestContext, data: T, status = 200, meta?: ApiMeta): void {
  const body: ApiSuccess<T> = { ok: true, data, requestId: context.requestId, ...(meta ? { meta } : {}) };
  sendJson(context.res, status, body);
}

export function sendError(
  context: RequestContext,
  status: number,
  code: string,
  message: string,
  details?: unknown
): void {
  const error: ApiErrorBody['error'] = { code, message };
  if (details !== undefined) error.details = details;
  sendJson(context.res, status, { ok: false, error, requestId: context.requestId });
}

export function publicConfig(config: AppConfig): Pick<AppConfig, 'appName' | 'appVersion' | 'nodeEnv'> {
  return {
    appName: config.appName,
    appVersion: config.appVersion,
    nodeEnv: config.nodeEnv
  };
}
