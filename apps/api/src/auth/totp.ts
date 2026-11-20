import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function encodeBase32(value: Buffer): string {
  let bits = 0
  let accumulator = 0
  let output = ''
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31]
  return output
}

function decodeBase32(value: string): Buffer {
  const normalized = value.replace(/=+$/u, '').toUpperCase()
  let bits = 0
  let accumulator = 0
  const bytes: number[] = []
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) throw new Error('Invalid TOTP secret')
    accumulator = (accumulator << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20))
}

export function totpStep(nowMs = Date.now(), periodSeconds = 30): number {
  return Math.floor(nowMs / 1000 / periodSeconds)
}

export function generateTotp(secret: string, step = totpStep()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', decodeBase32(secret)).update(counter).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(value).padStart(6, '0')
}

export function verifyTotp(secret: string, code: string, options: { nowMs?: number; window?: number } = {}): { valid: boolean; step: number } {
  const normalized = code.replace(/\s+/gu, '')
  if (!/^\d{6}$/u.test(normalized)) return { valid: false, step: 0 }
  const currentStep = totpStep(options.nowMs)
  const window = options.window ?? 1
  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset
    const expected = generateTotp(secret, step)
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) return { valid: true, step }
  }
  return { valid: false, step: 0 }
}

export function buildTotpUri(secret: string, email: string, issuer = '智能招聘平台'): string {
  const label = encodeURIComponent(`${issuer}:${email}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${params.toString()}`
}

function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

export function encryptMfaSecret(secret: string, keyMaterial = process.env.AUTH_MFA_ENCRYPTION_KEY || ''): string {
  if (keyMaterial.trim().length < 32) {
    throw Object.assign(new Error('未配置管理员 MFA 加密密钥'), { code: 'AUTH_SECURITY_CONFIG_INVALID', status: 503 })
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyMaterial), iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
}

export function decryptMfaSecret(encrypted: string, keyMaterial = process.env.AUTH_MFA_ENCRYPTION_KEY || ''): string {
  if (keyMaterial.trim().length < 32) {
    throw Object.assign(new Error('未配置管理员 MFA 加密密钥'), { code: 'AUTH_SECURITY_CONFIG_INVALID', status: 503 })
  }
  const [version, ivText, tagText, ciphertextText] = encrypted.split('.')
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('Invalid encrypted MFA secret')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyMaterial), Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8')
}

export function createRecoveryCodes(count = 8): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: count }, () => randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/gu)!.join('-'))
  return { codes, hashes: codes.map(hashRecoveryCode) }
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.replace(/[\s-]+/gu, '').toUpperCase()).digest('hex')
}

export function consumeRecoveryCode(code: string, hashes: string[]): { matched: boolean; remaining: string[] } {
  const actual = hashRecoveryCode(code)
  const matched = hashes.some((expected) => /^[a-f0-9]{64}$/u.test(expected) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex')))
  return { matched, remaining: matched ? hashes.filter((item) => item !== actual) : hashes }
}
