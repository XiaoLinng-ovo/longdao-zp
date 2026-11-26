// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import AppShell from './AppShell.vue'
import { authSession } from '../../modules/auth/session'

vi.mock('./SidebarNav.vue', () => ({ default: { template: '<aside data-sidebar />' } }))
vi.mock('./TopBar.vue', () => ({ default: { template: '<header data-topbar />' } }))
vi.mock('../../modules/interviews/components/BackgroundInterviewUploads.vue', () => ({ default: { template: '<section data-uploads />' } }))
vi.mock('../../shared/components/TrialQuotaBanner.vue', () => ({ default: { template: '<section data-quota />' } }))

let app: App | undefined
let root: HTMLDivElement | undefined
const originalUser = authSession.user
afterEach(() => { app?.unmount(); root?.remove(); authSession.user = originalUser })
async function mount(workspaceId?: string) {
  authSession.user = { id: 'local-user', ...(workspaceId ? { workspaceId } : {}) } as never
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div>existing page</div>' } },
    { path: '/other', component: { template: '<div>another page</div>' } },
  ] })
  await router.push('/'); await router.isReady()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(AppShell); app.use(router); app.mount(root); await nextTick()
  return router
}

it('keeps background uploads beside the existing shell and the new quota banner', async () => {
  await mount('workspace')
  expect(root!.querySelector('.app-shell [data-sidebar]')).not.toBeNull()
  expect(root!.querySelector('.app-main > [data-uploads]')).not.toBeNull()
  expect(root!.querySelector('.page-content [data-quota]')).not.toBeNull()
  expect(root!.textContent).toContain('existing page')
})

it('does not hide existing uploads when no enterprise workspace is selected', async () => {
  await mount()
  expect(root!.querySelector('[data-uploads]')).not.toBeNull()
  expect(root!.querySelector('[data-quota]')).toBeNull()
})

it('preserves the upload host and quota banner across page navigation', async () => {
  const router = await mount('workspace')
  const uploadHost = root!.querySelector('[data-uploads]')
  await router.push('/other'); await nextTick()
  expect(root!.querySelector('[data-uploads]')).toBe(uploadHost)
  expect(root!.querySelector('[data-quota]')).not.toBeNull()
  expect(root!.textContent).toContain('another page')
})
