// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import App from './App.vue'
import { authSession } from './modules/auth/session'
import { backgroundAudio } from './modules/interviews/utils/background-audio'
import { WORKSPACE_CONTEXT_EVENT, WORKSPACE_CONTEXT_STORAGE_KEY } from './shared/api/workspace-context'

vi.mock('./app/layout/AppShell.vue', () => ({ default: { template: '<router-view />' } }))
vi.mock('./modules/auth/session', async original => ({ ...await original<typeof import('./modules/auth/session')>(), refreshAuthSession: vi.fn() }))
let app: VueApp | undefined, root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 10; i++) { await Promise.resolve(); await nextTick() } }
async function mount() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div>工作台</div>' } },
    { path: '/other', component: { template: '<div>其他板块</div>' } },
  ] })
  await router.push('/'); await router.isReady()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(App); app.use(router); app.mount(root); await flush(); return router
}
beforeEach(() => {
  authSession.user = { id: 'u', workspaceId: 'w' } as never
  vi.spyOn(backgroundAudio, 'recover').mockResolvedValue()
  vi.spyOn(backgroundAudio, 'retry').mockImplementation(() => {})
  vi.spyOn(backgroundAudio, 'suspend').mockImplementation(() => {})
})
afterEach(() => { app?.unmount(); root?.remove(); backgroundAudio.jobs.splice(0); authSession.user = null; vi.restoreAllMocks() })
describe('application background audio lifecycle', () => {
  it('warns on browser close while unfinished uploads do not block in-app navigation', async () => {
    const router = await mount()
    backgroundAudio.jobs.push({ id: 's', scope: 'w:u:i', interviewId: 'i', label: '候选人', pending: 232, phase: 'uploading', message: '', cacheWarning: '' })
    const closing = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(closing)
    expect(closing.defaultPrevented).toBe(true)
    await router.push('/other'); await flush()
    expect(root!.textContent).toContain('其他板块'); expect(backgroundAudio.jobs[0]!.pending).toBe(232)
    backgroundAudio.jobs[0]!.phase = 'completed'
    const saved = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(saved)
    expect(saved.defaultPrevented).toBe(false)
  })
  it('recovers at app startup and when returning to an authenticated owner', async () => {
    await mount(); expect(backgroundAudio.recover).toHaveBeenCalled()
    const calls = vi.mocked(backgroundAudio.recover).mock.calls.length
    authSession.user = { id: 'other', workspaceId: 'w' } as never; await flush()
    expect(vi.mocked(backgroundAudio.recover).mock.calls.length).toBeGreaterThan(calls)
  })
  it('retries on reconnect and suspends on cross-tab workspace invalidation', async () => {
    await mount(); window.dispatchEvent(new Event('online'))
    expect(backgroundAudio.retry).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event(WORKSPACE_CONTEXT_EVENT))
    window.dispatchEvent(new StorageEvent('storage', { key: WORKSPACE_CONTEXT_STORAGE_KEY, newValue: 'changed' }))
    expect(backgroundAudio.suspend).toHaveBeenCalledTimes(2)
  })
  it('removes global upload event listeners when the application is unmounted', async () => {
    await mount(); app!.unmount(); app = undefined
    window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event(WORKSPACE_CONTEXT_EVENT))
    expect(backgroundAudio.retry).not.toHaveBeenCalled(); expect(backgroundAudio.suspend).not.toHaveBeenCalled()
  })
})
