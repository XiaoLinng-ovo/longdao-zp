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

describe('单企业信息', () => {
  it('固定展示当前企业，不提供切换按钮', async () => {
    await flush()
    expect(root.textContent).toContain('企业A')
    expect(root.querySelectorAll('button')).toHaveLength(0)
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/workspaces')
    expect(listWorkspaces).not.toHaveBeenCalled()
    expect(switchWorkspace).not.toHaveBeenCalled()
  })
  it('未绑定账号显示创建加入入口', async () => {
    authSession.user!.workspaceId=undefined
    authSession.user!.workspaceName=undefined
    authSession.workspaces=[]
    await flush()
    expect(root.textContent).toContain('尚未加入企业')
    expect(root.querySelector('a')?.textContent).toContain('创建 / 加入')
  })
  it('已停用成员仍展示企业归属', async () => {
    authSession.workspaces=[{...workspace('A'),membershipActive:false}]
    await flush()
    expect(root.textContent).toContain('企业A')
    expect(root.textContent).toContain('成员已停用')
  })
})
