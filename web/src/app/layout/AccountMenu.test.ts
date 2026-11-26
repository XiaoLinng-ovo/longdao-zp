// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountMenu from './AccountMenu.vue'
vi.mock('./NotificationBell.vue', () => ({default: {template:'<div />'}}))
import { authSession } from '../../modules/auth/session'
import { listSavedAccounts, listWorkspaces } from '../../modules/auth/api'
vi.mock('../../modules/auth/api', () => ({ listSavedAccounts: vi.fn(), listWorkspaces: vi.fn() }))
vi.mock('../../modules/auth/session', () => ({ authSession: { user: { id: 'admin', name: '系统管理员', email: 'admin@example.com', role: 'admin', departmentId: 'hr' } }, switchWorkspace: vi.fn(), switchAccount: vi.fn(), logoutCurrentUser: vi.fn() }))
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
  app = createApp(AccountMenu)
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

  it('企业操作全部位于账号面板，展开和收起不会关闭账号信息，管理入口可正常进入', async () => {
    Object.assign(authSession.user!, { workspaceId: 'A', workspaceName: '企业A', workspaceKind: 'test' })
    authSession.workspaces = [
      { id: 'A', name: '企业A', kind: 'test', status: 'active', role: 'owner', createdAt: '' },
      { id: 'B', name: '企业B', kind: 'test', status: 'active', role: 'member', createdAt: '' },
    ]
    vi.mocked(listWorkspaces).mockResolvedValue(authSession.workspaces)
    expect(root.querySelector('.workspace-switcher')).toBeNull()
    root.querySelector<HTMLButtonElement>('.account-trigger')!.click()
    await flush()
    const trigger = root.querySelector<HTMLButtonElement>('.workspace-switcher-trigger')!
    expect(trigger.closest('.account-card')).not.toBeNull()
    trigger.click()
    await flush()
    expect(listWorkspaces).toHaveBeenCalledOnce()
    expect(root.querySelectorAll('.workspace-switcher-item')).toHaveLength(2)
    expect(root.querySelector('.account-card')).not.toBeNull()
    trigger.click()
    await flush()
    expect(root.querySelector('.workspace-switcher-panel')).toBeNull()
    expect(root.querySelector('.account-card')).not.toBeNull()
    trigger.click()
    await flush()
    const manage = root.querySelector<HTMLAnchorElement>('.workspace-switcher-manage')!
    expect(manage.getAttribute('href')).toBe('/workspaces')
    manage.click()
    await flush()
    expect(root.querySelector('.account-card')).toBeNull()
  })

  it('外部点击关闭整个面板，再次打开不会残留展开的企业列表', async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([])
    root.querySelector<HTMLButtonElement>('.account-trigger')!.click()
    await flush()
    root.querySelector<HTMLButtonElement>('.workspace-switcher-trigger')!.click()
    await flush()
    document.body.click()
    await flush()
    expect(root.querySelector('.account-card')).toBeNull()
    root.querySelector<HTMLButtonElement>('.account-trigger')!.click()
    await flush()
    expect(root.querySelector('.workspace-switcher-panel')).toBeNull()
    root.querySelector<HTMLButtonElement>('.workspace-switcher-trigger')!.click()
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flush()
    expect(root.querySelector('.account-card')).toBeNull()
    expect(document.activeElement).toBe(root.querySelector('.account-trigger'))
  })

  it('shows the current workspace and opens user information from the account details', async () => {
    Object.assign(authSession.user!, { workspaceId: 'workspace-1', workspaceName: '龙道科技', workspaceKind: 'production' })
    authSession.workspaces = [{ id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', serviceStatus: 'trial', trialEndsAt: '2026-12-01T00:00:00.000Z', role: 'owner', createdAt: '2026-10-26' }]

    root.querySelector<HTMLButtonElement>('.account-trigger')!.click()
    await flush()

    expect(root.querySelector('.account-workspace-row')?.textContent).toContain('当前企业空间')
    expect(root.querySelector('.account-workspace-row')?.textContent).toContain('龙道科技')
    expect(root.querySelector('.account-workspace-kind')?.textContent).toBe('试用中')
    expect(root.querySelector('.account-workspace-row')?.textContent).toContain('企业主管理员')

    const profileLink = root.querySelector<HTMLAnchorElement>('.account-profile-entry')!
    expect(profileLink.getAttribute('href')).toBe('/profile')
    profileLink.click()
    await flush()
    expect(root.querySelector('.account-card')).toBeNull()
  })
})
