export function createAnalysisRetryState(maxAttempts = 3) {
  const pending = new Set<string>()
  const completed = new Set<string>()
  const attempts = new Map<string, number>()
  const revisions = new Map<string, string>()
  const blocked = new Map<string, string>()
  const availableAt = new Map<string, number>()
  return {
    claim(id: string, revision = id): boolean {
      if (pending.has(id) || completed.has(id)) return false
      if (revisions.get(id) !== revision) {
        revisions.set(id, revision)
        attempts.delete(id)
        blocked.delete(id)
        availableAt.delete(id)
      }
      if (blocked.has(id) || (availableAt.get(id) ?? 0) > Date.now()) return false
      if (pending.has(id) || completed.has(id) || (attempts.get(id) ?? 0) >= maxAttempts) return false
      pending.add(id)
      attempts.set(id, (attempts.get(id) ?? 0) + 1)
      return true
    },
    succeed(id: string): void {
      pending.delete(id)
      completed.add(id)
    },
    fail(id: string, retryDelayMs = 0): void {
      pending.delete(id)
      availableAt.set(id, Date.now() + retryDelayMs)
    },
    block(id: string, revision: string): void {
      pending.delete(id)
      revisions.set(id, revision)
      blocked.set(id, revision)
    },
    isBlocked(id: string, revision: string): boolean {
      return blocked.get(id) === revision
    },
    retryDelay(id: string): number {
      return Math.min(30_000, 2000 * 2 ** Math.max(0, (attempts.get(id) ?? 1) - 1))
    },
    restore(id: string): void {
      pending.delete(id)
      completed.add(id)
      attempts.delete(id)
    },
  }
}
