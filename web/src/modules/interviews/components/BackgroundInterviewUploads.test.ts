// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { authSession } from '../../auth/session'
import { backgroundAudio } from '../utils/background-audio'
import BackgroundInterviewUploads from './BackgroundInterviewUploads.vue'

let app: App | undefined, root: HTMLDivElement | undefined
async function mount() {
  authSession.user = { id: 'u', workspaceId: 'w' } as never
  backgroundAudio.jobs.push({ id: 's', scope: 'w:u:i', interviewId: 'i', label: '候选人', pending: 232, phase: 'uploading', message: '', cacheWarning: '' })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/interviews/:id', component: { template: '<div />' } }] })
  await router.push('/interviews/i'); await router.isReady()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(BackgroundInterviewUploads); app.use(router); app.mount(root); await nextTick()
}
afterEach(() => { app?.unmount(); root?.remove(); backgroundAudio.jobs.splice(0); authSession.user = null; vi.restoreAllMocks() })
describe('global interview upload status', () => {
  it('shows live upload progress and a completed summary link without triggering navigation', async () => {
    await mount()
    expect(root!.textContent).toContain('待上传 232 段')
    backgroundAudio.jobs[0]!.pending = 3; await nextTick(); expect(root!.textContent).toContain('待上传 3 段')
    backgroundAudio.jobs[0]!.phase = 'completed'; await nextTick()
    expect(root!.textContent).toContain('会话已结束')
    expect(root!.querySelector('a')?.getAttribute('href')).toContain('openSummary=1')
    const dismiss = vi.spyOn(backgroundAudio, 'dismiss').mockImplementation(() => {})
    root!.querySelector<HTMLButtonElement>('[aria-label="关闭保存提示"]')!.click()
    expect(dismiss).toHaveBeenCalledWith('s')
  })
  it('keeps errors and cache warnings visible and exposes a per-session retry button', async () => {
    await mount(); const retry = vi.spyOn(backgroundAudio, 'retry').mockImplementation(() => {})
    Object.assign(backgroundAudio.jobs[0]!, { phase: 'failed', message: '网络连接失败', cacheWarning: '请勿刷新或关闭浏览器' }); await nextTick()
    expect(root!.textContent).toContain('网络连接失败'); expect(root!.textContent).toContain('请勿刷新或关闭浏览器')
    root!.querySelector<HTMLButtonElement>('[aria-label="重试后台保存"]')!.click()
    expect(retry).toHaveBeenCalledWith('s')
    expect(root!.querySelector('[aria-label="关闭保存提示"]')).toBeNull()
  })
  it('does not expose candidate names across tenants or users', async () => {
    await mount()
    authSession.user = { id: 'other', workspaceId: 'w' } as never; await nextTick()
    expect(root!.textContent).not.toContain('候选人')
    authSession.user = { id: 'u', workspaceId: 'other' } as never; await nextTick()
    expect(root!.querySelector('[aria-label="面试录音后台保存"]')).toBeNull()
  })
})
