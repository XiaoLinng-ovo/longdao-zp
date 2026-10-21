import type { AuthService } from './auth-service.js'
import type { AuthContext } from './types.js'
import { readCookie, type CookieOptions } from './security.js'

// Session secrets stay in an HttpOnly cookie; the browser only receives account metadata.
const COOKIE_NAME = 'smartrecruit_accounts'
const MAX_ACCOUNTS = 6
export interface SavedAccountSession { token: string; auth: AuthContext }

export async function readSavedAccountSessions(
  service: Pick<AuthService, 'authenticateToken'>,
  cookieHeader: string | undefined,
  production = false,
): Promise<SavedAccountSession[]> {
  let tokens: string[] = []
  try {
    const stored: unknown = JSON.parse(readCookie(cookieHeader, COOKIE_NAME, { production }) || '[]')
    if (Array.isArray(stored)) tokens = stored.filter((token): token is string => typeof token === 'string' && token.length <= 256).slice(-MAX_ACCOUNTS)
  } catch { /* An invalid saved-account cookie must not prevent signing in. */ }
  const current = readCookie(cookieHeader, 'smartrecruit_session', { production })
  if (current) tokens.push(current)
  const accounts = new Map<string, SavedAccountSession>()
  for (const token of new Set(tokens)) {
    const auth = await service.authenticateToken(token)
    if (auth) accounts.set(auth.user.id, { token, auth })
  }
  return [...accounts.values()].slice(-MAX_ACCOUNTS)
}

export function buildSavedAccountsCookie(accounts: SavedAccountSession[], options: CookieOptions = {}): string {
  const latest = new Map<string, SavedAccountSession>()
  for (const account of accounts) {
    latest.delete(account.auth.user.id)
    latest.set(account.auth.user.id, account)
  }
  const tokens = [...latest.values()].slice(-MAX_ACCOUNTS).map((account) => account.token)
  const maxAge = tokens.length ? options.maxAge ?? 60 * 60 * 12 : 0
  return `${options.production ? '__Host-' : ''}${COOKIE_NAME}=${encodeURIComponent(JSON.stringify(tokens))}; Path=/; HttpOnly; SameSite=Lax${options.production ? '; Secure' : ''}; Max-Age=${maxAge}`
}
