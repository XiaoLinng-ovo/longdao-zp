// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import TrialQuotaBanner from './TrialQuotaBanner.vue'
import { loadTrialUsage } from '../api/trial-usage'

vi.mock('../api/trial-usage', () => ({
  loadTrialUsage: vi.fn(),
  notifyTrialQuotaChanged: vi.fn(),
}))

let app: App | undefined
let root: HTMLDivElement | undefined

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
  root = undefined
  vi.clearAllMocks()
})

it('shows separate resume, interview and AI generation trial usage', async () => {
  vi.mocked(loadTrialUsage).mockResolvedValue({
    serviceStatus: 'trial',
    trialEndsAt: '2026-11-09T00:00:00.000Z',
    enforced: true,
    resumeUploads: { used: 2, limit: 3, remaining: 1, reached: false },
    interviews: { used: 3, limit: 3, remaining: 0, reached: true },
    aiGeneration: { used: 3, limit: 3, remaining: 0, reached: true },
  })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(TrialQuotaBanner)
  app.mount(root)
  await Promise.resolve()
  await nextTick()
  expect(root.textContent).toContain('简历 2 / 3')
  expect(root.textContent).toContain('真实面试 3 / 3')
  expect(root.textContent).toContain('AI 生成 3 / 3')
  expect(root.querySelector('.reached')?.textContent).toContain('真实面试')
})

it('keeps the current banner working before the backend quota upgrade', async () => {
  vi.mocked(loadTrialUsage).mockResolvedValue({
    serviceStatus: 'trial',
    trialEndsAt: '2026-11-09T00:00:00.000Z',
    enforced: true,
    resumeUploads: { used: 2, limit: 3, remaining: 1, reached: false },
    interviews: { used: 1, limit: 3, remaining: 2, reached: false },
  })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(TrialQuotaBanner)
  app.mount(root)
  await Promise.resolve()
  await nextTick()
  expect(root.textContent).toContain('简历 2 / 3')
  expect(root.textContent).toContain('真实面试 1 / 3')
  expect(root.textContent).not.toContain('AI 生成')
})

it('hides the banner outside an enforced trial', async () => {
  vi.mocked(loadTrialUsage).mockResolvedValue({
    serviceStatus: 'enabled',
    trialEndsAt: null,
    enforced: false,
    resumeUploads: { used: 2, limit: 3, remaining: 1, reached: false },
    interviews: { used: 3, limit: 3, remaining: 0, reached: false },
    aiGeneration: { used: 0, limit: 3, remaining: 3, reached: false },
  })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(TrialQuotaBanner)
  app.mount(root)
  await Promise.resolve()
  await nextTick()
  expect(root.textContent).not.toContain('14 天试用额度')
})
