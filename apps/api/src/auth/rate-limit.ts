export interface RateLimitOptions { maxAttempts?: number; windowMs?: number }
export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()
  private readonly maxAttempts: number; private readonly windowMs: number
  constructor(options: RateLimitOptions = {}) { this.maxAttempts = options.maxAttempts ?? 5; this.windowMs = options.windowMs ?? 15 * 60_000 }
  allow(key: string, now = Date.now()): boolean {
    const current = this.attempts.get(key)
    if (!current || current.resetAt <= now) { this.attempts.set(key, { count: 1, resetAt: now + this.windowMs }); return true }
    if (current.count >= this.maxAttempts) return false
    current.count++; return true
  }
  clear(key: string): void { this.attempts.delete(key) }
}
