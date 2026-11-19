export interface BackgroundPollOptions {
  intervalMs: number
  concurrency?: number
  immediate?: boolean
  run(stopped: () => boolean): Promise<void>
  onError(error: unknown): void
}

/** Stop new claims synchronously; drain started iterations before releasing dependencies. */
export function startBackgroundPoll(options: BackgroundPollOptions): () => Promise<void> {
  let closed = false
  let closing: Promise<void> | undefined
  const active = new Set<Promise<void>>()
  const tick = () => {
    if (closed || active.size >= (options.concurrency ?? 1)) return
    let finished!: () => void
    const pending = new Promise<void>(resolve => { finished = resolve })
    active.add(pending)
    const complete = () => { active.delete(pending); finished() }
    void (async () => { await options.run(() => closed) })().catch(options.onError).then(complete, complete)
  }
  const timer = setInterval(tick, options.intervalMs)
  timer.unref()
  if (options.immediate !== false) tick()
  return () => {
    closed = true
    clearInterval(timer)
    return closing ??= Promise.all(active).then(() => undefined)
  }
}
