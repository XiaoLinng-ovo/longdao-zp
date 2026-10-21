import type { Middleware, RequestContext } from '../http.js'
import { HttpError } from '../http.js'
import { createDatabasePool } from '../db/connection.js'
import { PlatformService } from './service.js'
import { isAllowedOrigin, parseAllowedOrigins, readCookie, validateCsrf } from '../auth/security.js'
// Everything under legacy /admin is platform-only unless explicitly enterprise-scoped.
const enterpriseAdminPaths = ['billing-sandbox', 'ai-usage', 'ai-settings', 'ai-connection-test', 'ai-skills', 'analysis-tasks', 'recruitment-approval-settings']
export function isPlatformManagementPath(path: string): boolean {
  if (path === '/api/v1/platform' || path.startsWith('/api/v1/platform/')) return true
  if (!path.startsWith('/api/v1/admin/')) return path === '/api/v1/admin'
  return !enterpriseAdminPaths.some(part => path === `/api/v1/admin/${part}` || (['ai-skills','billing-sandbox','ai-usage'].includes(part) && path.startsWith(`/api/v1/admin/${part}/`)))
}
export function createPlatformAccessMiddleware(service: Pick<PlatformService, 'requireAccess'> = new PlatformService(createDatabasePool())): Middleware {
  return async (context, next) => {
    if (!isPlatformManagementPath(context.url.pathname)) return next()
    if (!context.auth || context.auth.method !== 'session') throw new HttpError(401, 'AUTHENTICATION_REQUIRED', '请登录后访问平台运营功能')
    // Live DB authorization precedes idempotent replay; cached user roles are never grants.
    const write = context.url.pathname.startsWith('/api/v1/admin') || !['GET', 'HEAD'].includes(context.req.method ?? 'GET')
    context.auth.user.platformRole = await service.requireAccess(context.auth.user.id, write)
    if (context.url.pathname.startsWith('/api/v1/platform/') && !['GET', 'HEAD'].includes(context.req.method ?? 'GET')) assertPlatformWriteSecurity(context)
    context.res.setHeader('cache-control', 'private, no-store')
    await next()
  }
}

/** Platform mutations always require origin + CSRF, even if legacy dev endpoints disable protection. */
export function assertPlatformWriteSecurity(context: RequestContext, env: NodeJS.ProcessEnv = process.env): void {
  const configured = parseAllowedOrigins(env.ALLOWED_ORIGINS)
  if (!configured.length && env.NODE_ENV === 'production') throw new HttpError(503, 'PLATFORM_ORIGINS_REQUIRED', '平台写操作需要先配置可信来源白名单')
  const allowed = configured.length ? configured : ['http://127.0.0.1:5174', 'http://localhost:5174']
  const origin = typeof context.req.headers.origin === 'string' ? context.req.headers.origin : undefined
  if (!isAllowedOrigin(origin, allowed, env.NODE_ENV === 'development')) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任')
  const token = typeof context.req.headers['x-csrf-token'] === 'string' ? context.req.headers['x-csrf-token'] : undefined
  const cookie = typeof context.req.headers.cookie === 'string' ? context.req.headers.cookie : undefined
  if (!validateCsrf(token, readCookie(cookie, 'smartrecruit_csrf', {production: env.NODE_ENV === 'production'}))) throw new HttpError(403, 'CSRF_TOKEN_INVALID', 'CSRF Token 无效')
}
