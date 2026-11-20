// @vitest-environment jsdom
import { createApp, nextTick, reactive, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import SidebarNav from './SidebarNav.vue'
import { authSession } from '../../modules/auth/session'

vi.mock('../../modules/auth/session', () => ({
  authSession: reactive({ user: { id: 'u', name: '测试成员', email: 'member@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'w' }, workspaces: [] }),
  switchWorkspace: vi.fn(), switchAccount: vi.fn(), logoutCurrentUser: vi.fn(),
}))
vi.mock('../../modules/auth/api', () => ({ listSavedAccounts: vi.fn(), listWorkspaces: vi.fn() }))
let app: App | undefined
let root: HTMLDivElement | undefined
afterEach(() => { app?.unmount(); root?.remove() })
it('用户入口位于导航之后的侧栏底部，替换版本说明并能进入个人资料', async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/profile', component: { template: '<div />' } },
    { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
  ] })
  await router.push('/')
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(SidebarNav)
  app.use(router)
  app.mount(root)
  const footer = root.querySelector('.sidebar-account')!
  expect(footer.previousElementSibling?.tagName).toBe('NAV')
  expect(root.querySelector('.sidebar-footer')).toBeNull()
  expect(root.textContent).not.toContain('合并增强版')
  expect(root.querySelectorAll('.account-trigger')).toHaveLength(1)
  expect(footer.textContent).toContain(authSession.user!.name)
  footer.querySelector<HTMLButtonElement>('.account-trigger')!.click()
  await nextTick()
  expect(footer.querySelector('[role="dialog"]')).not.toBeNull()
  expect(footer.querySelector('.workspace-switcher')).not.toBeNull()
  footer.querySelector<HTMLAnchorElement>('.account-profile-entry')!.click()
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/profile'))
  await nextTick()
  expect(footer.querySelector('[role="dialog"]')).toBeNull()
})
