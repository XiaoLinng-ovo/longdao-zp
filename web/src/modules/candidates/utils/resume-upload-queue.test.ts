import { describe, expect, it } from 'vitest'
import { runResumeUploadQueue } from './resume-upload-queue'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('runResumeUploadQueue', () => {
  it('limits in-flight uploads to three', async () => {
    let active = 0
    let peak = 0
    const results = await runResumeUploadQueue([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return item * 2
    })

    expect(peak).toBe(3)
    expect(results).toHaveLength(7)
    expect(results.every((result) => result.ok)).toBe(true)
  })

  it('continues other lanes when one upload fails', async () => {
    const completed: number[] = []
    const results = await runResumeUploadQueue([1, 2, 3, 4, 5], 3, async (item) => {
      if (item === 2) throw new Error('network failed')
      await Promise.resolve()
      completed.push(item)
      return item
    })

    expect(results.filter((result) => !result.ok)).toHaveLength(1)
    expect(completed.sort((left, right) => left - right)).toEqual([1, 3, 4, 5])
  })

  it('does not start more work after cancellation', async () => {
    const controller = new AbortController()
    const release = deferred()
    const started: number[] = []
    const running = runResumeUploadQueue([1, 2, 3, 4, 5, 6], 2, async (item) => {
      started.push(item)
      await release.promise
      return item
    }, controller.signal)

    await Promise.resolve()
    controller.abort()
    release.resolve()
    const results = await running

    expect(started).toEqual([1, 2])
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.ok)).toBe(true)
  })
})
