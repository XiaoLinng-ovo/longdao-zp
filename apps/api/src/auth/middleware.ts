import type { RequestContext } from '../http.js'
import type { AuthContext } from './types.js'
import { AuthService } from './auth-service.js'

const BEARER_PREFIX = 'Bearer '
const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-smartrecruit_session' : 'smartrecruit_session'

export const authService = new AuthService()

declare module '../http.js' {
  interface RequestContext {
    auth: AuthContext | undefined
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(
    header.split(';').map((part) => {
      const index = part.indexOf('=')
      if (index < 0) return [part.trim(), '']
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]
    }),
  )
}

function readSessionToken(context: RequestContext): string | undefined {
  const authorization = context.req.headers.authorization
  if (Array.isArray(authorization)) return undefined
  if (authorization?.startsWith(BEARER_PREFIX)) {
    return authorization.slice(BEARER_PREFIX.length).trim() || undefined
  }
  const cookies = parseCookies(context.req.headers.cookie)
  return cookies[SESSION_COOKIE]
}

export async function attachAuth(context: RequestContext): Promise<void> {
  const token = readSessionToken(context)
  const sessionAuth = await authService.authenticateToken(token)
  context.auth = sessionAuth ?? (authService.getBootstrapUser() ? { user: authService.getBootstrapUser()!, sessionId: 'development-bootstrap', method: 'development-bootstrap' } : undefined)
}
