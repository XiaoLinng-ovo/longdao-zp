import type { IncomingMessage } from 'node:http'
import { isTrustedProxyAddress } from './client-ip.js'
import { allowsLocalDevelopmentOrigins, isAllowedOrigin, parseAllowedOrigins } from './security.js'

/** Forwarding headers are usable only from the local gateway or explicitly trusted proxies. */
export function requestOrigin(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const proxies = ['127.0.0.1/8', '::1', env.ORIGIN_TRUSTED_PROXY_IPS ?? env.AUTH_TRUSTED_PROXY_IPS ?? ''].join(',')
  const trusted = isTrustedProxyAddress(req.socket?.remoteAddress, proxies)
  let host = req.headers.host
  let protocol = (req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http'
  if (trusted) {
    const forwardedHost = req.headers['x-forwarded-host']
    const forwardedProtocol = req.headers['x-forwarded-proto']
    if (forwardedHost !== undefined) {
      if (typeof forwardedHost !== 'string') return undefined
      host = forwardedHost
    }
    if (forwardedProtocol !== undefined) {
      if (forwardedProtocol !== 'http' && forwardedProtocol !== 'https') return undefined
      protocol = forwardedProtocol
    }
  }
  if (!host || /[\s,/@\\?#%]/u.test(host)) return undefined
  try {
    const target = new URL(`${protocol}://${host}`)
    const authority = host.toLowerCase()
    const defaultPort = protocol === 'https' ? '443' : '80'
    if (authority !== target.host && authority !== `${target.hostname}:${defaultPort}`) return undefined
    return target.origin
  } catch {
    return undefined
  }
}

export function isAllowedRequestOrigin(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
  allowDevelopmentOrigins = allowsLocalDevelopmentOrigins(env),
): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string') return false
  if (isAllowedOrigin(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS), allowDevelopmentOrigins)) return true
  return origin === requestOrigin(req, env)
}
