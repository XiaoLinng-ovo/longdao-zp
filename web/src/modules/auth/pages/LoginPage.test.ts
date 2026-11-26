// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import LoginPage from './LoginPage.vue'
import { authSession, loginWithEmail, switchWorkspace } from '../session'
import type { WorkspaceSummary } from '../api'

const { route, push, replace, session } = vi.hoisted(() => ({
  route: { query: {} as Record<string, string> },
  push: vi.fn(),
  replace: vi.fn(),
  session: { ready: true, user: null as null | { workspaceId?: string; platformRole?: 'admin' | 'viewer'; isSystemAdmin?: boolean }, loading: false },
}))
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push, replace }) }))
vi.mock('../session', () => ({
  authSession: session,
  loginWithEmail: vi.fn(),
  refreshAuthSession: vi.fn(),
  switchWorkspace: vi.fn(),
}))

let app: App | undefined
let root: HTMLDivElement | undefined
let compact = false
let layoutListener: (() => void) | undefined
const removeListener = vi.fn()

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}
async function mount() {
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(LoginPage)
  app.component('router-link', { props: ['to'], template: '<a :data-to="JSON.stringify(to)"><slot /></a>' })
  app.mount(root)
  await flush()
  return root
}

async function submitCredentials(element: HTMLElement) {
  const email = element.querySelector<HTMLInputElement>('#login-email')!
  const password = element.querySelector<HTMLInputElement>('#login-password')!
  email.value = 'member@example.test'
  email.dispatchEvent(new Event('input'))
  password.value = 'isolated-test-password'
  password.dispatchEvent(new Event('input'))
  element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

const usableWorkspace: WorkspaceSummary = { id: 'workspace-1', name: '可用企业', kind: 'test', status: 'active', role: 'member', createdAt: '2026-11-10' }

function loginWithWorkspaces(workspaces: WorkspaceSummary[], workspaceId?: string) {
  vi.mocked(loginWithEmail).mockImplementation(async () => {
    const user = { id: 'member', name: '企业用户', email: 'member@example.test', role: 'recruiter' as const, departmentId: '', ...(workspaceId ? { workspaceId } : {}) }
    session.user = user
    return { kind: 'authenticated', user, sessionId: 'test', expiresAt: '', workspaces }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  compact = false
  layoutListener = undefined
  route.query = {}
  session.user = null
  vi.mocked(loginWithEmail).mockResolvedValue({
    kind: 'authenticated',
    user: { id: 'user-1', name: '招聘专员', email: 'recruiter@example.com', role: 'recruiter', departmentId: 'dept-tech' },
    sessionId: 'session-1',
    expiresAt: '2026-11-04T00:00:00Z',
    workspaces: [],
  })
  vi.mocked(switchWorkspace).mockResolvedValue()
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    get matches() { return compact },
    addEventListener: (_event: string, listener: () => void) => { layoutListener = listener },
    removeEventListener: removeListener,
  })))
})
afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  root = undefined
  vi.unstubAllGlobals()
})

describe('登录页教程布局', () => {
  it('账号入口集中在表单顶部，保留注册目标和加入企业入口', async () => {
    route.query = { redirect: '/offers?status=pending' }
    const element = await mount()
    const nav = element.querySelector('.auth-entry-nav')!
    expect(nav.textContent).toContain('登录账号')
    expect(nav.textContent).toContain('注册账号')
    expect(nav.textContent).toContain('加入企业')
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe('登录账号')
    expect(JSON.parse(nav.querySelector('.register-entry')!.getAttribute('data-to')!)).toEqual({ name: 'register', query: { redirect: '/offers?status=pending' } })
    expect(nav.querySelector('.workspace-invite-entry')?.getAttribute('aria-expanded')).toBe('false')
    expect(nav.nextElementSibling?.className).toBe('form-grid')
    expect(element.querySelector('.login-links')?.nextElementSibling?.className).toBe('login-actions')
    expect(element.querySelector('.login-actions button')?.textContent).toBe('登录')
  })

  it('点击加入企业立即展开邀请码输入，登录后保留邀请目标', async () => {
    loginWithWorkspaces([usableWorkspace], 'workspace-1')
    const element = await mount()
    element.querySelector<HTMLButtonElement>('.workspace-invite-entry')!.click()
    await flush()
    expect(push).not.toHaveBeenCalled()
    expect(element.querySelector('.workspace-invite-entry')?.getAttribute('aria-current')).toBe('page')
    const input = element.querySelector<HTMLInputElement>('#login-invite-code')!
    expect(input).not.toBeNull()
    input.value = 'https://example.test/workspaces?invite=abcdef012345abcdef012345'
    input.dispatchEvent(new Event('input'))
    await flush()
    const redirect = '/workspaces?join=1&invite=ABCDEF012345ABCDEF012345'
    expect(JSON.parse(element.querySelector('.register-entry')!.getAttribute('data-to')!)).toEqual({ name: 'register', query: { redirect } })
    await submitCredentials(element)
    expect(push).toHaveBeenCalledWith(redirect)
  })

  it('加入企业未填邀请码也能先登录，且可切回普通登录', async () => {
    const element = await mount()
    element.querySelector<HTMLButtonElement>('.workspace-invite-entry')!.click()
    await flush()
    await submitCredentials(element)
    expect(push).toHaveBeenCalledWith('/workspaces?join=1')
    element.querySelector<HTMLButtonElement>('.auth-entry')!.click()
    await flush()
    expect(element.querySelector('#login-invite-code')).toBeNull()
  })

  it('邀请码不完整时显示错误，不发送登录请求', async () => {
    const element = await mount()
    element.querySelector<HTMLButtonElement>('.workspace-invite-entry')!.click()
    await flush()
    const input = element.querySelector<HTMLInputElement>('#login-invite-code')!
    input.value = 'invalid'
    input.dispatchEvent(new Event('input'))
    await submitCredentials(element)
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('24 位邀请码')
    expect(loginWithEmail).not.toHaveBeenCalled()
  })

  it('密码可显示和隐藏，切换时不清空输入或提交表单', async () => {
    const element = await mount()
    const password = element.querySelector<HTMLInputElement>('#login-password')!
    const toggle = element.querySelector<HTMLButtonElement>('.password-toggle')!
    password.value = 'example-password'
    password.dispatchEvent(new Event('input'))
    toggle.click()
    await flush()
    expect(password.type).toBe('text')
    expect(password.value).toBe('example-password')
    expect(toggle.getAttribute('aria-label')).toBe('隐藏密码')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    toggle.click()
    await flush()
    expect(password.type).toBe('password')
    expect(toggle.getAttribute('aria-label')).toBe('显示密码')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(loginWithEmail).not.toHaveBeenCalled()
  })

  it('自动进入唯一绑定的可用企业，保留模块目标', async () => {
    route.query = { redirect: '/jobs?status=active' }
    loginWithWorkspaces([usableWorkspace])
    vi.mocked(switchWorkspace).mockImplementation(async id => { session.user = { workspaceId: id } })
    await submitCredentials(await mount())
    expect(switchWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(push).toHaveBeenCalledWith('/jobs?status=active')
  })
  it('所有企业都不可用时进入企业管理，不尝试选择已暂停企业', async () => {
    loginWithWorkspaces([{ ...usableWorkspace, serviceStatus: 'suspended', serviceAvailable: false }])
    await submitCredentials(await mount())
    expect(switchWorkspace).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/workspaces')
  })
  it.each([undefined,'workspace-1'])('历史多企业绑定不能继续选择或使用旧当前企业 %s',async current=>{
    route.query={redirect:'/interviews'}
    loginWithWorkspaces([usableWorkspace,{...usableWorkspace,id:'workspace-2'}],current)
    const element=await mount();await submitCredentials(element)
    expect(push).not.toHaveBeenCalled()
    expect(switchWorkspace).not.toHaveBeenCalled()
    expect(element.querySelector('.workspace-choice')).toBeNull()
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('多个企业绑定')
  })
  it('不展示企业职位绑定和回车登录的辅助说明', async () => {
    const element = await mount()
    expect(element.textContent).not.toContain('账号先绑定企业，登录后再按权限选择职位，不在登录时固定到某一个职位。')
    expect(element.textContent).not.toContain('填写完成后按 Enter 即可登录')
    expect(element.querySelector('.enter-hint')).toBeNull()
    expect(element.querySelector<HTMLButtonElement>('.login-actions button')?.type).toBe('submit')
  })

  it('只提示输入邮箱和密码，不展示具体测试账号', async () => {
    const element = await mount()
    expect(element.querySelector('.dev-account')).toBeNull()
    expect(element.textContent).not.toContain('开发环境测试账号')
    expect(element.textContent).not.toContain('填入测试账号')
    const email = element.querySelector<HTMLInputElement>('#login-email')!
    const password = element.querySelector<HTMLInputElement>('#login-password')!
    expect(email.placeholder).toBe('请输入邮箱')
    expect(password.placeholder).toBe('请输入密码')
    expect(element.innerHTML).not.toContain('recruiter@smartrecruit.local')
    expect(element.innerHTML).not.toContain('recruiter123')
  })

  it('桌面教程在介绍区下方，重要操作仍在登录卡片内', async () => {
    const element = await mount()
    const guide = element.querySelector<HTMLDetailsElement>('.workspace-onboarding')!
    expect(guide.closest('.login-story')).not.toBeNull()
    expect(guide.previousElementSibling?.className).toBe('login-intro')
    expect(guide.open).toBe(true)
    expect(element.querySelector('.login-panel .workspace-onboarding')).toBeNull()
    expect(element.querySelector('.login-panel #login-email')).not.toBeNull()
    expect(element.querySelector('.login-panel #login-password')).not.toBeNull()
    expect(element.querySelector('.login-panel .workspace-invite-entry')?.textContent).toContain('加入企业')
    expect(element.querySelectorAll('.workspace-step')).toHaveLength(3)
  })

  it('手机教程默认折叠，可点击展开和收起', async () => {
    compact = true
    const element = await mount()
    const guide = element.querySelector<HTMLDetailsElement>('.workspace-onboarding')!
    const summary = guide.querySelector('summary')!
    expect(guide.open).toBe(false)
    summary.click()
    guide.dispatchEvent(new Event('toggle'))
    await flush()
    expect(guide.open).toBe(true)
    summary.click()
    guide.dispatchEvent(new Event('toggle'))
    await flush()
    expect(guide.open).toBe(false)
  })

  it('跨过窄屏断点时同步默认展开状态，并清理监听器', async () => {
    const element = await mount()
    const guide = element.querySelector<HTMLDetailsElement>('.workspace-onboarding')!
    const listener = layoutListener
    compact = true
    listener?.()
    await flush()
    expect(guide.open).toBe(false)
    compact = false
    listener?.()
    await flush()
    expect(guide.open).toBe(true)
    app?.unmount()
    app = undefined
    expect(removeListener).toHaveBeenCalledWith('change', listener)
  })

  it('保留邀请码登录后的目标地址', async () => {
    route.query = { redirect: '/workspaces?join=1&invite=ABCDEF012345ABCDEF012345' }
    const element = await mount()
    const email = element.querySelector<HTMLInputElement>('#login-email')!
    const password = element.querySelector<HTMLInputElement>('#login-password')!
    email.value = 'member@example.com'
    email.dispatchEvent(new Event('input'))
    password.value = 'test-password'
    password.dispatchEvent(new Event('input'))
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(loginWithEmail).toHaveBeenCalledWith('member@example.com', 'test-password')
    expect(push).toHaveBeenCalledWith(route.query.redirect)
  })

  it('只有一个未选择的工作空间时自动进入系统', async () => {
    vi.mocked(loginWithEmail).mockResolvedValue({
      kind: 'authenticated',
      user: { id: 'admin-1', name: '系统管理员', email: 'admin@smartrecruit.local', role: 'admin', departmentId: 'dept-tech' },
      sessionId: 'session-admin',
      expiresAt: '2026-11-05T00:00:00Z',
      workspaces: [{ id: 'workspace-1', name: '龙道测试企业', kind: 'test', status: 'active', role: 'owner', createdAt: '2026-11-05' }],
    })
    const element = await mount()
    const email = element.querySelector<HTMLInputElement>('#login-email')!
    const password = element.querySelector<HTMLInputElement>('#login-password')!
    email.value = 'admin@smartrecruit.local'
    email.dispatchEvent(new Event('input'))
    password.value = 'test-password'
    password.dispatchEvent(new Event('input'))
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(switchWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(push).toHaveBeenCalledWith('/')
    expect(element.querySelector('.workspace-choice')).toBeNull()
  })

  it('没有企业工作空间的唯一系统管理员直接进入企业客户管理', async () => {
    const response = {
      kind: 'authenticated' as const,
      user: { id: 'platform-admin-1', name: '平台管理员', email: 'platform-admin@example.test', role: 'admin' as const, departmentId: 'dept-hr', isSystemAdmin: true },
      sessionId: 'session-platform-admin',
      expiresAt: '2026-11-05T00:00:00Z',
      workspaces: [],
    }
    vi.mocked(loginWithEmail).mockImplementation(async () => {
      session.user = response.user
      return response
    })
    const element = await mount()
    const email = element.querySelector<HTMLInputElement>('#login-email')!
    const password = element.querySelector<HTMLInputElement>('#login-password')!
    email.value = 'platform-admin@example.test'
    email.dispatchEvent(new Event('input'))
    password.value = 'test-password'
    password.dispatchEvent(new Event('input'))
    element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(switchWorkspace).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/platform/customers')
  })

  it('已有会话进入登录页时保留邀请跳转', async () => {
    session.user = { workspaceId: 'workspace-1' }
    route.query = { redirect: '/workspaces?join=1' }
    await mount()
    expect(push).toHaveBeenCalledWith(route.query.redirect)
    expect(authSession.user?.workspaceId).toBe('workspace-1')
  })

  it('密码重置提示只展示一次，并从地址中清除 reset 参数', async () => {
    route.query = { reset: '1', redirect: '/offers' }

    const element = await mount()

    expect(element.textContent).toContain('密码已重置，请使用新密码登录。')
    expect(replace).toHaveBeenCalledWith({ name: 'login', query: { redirect: '/offers' } })
  })
})
