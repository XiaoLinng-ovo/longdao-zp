import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getJson } = vi.hoisted(() => ({ getJson: vi.fn() }))
vi.mock('../api', () => ({ apiClient: { getJson } }))

import { loadRuntimeFeatures, runtimeFeatures } from './runtime-features'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('runtime feature refresh', () => {
  beforeEach(() => {
    getJson.mockReset()
    Object.assign(runtimeFeatures, {
      loaded: false,
      loading: false,
      sessionKey: '',
      recruitmentReportsEnabled: false,
    })
  })

  it('lets a forced refresh supersede a stale in-flight feature request', async () => {
    const initialRequest = deferred<{ data: { recruitmentReportsEnabled: boolean } }>()
    const refreshedRequest = deferred<{ data: { recruitmentReportsEnabled: boolean } }>()
    getJson.mockReturnValueOnce(initialRequest.promise).mockReturnValueOnce(refreshedRequest.promise)

    const initialLoad = loadRuntimeFeatures('session:user')
    const forcedRefresh = loadRuntimeFeatures('session:user', true)
    expect(getJson).toHaveBeenCalledTimes(2)

    refreshedRequest.resolve({ data: { recruitmentReportsEnabled: true } })
    await forcedRefresh
    initialRequest.resolve({ data: { recruitmentReportsEnabled: false } })
    await initialLoad

    expect(runtimeFeatures.recruitmentReportsEnabled).toBe(true)
    expect(runtimeFeatures.loaded).toBe(true)
    expect(runtimeFeatures.loading).toBe(false)
  })
})
