import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
function derive(password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCallback(password, salt, keylen, options, (error, value) => error ? reject(error) : resolve(value as Buffer)))
}
const N = 16384; const R = 8; const P = 1; const KEYLEN = 64

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await derive(password, salt, KEYLEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const [algo, n, r, p, saltText, hashText] = encoded.split('$')
    if (algo !== 'scrypt' || !saltText || !hashText) return false
    const salt = Buffer.from(saltText, 'base64url'); const expected = Buffer.from(hashText, 'base64url')
    const actual = await derive(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch { return false }
}
