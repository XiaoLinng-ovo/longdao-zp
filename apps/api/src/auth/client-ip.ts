import { BlockList, isIP } from 'node:net'

type AddressFamily = 'ipv4' | 'ipv6'

function normalizeAddress(value: string): string {
  const trimmed = value.trim()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(trimmed)
  return mapped?.[1] && isIP(mapped[1]) === 4 ? mapped[1] : trimmed
}

function familyOf(address: string): AddressFamily | undefined {
  const version = isIP(address)
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : undefined
}

function trustedProxyList(value: string | undefined): BlockList {
  const list = new BlockList()
  for (const entry of String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
    const [rawAddress, rawPrefix, ...extra] = entry.split('/')
    if (!rawAddress || extra.length > 0) continue
    const address = normalizeAddress(rawAddress)
    const family = familyOf(address)
    if (!family) continue
    if (rawPrefix === undefined) {
      list.addAddress(address, family)
      continue
    }
    if (!/^\d+$/u.test(rawPrefix)) continue
    const prefix = Number(rawPrefix)
    if (prefix > (family === 'ipv4' ? 32 : 128)) continue
    try {
      list.addSubnet(address, prefix, family)
    } catch {
      // Invalid configuration entries fail closed and are not trusted.
    }
  }
  return list
}

/**
 * Resolve the authentication client address without trusting caller-supplied
 * forwarding headers unless the TCP peer is a configured proxy.
 */
export function resolveAuthClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const remote = normalizeAddress(remoteAddress ?? '')
  const remoteFamily = familyOf(remote)
  if (!remote || !remoteFamily) return undefined

  const trusted = trustedProxyList(env.AUTH_TRUSTED_PROXY_IPS)
  if (!trusted.check(remote, remoteFamily) || forwardedFor === undefined) return remote

  const forwarded = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
  const chain = forwarded.split(',').map(normalizeAddress).filter(Boolean)
  if (chain.length === 0 || chain.length > 20 || chain.some((address) => !familyOf(address))) return remote

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index]
    const family = candidate ? familyOf(candidate) : undefined
    if (candidate && family && !trusted.check(candidate, family)) return candidate
  }
  return remote
}
