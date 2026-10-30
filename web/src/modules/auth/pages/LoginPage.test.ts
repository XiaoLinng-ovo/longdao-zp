// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import LoginPage from './LoginPage.vue'
import { authSession, loginWithEmail } from '../session'

const { route, push, session } = vi.hoisted(() => ({
  route: { query: {} as Record<string, string> },
  push: vi.fn(),
  session: { ready: true, user: null as null | { workspaceId: string }, loading: false },
}))
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push }) }))
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
  app.component('router-link', { props: ['to'], template: '<a><slot /></a>' })
  app.mount(root)
  await flush()
  return root
}

beforeEach(() => {
  vi.clearAllMocks()
  compact = false
  layoutListener = undefined
  route.query = {}
  session.user = null
  vi.mocked(loginWithEmail).mockResolvedValue([])
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
  it('不展示企业职位绑定和回车登录的辅助说明', async () => {
    const element = await mount()
    expect(element.textContent).not.toContain('账号先绑定企业，登录后再按权限选择职位，不在登录时固定到某一个职位。')
    expect(element.textContent).not.toContain('填写完成后按 Enter 即可登录')
    expect(element.querySelector('.enter-hint')).toBeNull()
    expect(element.querySelector<HTMLButtonElement>('.login-actions button')?.type).toBe('submit')
  })

  it('不展示开发测试账号说明或快捷填入按钮', async () => {
    const element = await mount()
    expect(element.querySelector('.dev-account')).toBeNull()
    expect(element.textContent).not.toContain('开发环境测试账号')
    expect(element.textContent).not.toContain('填入测试账号')
    expect(element.textContent).not.toContain('recruiter@smartrecruit.local / recruiter123')
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
    route.query = { redirect: '/workspaces?join=1&invite=example' }
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

  it('已有会话进入登录页时保留邀请跳转', async () => {
    session.user = { workspaceId: 'workspace-1' }
    route.query = { redirect: '/workspaces?join=1' }
    await mount()
    expect(push).toHaveBeenCalledWith(route.query.redirect)
    expect(authSession.user?.workspaceId).toBe('workspace-1')
  })
})
