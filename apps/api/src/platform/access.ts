import type { Middleware, RequestContext } from '../http.js'
import { HttpError } from '../http.js'
import { PlatformService } from './service.js'
import { readCookie, validateCsrf } from '../auth/security.js'
import { isAllowedRequestOrigin } from '../auth/request-origin.js'
import { isSystemAdministrationPath } from '../auth/system-administrator.js'
// Legacy /admin defaults to platform-only, except explicitly classified system configuration and enterprise APIs.
const enterpriseAdminPaths = ['billing-sandbox', 'ai-usage', 'ai-skills', 'analysis-tasks', 'enterprise-ai-settings', 'enterprise-ai-connection-test', 'enterprise-ai-source']
export function isPlatformManagementPath(path: string): boolean {
  if (isSystemAdministrationPath(path)) return false
  if (path === '/api/v1/platform' || path.startsWith('/api/v1/platform/')) return true
  if (!path.startsWith('/api/v1/admin/')) return path === '/api/v1/admin'
  return !enterpriseAdminPaths.some(part => path === `/api/v1/admin/${part}` || (['ai-skills','billing-sandbox','ai-usage'].includes(part) && path.startsWith(`/api/v1/admin/${part}/`)))
}
export function createPlatformAccessMiddleware(service: Pick<PlatformService, 'requireAccess'>): Middleware {
  return async (context, next) => {
    if (!isPlatformManagementPath(context.url.pathname)) return next()
    if (!context.auth || context.auth.method !== 'session') throw new HttpError(401, 'AUTHENTICATION_REQUIRED', '请登录后访问平台运营功能')
    const mutation = !['GET', 'HEAD'].includes(context.req.method ?? 'GET')
    // Reject forged writes before querying grants, then verify the live role before downstream replay.
    if (mutation) assertPlatformWriteSecurity(context)
    const write = context.url.pathname.startsWith('/api/v1/admin') || mutation
    context.auth.user.platformRole = await service.requireAccess(context.auth.user.id, write)
    context.res.setHeader('cache-control', 'private, no-store')
    await next()
  }
}

/** Platform mutations always require origin + CSRF, even if legacy dev endpoints disable protection. */
export function assertPlatformWriteSecurity(context: RequestContext, env: NodeJS.ProcessEnv = process.env): void {
  if (!isAllowedRequestOrigin(context.req, env, env.NODE_ENV !== 'production')) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任')
  const token = typeof context.req.headers['x-csrf-token'] === 'string' ? context.req.headers['x-csrf-token'] : undefined
  const cookie = typeof context.req.headers.cookie === 'string' ? context.req.headers.cookie : undefined
  if (!validateCsrf(token, readCookie(cookie, 'smartrecruit_csrf', {production: env.NODE_ENV === 'production'}))) throw new HttpError(403, 'CSRF_TOKEN_INVALID', 'CSRF Token 无效')
}
