export class ResumeUploadError extends Error {
  constructor(message: string, readonly code: string, readonly status = 0, readonly retryAfterSeconds = 0, readonly requestId?: string) {
    super(message)
    this.name = 'ResumeUploadError'
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('上传已取消', 'AbortError'))
    }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export async function retryResumeUpload<T>(operation: () => Promise<T>, options: {
  signal?: AbortSignal
  maxRetries?: number
  onRetry?: (attempt: number, delayMs: number, error: ResumeUploadError) => void
} = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) throw new DOMException('上传已取消', 'AbortError')
    try { return await operation() } catch (error) {
      const retryable = error instanceof ResumeUploadError && (
        ['UPLOAD_IN_PROGRESS', 'RESUME_UPLOAD_BUSY', 'RESUME_ANALYSIS_QUEUE_FULL', 'UPLOAD_NETWORK_ERROR', 'UPLOAD_TIMEOUT'].includes(error.code)
        || [502, 503, 504].includes(error.status))
      if (!retryable || attempt >= (options.maxRetries ?? 5)) throw error
      const delayMs = Math.max(Math.min(2000 * 2 ** attempt, 15000), Math.min(30000, Math.max(0, error.retryAfterSeconds) * 1000)) + Math.floor(Math.random() * 250)
      options.onRetry?.(attempt + 1, delayMs, error)
      await wait(delayMs, options.signal)
    }
  }
}
