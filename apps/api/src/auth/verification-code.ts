import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { VerificationPurpose } from './types.js'

export const DEFAULT_VERIFICATION_SECRET = 'smartrecruit-development-verification-secret-change-me'

export function normalizeVerificationEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase()
  if (email.length > 254 || !/^\S+@\S+\.\S+$/u.test(email)) {
    throw Object.assign(new Error('请输入有效邮箱'), { code: 'VALIDATION_ERROR', status: 400 })
  }
  return email
}

export function normalizeVerificationCode(value: unknown): string {
  const code = String(value ?? '').replace(/\s+/gu, '')
  if (!/^\d{6}$/u.test(code)) {
    throw Object.assign(new Error('请输入 6 位邮箱验证码'), { code: 'VALIDATION_ERROR', status: 400 })
  }
  return code
}

export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function hashVerificationCode(
  purpose: VerificationPurpose,
  email: string,
  code: string,
  secret = process.env.AUTH_OTP_HMAC_SECRET || DEFAULT_VERIFICATION_SECRET,
): string {
  return createHmac('sha256', secret)
    .update(`${purpose}:${email.trim().toLowerCase()}:${code}`)
    .digest('hex')
}

export function safeHashEqual(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(actual) || !/^[a-f0-9]{64}$/u.test(expected)) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

export function assertVerificationSecret(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && (env.AUTH_OTP_HMAC_SECRET?.trim().length ?? 0) < 32) {
    throw Object.assign(new Error('生产环境必须配置至少 32 字符的 AUTH_OTP_HMAC_SECRET'), {
      code: 'AUTH_SECURITY_CONFIG_INVALID',
      status: 503,
    })
  }
}
