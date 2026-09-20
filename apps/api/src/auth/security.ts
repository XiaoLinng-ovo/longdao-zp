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

export function isAllowedOrigin(origin: string | undefined, allowlist: string[]): boolean {
  if (!origin) return false
  return allowlist.includes(origin)
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
