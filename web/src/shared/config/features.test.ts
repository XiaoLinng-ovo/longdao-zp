import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })
describe('招聘平台发布功能开关', () => {
  it.each([undefined, 'false', '1', 'TRUE'])('默认禁用或非精确 true 配置 %s 保持隐藏', async (value) => {
    vi.resetModules(); vi.stubEnv('VITE_EXTERNAL_JOB_PUBLISHING_ENABLED', value)
    expect((await import('./features')).externalJobPublishingEnabled).toBe(false)
  })
  it('仅显式 true 恢复发布功能', async () => {
    vi.resetModules(); vi.stubEnv('VITE_EXTERNAL_JOB_PUBLISHING_ENABLED', 'true')
    expect((await import('./features')).externalJobPublishingEnabled).toBe(true)
  })
})
