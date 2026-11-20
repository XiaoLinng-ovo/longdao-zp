export function createConcurrencyBudget(limit: number): (signal?: AbortSignal) => Promise<() => void> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('INVALID_CONCURRENCY_LIMIT')
  let active = 0
  const waiters: Array<() => void> = []
  return async (signal) => {
    signal?.throwIfAborted()
    if (active < limit) active += 1
    else await new Promise<void>((resolve, reject) => {
      const enter = () => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = () => {
        const index = waiters.indexOf(enter)
        if (index !== -1) waiters.splice(index, 1)
        reject(signal!.reason)
      }
      waiters.push(enter)
      signal?.addEventListener('abort', abort, { once: true })
    })
    let released = false
    return () => {
      if (released) return
      released = true
      const next = waiters.shift()
      if (next) next()
      else active -= 1
    }
  }
}
