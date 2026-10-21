import { randomBytes } from 'node:crypto'

export interface CookieOptions { production?: boolean; maxAge?: number }

const cookiePrefix = (production: boolean | undefined) => production ? '__Host-' : ''

export function buildAuthCookie(token: string, options: CookieOptions = {}): string {
  const prefix = cookiePrefix(options.production)
  const maxAge = options.maxAge ?? 60 * 60 * 12
  return `${prefix}smartrecruit_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${options.production ? '; Secure' : ''}; Max-Age=${maxAge}`
}

export function buildCsrfCookie(token: string, options: CookieOptions = {}): string {
  const prefix = cookiePrefix(options.production)
  const maxAge = options.maxAge ?? 60 * 60 * 12
  return `${prefix}smartrecruit_csrf=${encodeURIComponent(token)}; Path=/; SameSite=Lax${options.production ? '; Secure' : ''}; Max-Age=${maxAge}`
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

export function isAllowedOrigin(origin: string | undefined, allowlist: string[], allowDevelopmentOrigins = false): boolean {
  if (!origin) return false
  if (allowlist.includes(origin)) return true
  if (!allowDevelopmentOrigins) return false

  try {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false
    if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')) return true
    return parsed.protocol === 'https:' && /^[a-z0-9-]+\.trycloudflare\.com$/iu.test(parsed.hostname)
  } catch {
    return false
  }
}

const resumeUploadOriginRelaxedPaths = new Set([
  '/api/v1/candidates',
  '/api/v1/applications',
  '/api/v1/resumes'
])

/**
 * Resume onboarding may be opened from a temporary browser/tunnel origin.
 * Keep this opt-in and narrow: only the three POST endpoints used by import
 * allow a valid HTTP(S) origin outside the configured exact allowlist.
 */
export function isAllowedResumeUploadOrigin(
  origin: string | undefined,
  allowlist: string[],
  path: string,
  method: string | undefined,
  relaxOrigin: string | undefined,
  allowDevelopmentOrigins = false
): boolean {
  if (isAllowedOrigin(origin, allowlist, allowDevelopmentOrigins)) return true
  if (relaxOrigin !== 'true' || method?.toUpperCase() !== 'POST' || !resumeUploadOriginRelaxedPaths.has(path) || !origin) return false

  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin
  } catch {
    return false
  }
}

/** Parse ALLOWED_ORIGINS environment value into a normalized allowlist. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Whether CSRF checks should run for a request method and configuration flag. Defaults to enabled. */
export function shouldProtectCsrf(method: string | undefined, requireCsrf: string | undefined): boolean {
  return requireCsrf !== 'false' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((method ?? '').toUpperCase())
}

export function validateCsrf(requestToken: string | undefined, cookieToken: string | undefined): boolean {
  return Boolean(requestToken && cookieToken && requestToken === cookieToken)
}

export function readCookie(header: string | undefined, name: string, options: { production?: boolean } = {}): string | undefined {
  if (!header) return undefined
  const cookieName = `${cookiePrefix(options.production)}${name}`
  const part = header.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))
  return part ? decodeURIComponent(part.slice(cookieName.length + 1)) : undefined
}
