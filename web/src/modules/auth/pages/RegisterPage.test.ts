// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import RegisterPage from './RegisterPage.vue'

const mocks = vi.hoisted(() => ({
  route: { query: {} as Record<string, string> },
  push: vi.fn(),
  requestRegistrationCode: vi.fn(),
  register: vi.fn(),
  getSecurityConfig: vi.fn(),
  syncAuthenticatedSession: vi.fn(),
  switchWorkspace: vi.fn(),
  getInvitationSummary: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ push: mocks.push }),
}))
vi.mock('../api/invitations', () => ({ getInvitationSummary:mocks.getInvitationSummary }))
vi.mock('../api', () => ({
  getSecurityConfig: mocks.getSecurityConfig,
  register: mocks.register,
  requestRegistrationCode: mocks.requestRegistrationCode,
}))
vi.mock('../session', () => ({
  syncAuthenticatedSession: mocks.syncAuthenticatedSession,
  switchWorkspace: mocks.switchWorkspace,
}))
vi.mock('../components/TurnstileWidget.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: ['siteKey', 'action', 'resetKey', 'modelValue'],
      emits: ['update:modelValue', 'error'],
      setup(props, { emit }) {
        return () => h('button', {
          class: 'turnstile-stub',
          'data-action': props.action,
          type: 'button',
          onClick: () => emit('update:modelValue', `${props.action}-token`),
        }, props.action)
      },
    }),
  }
})

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mount(turnstileEnabled = false) {
  mocks.getSecurityConfig.mockResolvedValue({
    turnstileEnabled,
    turnstileSiteKey: turnstileEnabled ? 'site-key' : '',
    adminMfaRequired: false,
  })
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(RegisterPage)
  app.component('router-link', { props: ['to'], template: '<a><slot /></a>' })
  app.mount(root)
  await flush()
  return root
}

async function fillAccount(email = 'owner@example.com') {
  const values = ['龙道科技', '陈婉清', email, '13800000000', 'strong-password', 'strong-password']
  const inputs = [...root!.querySelectorAll<HTMLInputElement>('form input')]
  inputs.forEach((input, index) => {
    input.value = values[index] ?? ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await nextTick()
}

async function submitForm() {
  root!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.route.query = {}
  mocks.getInvitationSummary.mockResolvedValue({workspaceName:'受邀企业',expiresAt:'2099-01-01',shared:true})
  mocks.requestRegistrationCode.mockResolvedValue({ accepted: true, retryAfterSeconds: 60 })
  mocks.register.mockResolvedValue({
    user: { id: 'user-1', name: '陈婉清', email: 'owner@example.com', role: 'recruiter', departmentId: '' },
    sessionId: 'session-1',
    expiresAt: '2026-11-04T00:00:00Z',
    workspace: { id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-11-04' },
    workspaces: [{ id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-11-04' }],
  })
  mocks.syncAuthenticatedSession.mockReturnValue([{
    id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-11-04',
  }])
})

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  root = undefined
  vi.useRealTimers()
})

describe('注册页两步验证', () => {
  it('受邀注册不填写企业名称，验证后绑定现有企业', async () => {
    mocks.route.query={invite:'ABCDEF123456ABCDEF123456'}
    const element=await mount()
    expect(element.querySelector('input[autocomplete=organization]')).toBeNull()
    expect(element.textContent).toContain('受邀企业')
    const values=['受邀成员','member@example.com','','strong-password','strong-password']
    element.querySelectorAll<HTMLInputElement>('form input').forEach((input,index)=>{input.value=values[index]??'';input.dispatchEvent(new Event('input'))})
    await submitForm()
    const codeInput=element.querySelector<HTMLInputElement>('input[autocomplete=one-time-code]')!
    codeInput.value='123456';codeInput.dispatchEvent(new Event('input'))
    mocks.switchWorkspace.mockRejectedValueOnce(new Error('切换重试'))
    await submitForm()
    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({companyName:'',invitationCode:'ABCDEF123456ABCDEF123456'}))
    expect(mocks.push).toHaveBeenCalledWith({name:'invitation-join',query:{invite:'ABCDEF123456ABCDEF123456'}})
  })
  it('无效邀请不能退回创建企业流程或发送验证码', async () => {
    mocks.route.query={invite:'INVALID'}
    mocks.getInvitationSummary.mockRejectedValueOnce(new Error('邀请码已过期'))
    const element=await mount()
    expect(element.querySelector('input[autocomplete=organization]')).toBeNull()
    expect(element.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(true)
    await submitForm()
    expect(mocks.requestRegistrationCode).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
  })
  it('从旧邀请登录页进入注册也保留邀请码', async () => {
    mocks.route.query={redirect:'/workspaces?invite=ABCDEF123456ABCDEF123456'}
    const element=await mount()
    expect(mocks.getInvitationSummary).toHaveBeenCalledWith('ABCDEF123456ABCDEF123456')
    expect(element.querySelector('input[autocomplete=organization]')).toBeNull()
  })
  it('验证码发送成功后才进入第二步', async () => {
    const element = await mount()
    expect(element.textContent).toContain('步骤 1 / 2')
    expect(element.querySelector('h1')?.textContent).toBe('创建企业账号')
    expect(element.textContent).not.toContain('管理员')
    await fillAccount()
    await submitForm()

    expect(mocks.requestRegistrationCode).toHaveBeenCalledWith('owner@example.com', undefined)
    expect(mocks.register).not.toHaveBeenCalled()
    expect(element.textContent).toContain('步骤 2 / 2')
    expect(element.querySelector('h1')?.textContent).toBe('验证你的邮箱')
  })

  it('冷却后可重发，修改邮箱后验证码会发送到新地址', async () => {
    vi.useFakeTimers()
    const element = await mount()
    await fillAccount('first@example.com')
    await submitForm()

    vi.advanceTimersByTime(60_000)
    await nextTick()
    element.querySelector<HTMLButtonElement>('.resend-code')!.click()
    await flush()
    expect(mocks.requestRegistrationCode).toHaveBeenLastCalledWith('first@example.com', undefined)
    expect(element.textContent).toContain('新的验证码已发送')

    element.querySelector<HTMLButtonElement>('.register-account-summary button')!.click()
    await nextTick()
    vi.advanceTimersByTime(60_000)
    await nextTick()
    await fillAccount('second@example.com')
    await submitForm()
    expect(mocks.requestRegistrationCode).toHaveBeenLastCalledWith('second@example.com', undefined)
  })

  it('未填写验证码时不会调用注册接口', async () => {
    const element = await mount()
    await fillAccount()
    await submitForm()
    await submitForm()

    expect(element.textContent).toContain('请输入 6 位邮箱验证码')
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('发送和确认阶段分别携带独立的 Turnstile token', async () => {
    const element = await mount(true)
    await fillAccount()
    element.querySelector<HTMLButtonElement>('.turnstile-stub[data-action="register-code"]')!.click()
    await nextTick()
    await submitForm()

    expect(mocks.requestRegistrationCode).toHaveBeenCalledWith('owner@example.com', 'register-code-token')
    element.querySelector<HTMLButtonElement>('.turnstile-stub[data-action="register-confirm"]')!.click()
    const codeInput = element.querySelector<HTMLInputElement>('.register-code-form input')!
    codeInput.value = '123456'
    codeInput.dispatchEvent(new Event('input', { bubbles: true }))
    await submitForm()

    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({
      email: 'owner@example.com',
      verificationCode: '123456',
      turnstileToken: 'register-confirm-token',
    }))
  })
})
