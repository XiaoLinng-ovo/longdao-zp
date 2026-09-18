export function createAnalysisRetryState(maxAttempts = 3) {
  const pending = new Set<string>()
  const completed = new Set<string>()
  const attempts = new Map<string, number>()
  return {
    claim(id: string): boolean {
      if (pending.has(id) || completed.has(id) || (attempts.get(id) ?? 0) >= maxAttempts) return false
      pending.add(id)
      attempts.set(id, (attempts.get(id) ?? 0) + 1)
      return true
    },
    succeed(id: string): void {
      pending.delete(id)
      completed.add(id)
    },
    fail(id: string): void {
      pending.delete(id)
    },
    restore(id: string): void {
      pending.delete(id)
      completed.add(id)
      attempts.delete(id)
    },
  }
}
