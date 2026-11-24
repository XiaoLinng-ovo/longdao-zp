import type { Middleware } from '../http.js'
import type { AuthService } from '../auth/auth-service.js'
import { isSystemAdministrationPath, requireSystemAdministrator } from '../auth/system-administrator.js'
import { assertPlatformWriteSecurity } from '../platform/access.js'

export function createSystemAdministrationAccessMiddleware(
  service: Pick<AuthService, 'authorizeSystemAdministrator'>,
  env: NodeJS.ProcessEnv = process.env,
): Middleware {
  return async (context, next) => {
    if (!isSystemAdministrationPath(context.url.pathname)) return next()
    // Re-read the account before idempotent replay, ignoring cached or forged permission flags.
    await service.authorizeSystemAdministrator(context.auth)
    requireSystemAdministrator(context.auth)
    if (!['GET', 'HEAD'].includes(context.req.method ?? 'GET')) assertPlatformWriteSecurity(context, env)
    context.res.setHeader('cache-control', 'private, no-store')
    await next()
  }
}
