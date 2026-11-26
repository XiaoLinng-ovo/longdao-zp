export interface TurnstileConfig {
  enabled: boolean
  siteKey: string
  secretKey: string
}

export function loadTurnstileConfig(env: NodeJS.ProcessEnv = process.env): TurnstileConfig {
  const enabled = env.TURNSTILE_ENABLED?.trim().toLowerCase() === 'true'
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || ''
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim() || ''
  if (enabled && (!siteKey || !secretKey) && env.NODE_ENV === 'production') {
    throw Object.assign(new Error('Turnstile 已启用但缺少站点密钥或服务端密钥'), {
      code: 'AUTH_SECURITY_CONFIG_INVALID',
      status: 503,
    })
  }
  return { enabled, siteKey, secretKey }
}

export async function verifyTurnstile(input: {
  token: string
  remoteIp?: string
  expectedAction?: string
  config?: TurnstileConfig
  fetcher?: typeof fetch
}): Promise<void> {
  const config = input.config ?? loadTurnstileConfig()
  if (!config.enabled) return
  const token = input.token.trim()
  if (!token || token.length > 4096) {
    throw Object.assign(new Error('请完成人机验证'), { code: 'TURNSTILE_REQUIRED', status: 400 })
  }
  const body = new URLSearchParams({ secret: config.secretKey, response: token })
  if (input.remoteIp) body.set('remoteip', input.remoteIp)
  const response = await (input.fetcher ?? fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) {
    throw Object.assign(new Error('人机验证服务暂时不可用，请稍后重试'), { code: 'TURNSTILE_UNAVAILABLE', status: 503 })
  }
  const result = await response.json() as { success?: boolean; action?: string; 'error-codes'?: string[] }
  if (!result.success) {
    throw Object.assign(new Error('人机验证失败，请重新验证'), { code: 'TURNSTILE_FAILED', status: 400, details: result['error-codes'] })
  }
  if (input.expectedAction && result.action !== input.expectedAction) {
    throw Object.assign(new Error('人机验证上下文无效，请重新验证'), { code: 'TURNSTILE_ACTION_MISMATCH', status: 400 })
  }
}
