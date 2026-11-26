import type { Middleware } from '../http.js'
import { HttpError } from '../http.js'
import { readCookie, shouldProtectCsrf, validateCsrf } from './security.js'
import { isAllowedRequestOrigin } from './request-origin.js'

const accountWritePaths = new Set(['/api/v1/me', '/api/v1/auth/logout', '/api/v1/auth/mfa/setup/start',
  '/api/v1/auth/account/email/code', '/api/v1/auth/account/email', '/api/v1/auth/account/password', '/api/v1/auth/account/password/code', '/api/v1/auth/account/password/verify'])

// These routes return before recruiting-route security; guard them before idempotency replay too.
export function createAccountWriteSecurityMiddleware(env: NodeJS.ProcessEnv = process.env): Middleware {
  return async (context, next) => {
    const path = context.url.pathname
    const covered = accountWritePaths.has(path) || path === '/api/v1/workspaces' || path.startsWith('/api/v1/workspaces/')
      || path === '/api/v1/workspace-invitations/preview' || path === '/api/v1/workspace-invitations/accept'
    if (!covered || !shouldProtectCsrf(context.req.method, env.REQUIRE_CSRF)) return next()
    const origin = typeof context.req.headers.origin === 'string' ? context.req.headers.origin : undefined
    const strict = env.NODE_ENV === 'production' || env.REQUIRE_CSRF === 'true'
    if ((origin || strict) && !isAllowedRequestOrigin(context.req, env)) {
      throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任')
    }
    const token = typeof context.req.headers['x-csrf-token'] === 'string' ? context.req.headers['x-csrf-token'] : undefined
    const cookie = typeof context.req.headers.cookie === 'string' ? context.req.headers.cookie : undefined
    if (!validateCsrf(token, readCookie(cookie, 'smartrecruit_csrf', { production: env.NODE_ENV === 'production' }))) {
      throw new HttpError(403, 'CSRF_TOKEN_INVALID', 'CSRF Token 无效')
    }
    await next()
  }
}
