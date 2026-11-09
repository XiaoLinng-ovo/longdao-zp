// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TopBar from './TopBar.vue'
import { authSession } from '../../modules/auth/session'
import { listSavedAccounts } from '../../modules/auth/api'
vi.mock('../../modules/auth/api', () => ({ listSavedAccounts: vi.fn() }))
vi.mock('../../modules/auth/session', () => ({ authSession: { user: { id: 'admin', name: '系统管理员', email: 'admin@example.com', role: 'admin', departmentId: 'hr' } }, switchAccount: vi.fn(), logoutCurrentUser: vi.fn() }))
let app: App
let root: HTMLDivElement
async function flush() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await nextTick() } }
function button(text: string) { return [...root.querySelectorAll('button')].find(item => item.textContent?.includes(text))! }
beforeEach(() => {
  vi.resetAllMocks()
  authSession.user = { id: 'admin', name: '系统管理员', email: 'admin@example.com', role: 'admin', departmentId: 'hr' }
  authSession.workspaces = []
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(TopBar, { title: '工作台', crumb: '招聘' })
  app.component('router-link', { props: ['to'], template: '<a :href="to" @click.prevent><slot /></a>' })
  app.mount(root)
})
afterEach(() => { app.unmount(); root.remove() })
describe('account popover', () => {
  it('puts the switch control alongside the name and shows saved-account cards without changing current identity', async () => {
    vi.mocked(listSavedAccounts).mockResolvedValue([
      { user: authSession.user!, current: true },
      { user: { id: 'hr', name: '招聘专员', email: 'hr@example.com', role: 'recruiter', departmentId: 'hr' }, current: false },
    ])
    root.querySelector<HTMLButtonElement>('.account-trigger')!.click()
    await flush()
    expect(root.querySelector('.account-name-line strong')?.textContent).toBe('系统管理员')
    button('切换账号').click()
    await flush()
    expect(listSavedAccounts).toHaveBeenCalledOnce()
    expect(root.querySelectorAll('.saved-account-item')).toHaveLength(2)
    expect(root.querySelector<HTMLButtonElement>('.is-current')?.disabled).toBe(true)
    expect(root.querySelector('.account-add')?.getAttribute('href')).toBe('/login?addAccount=1')
    expect(authSession.user?.id).toBe('admin')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(root.querySelector('.account-card')).toBeNull()
  })
  it('explains an empty list and presents request failures instead of inventing accounts', async () => {
    vi.mocked(listSavedAccounts).mockResolvedValue([])
    root.querySelector<HTMLButtonElement>('.account-trigger')!.click()
    await flush()
    button('切换账号').click()
    await flush()
    expect(root.textContent).toContain('暂无其他已保存账号')
    button('切换账号').click()
    await flush()
    vi.mocked(listSavedAccounts).mockRejectedValue(new Error('网络不可用'))
    button('切换账号').click()
    await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toBeTruthy()
    expect(root.querySelector('.account-add')).not.toBeNull()
  })

  it('shows the current workspace and opens user information from the account details', async () => {
    Object.assign(authSession.user!, { workspaceId: 'workspace-1', workspaceName: '龙道科技', workspaceKind: 'production' })
    authSession.workspaces = [{ id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-26' }]

    root.querySelector<HTMLButtonElement>('.account-trigger')!.click()
    await flush()

    expect(root.querySelector('.account-workspace-row')?.textContent).toContain('当前企业空间')
    expect(root.querySelector('.account-workspace-row')?.textContent).toContain('龙道科技')
    expect(root.querySelector('.account-workspace-kind')?.textContent).toBe('正式')
    expect(root.querySelector('.account-workspace-row')?.textContent).toContain('企业所有者')

    const profileLink = root.querySelector<HTMLAnchorElement>('.account-profile-entry')!
    expect(profileLink.getAttribute('href')).toBe('/profile')
    profileLink.click()
    await flush()
    expect(root.querySelector('.account-card')).toBeNull()
  })
})
