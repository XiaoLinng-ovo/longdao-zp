import { ApiNetworkError } from '../../../shared/api/errors'

export async function interviewRequest<T>(request: (signal: AbortSignal) => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new ApiNetworkError(message, { code: 'INTERVIEW_REQUEST_TIMEOUT' })
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })
  try { return await Promise.race([request(controller.signal), deadline]) }
  finally { clearTimeout(timer) }
}
