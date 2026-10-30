// @vitest-environment jsdom
import { createApp, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
import { authSession, switchWorkspace } from '../../modules/auth/session'
import { listWorkspaces, type WorkspaceSummary } from '../../modules/auth/api'

vi.mock('../../modules/auth/api', () => ({ listWorkspaces: vi.fn() }))
vi.mock('../../modules/auth/session', () => ({ authSession: reactive({ user: null, workspaces: [] }), switchWorkspace: vi.fn() }))
const workspace = (id: string, status: 'active' | 'archived' = 'active'): WorkspaceSummary => ({ id, name: `企业${id}`, kind: 'test', status, role: 'owner', createdAt: '' })
let app: App
let root: HTMLDivElement
const navigate = vi.fn()
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
function trigger() { return root.querySelector<HTMLButtonElement>('.workspace-switcher-trigger')! }
function choices() { return [...root.querySelectorAll<HTMLButtonElement>('.workspace-switcher-item')] }
beforeEach(() => {
  vi.resetAllMocks()
  authSession.user = { id: 'u', name: '用户', email: 'test@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'A', workspaceName: '企业A', workspaceKind: 'test' }
  authSession.workspaces = [workspace('A'), workspace('B'), workspace('C', 'archived')]
  vi.mocked(listWorkspaces).mockResolvedValue([...authSession.workspaces])
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(WorkspaceSwitcher)
  app.component('router-link', { props: ['to'], template: '<a :href="to"><slot /></a>' })
  app.mount(root)
})
afterEach(() => { app.unmount(); root.remove(); vi.unstubAllGlobals() })

describe('企业快速切换', () => {
  it('显示当前企业，刷新列表，隐藏已归档企业并保留管理入口', async () => {
    expect(trigger().textContent).toContain('企业A')
    trigger().click(); await flush()
    expect(listWorkspaces).toHaveBeenCalledOnce()
    expect(choices()).toHaveLength(2)
    expect(choices()[0].disabled).toBe(true)
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/workspaces')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await flush()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
  it('切换成功后重新加载，不复用旧企业页面数据', async () => {
    vi.mocked(switchWorkspace).mockResolvedValue(undefined)
    trigger().click(); await flush()
    vi.stubGlobal('window', { location: { assign: navigate } })
    choices()[1].click(); await flush()
    expect(switchWorkspace).toHaveBeenCalledWith('B')
    expect(navigate).toHaveBeenCalledWith('/')
    expect(root.querySelector('[role="dialog"]')).toBeNull()
  })
  it('阻止重复切换，失败时保留当前企业且展示错误', async () => {
    let reject!: (cause: Error) => void
    vi.mocked(switchWorkspace).mockReturnValue(new Promise((_resolve, r) => { reject = r }))
    trigger().click(); await flush()
    choices()[1].click(); choices()[1].click(); await flush()
    expect(switchWorkspace).toHaveBeenCalledOnce()
    expect(choices().every(button => button.disabled)).toBe(true)
    reject(new Error('网络不可用')); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('网络不可用')
    expect(authSession.user?.workspaceId).toBe('A')
    expect(choices()[1].disabled).toBe(false)
  })
  it('读取失败时不清空已有企业列表，并允许重试', async () => {
    vi.mocked(listWorkspaces).mockRejectedValue(new Error('列表读取失败'))
    trigger().click(); await flush()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('列表读取失败')
    expect(choices()).toHaveLength(2)
    expect(authSession.workspaces).toHaveLength(3)
    document.body.click(); await flush()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
  })
})
