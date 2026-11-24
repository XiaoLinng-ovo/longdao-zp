import { afterEach, describe, expect, it, vi } from 'vitest'
import { interviewRequest } from './request-timeout'

afterEach(() => vi.useRealTimers())

describe('interview request deadline', () => {
  it('aborts and rejects a hung request even when the transport ignores cancellation', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const pending = interviewRequest(value => { signal = value; return new Promise(() => {}) }, 60_000, 'save timed out')
    const rejected = expect(pending).rejects.toMatchObject({ code: 'INTERVIEW_REQUEST_TIMEOUT', retryable: true, message: '操作失败，请稍后重试' })
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the deadline after success without aborting the completed request', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    expect(await interviewRequest(async value => { signal = value; return ['saved'] }, 60_000, 'timeout')).toEqual(['saved'])
    expect(vi.getTimerCount()).toBe(0)
    expect(signal?.aborted).toBe(false)
  })

  it('preserves service errors and clears the deadline', async () => {
    vi.useFakeTimers()
    const cause = new Error('forbidden')
    await expect(interviewRequest(async () => { throw cause }, 60_000, 'timeout')).rejects.toBe(cause)
    expect(vi.getTimerCount()).toBe(0)
  })
})
