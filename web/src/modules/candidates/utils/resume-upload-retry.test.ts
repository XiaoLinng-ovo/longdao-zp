import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResumeUploadError, retryResumeUpload } from './resume-upload-retry'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('resume upload congestion retry', () => {
  it('backs off, respects Retry-After and keeps the same upload operation', async () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0)
    const operation = vi.fn().mockRejectedValueOnce(new ResumeUploadError('busy', 'RESUME_UPLOAD_BUSY', 429, 10)).mockResolvedValue('task-1')
    const retry = vi.fn()
    const pending = retryResumeUpload(operation, { onRetry: retry })
    await vi.advanceTimersByTimeAsync(9999)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith(1, 10000, expect.objectContaining({ code: 'RESUME_UPLOAD_BUSY' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe('task-1')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it.each(['UPLOAD_IN_PROGRESS', 'RESUME_ANALYSIS_QUEUE_FULL', 'UPLOAD_NETWORK_ERROR', 'UPLOAD_TIMEOUT'])('retries temporary %s', async code => {
    vi.useFakeTimers()
    const operation = vi.fn().mockRejectedValueOnce(new ResumeUploadError('temporary', code)).mockResolvedValue('done')
    const pending = retryResumeUpload(operation)
    await vi.runAllTimersAsync()
    expect(await pending).toBe('done')
    expect(operation).toHaveBeenCalledTimes(2)
  })

  it('does not retry validation errors or unrelated conflicts', async () => {
    for (const error of [new ResumeUploadError('bad file', 'VALIDATION_ERROR', 400), new ResumeUploadError('cancelled', 'BATCH_CANCELLED', 409), new Error('permanent')]) {
      const operation = vi.fn().mockRejectedValue(error)
      await expect(retryResumeUpload(operation)).rejects.toBe(error)
      expect(operation).toHaveBeenCalledTimes(1)
    }
  })

  it('bounds retries and retains the original error when congestion persists', async () => {
    vi.useFakeTimers()
    const error = new ResumeUploadError('queue full', 'RESUME_ANALYSIS_QUEUE_FULL', 429)
    const operation = vi.fn().mockRejectedValue(error)
    const pending = retryResumeUpload(operation, { maxRetries: 2 })
    const assertion = expect(pending).rejects.toBe(error)
    await vi.runAllTimersAsync(); await assertion
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('cancels during backoff immediately without starting another upload', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const operation = vi.fn().mockRejectedValue(new ResumeUploadError('busy', 'RESUME_UPLOAD_BUSY', 429))
    const pending = retryResumeUpload(operation, { signal: controller.signal })
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(); await assertion
    await vi.runAllTimersAsync()
    expect(operation).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
