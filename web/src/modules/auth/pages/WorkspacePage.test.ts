// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App, type Component } from 'vue'
import WorkspacePage from './WorkspacePage.vue'
import LoginPage from './LoginPage.vue'
import { authSession } from '../session'
import { listWorkspaces, logout } from '../api'

const { routerReplace, routerPush, route } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  routerPush: vi.fn(),
  route: { query: {} as Record<string, unknown> },
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => route,
    useRouter: () => ({ replace: routerReplace, push: routerPush }),
  }
})

vi.mock('../api', () => ({
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  getCurrentUser: vi.fn(),
  listWorkspaces: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  resetWorkspace: vi.fn(),
  selectWorkspace: vi.fn(),
}))

const mockedListWorkspaces = vi.mocked(listWorkspaces)
const mockedLogout = vi.mocked(logout)

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mount(component: Component): Promise<HTMLDivElement> {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(component)
  app.component('RouterLink', { template: '<a><slot /></a>' })
  app.mount(root)
  await flush()
  return root
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  root = undefined
  vi.resetAllMocks()
})

beforeEach(() => {
  authSession.ready = true
  authSession.user = { id: 'u1', name: '测试用户', email: 'test@example.com', role: 'recruiter', departmentId: 'd1' }
  authSession.method = 'session'
  authSession.sessionId = 'session-1'
  authSession.loading = false
  authSession.workspaces = []
  route.query = {}
  mockedListWorkspaces.mockResolvedValue([])
  mockedLogout.mockResolvedValue({ ok: true })
  routerReplace.mockResolvedValue(undefined)
})

describe('WorkspacePage 返回登录', () => {
  it.each(['owner', 'admin', 'member'] as const)('%s 工作空间只显示查看权益和进入两个操作', async role => {
    authSession.user!.workspaceId = 'w1'
    mockedListWorkspaces.mockResolvedValue([{ id: 'w1', name: '企业', kind: 'test', status: 'active', role, createdAt: '2026-10-01T00:00:00Z', serviceStatus: 'enabled', serviceAvailable: true }])
    const mountedRoot = await mount(WorkspacePage)
    const actions = mountedRoot.querySelector('.workspace-row-actions')!
    expect(Array.from(actions.querySelectorAll('button')).map(button => button.textContent)).toEqual(['查看套餐权益', '进入企业'])
    expect(actions.querySelectorAll('a')).toHaveLength(0)
    expect(mountedRoot.textContent).not.toContain('成员与邀请')
    expect(mountedRoot.textContent).not.toContain('重新开始')
    expect(mountedRoot.querySelector('.danger')).toBeNull()
    actions.querySelector<HTMLButtonElement>('.workspace-open')!.click()
    await flush()
    expect(routerPush).toHaveBeenCalledWith('/')
  })

  it('到期企业仅保留权益查看及不可用的进入按钮', async () => {
    mockedListWorkspaces.mockResolvedValue([{ id: 'w1', name: '到期企业', kind: 'test', status: 'active', role: 'member', createdAt: '2026-10-01T00:00:00Z', serviceStatus: 'enabled', serviceAvailable: false }])
    const mountedRoot = await mount(WorkspacePage)
    expect(mountedRoot.textContent).not.toContain('购买 / 续费套餐')
    expect(mountedRoot.querySelector<HTMLButtonElement>('.workspace-open')?.disabled).toBe(true)
    expect(mountedRoot.textContent).toContain('套餐权益')
    expect(mountedRoot.textContent).not.toContain('成员与邀请')
    expect(mountedRoot.textContent).not.toContain('重新开始')
    expect(mountedRoot.querySelector('.danger')).toBeNull()
  })
  it('清除当前登录状态并跳转到登录页', async () => {
    const mountedRoot = await mount(WorkspacePage)
    const button = mountedRoot.querySelector<HTMLButtonElement>('.workspace-logout')
    expect(button?.textContent).toContain('返回登录')

    button?.click()
    await flush()

    expect(mockedLogout).toHaveBeenCalledWith('session-1')
    expect(authSession.user).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith({ name: 'login', query: {} })
  })

  it('退出接口失败时仍跳转登录，并在登录页展示提示', async () => {
    mockedLogout.mockRejectedValueOnce(new Error('network unavailable'))
    const mountedRoot = await mount(WorkspacePage)

    mountedRoot.querySelector<HTMLButtonElement>('.workspace-logout')?.click()
    await flush()

    expect(authSession.user).toBeNull()
    expect(routerReplace).toHaveBeenCalledWith({ name: 'login', query: { logoutError: '1' } })

    app?.unmount()
    app = undefined
    route.query = { logoutError: '1' }
    app = createApp(LoginPage)
    app.component('router-link', { template: '<a><slot /></a>' })
    app.mount(mountedRoot)
    await flush()
    expect(mountedRoot.querySelector('[role="alert"]')?.textContent).toContain('退出请求未能完成')
  })
})
