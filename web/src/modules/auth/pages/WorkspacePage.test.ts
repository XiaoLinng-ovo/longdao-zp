// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App, type Component } from 'vue'
import WorkspacePage from './WorkspacePage.vue'
import LoginPage from './LoginPage.vue'
import { authSession } from '../session'
import { listWorkspaces, logout } from '../api'

const { routerReplace, route } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
  route: { query: {} as Record<string, unknown> },
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => route,
    useRouter: () => ({ replace: routerReplace }),
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
  app.component('router-link', { template: '<a><slot /></a>' })
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
