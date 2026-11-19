// @vitest-environment jsdom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProfilePage from './ProfilePage.vue'
import { authSession, saveCurrentUserProfile } from '../session'

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  saveCurrentUserProfile: vi.fn(),
  replace: vi.fn(),
  requestEmailChangeCode: vi.fn(),
  confirmEmailChange: vi.fn(),
  changePassword: vi.fn(),
  requestAccountPasswordCode: vi.fn(),
  verifyAccountPasswordCode: vi.fn(),
  changePasswordWithCode: vi.fn(),
  clearCredentialChangeSession: vi.fn(),
}))

vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }))
vi.mock('../api', () => ({
  requestEmailChangeCode: mocks.requestEmailChangeCode,
  confirmEmailChange: mocks.confirmEmailChange,
  changePassword: mocks.changePassword,
  requestAccountPasswordCode: mocks.requestAccountPasswordCode,
  verifyAccountPasswordCode: mocks.verifyAccountPasswordCode,
  changePasswordWithCode: mocks.changePasswordWithCode,
}))
vi.mock('../session', () => ({
  authSession: {
    ready: true,
    loading: false,
    method: 'session',
    sessionId: 'session-1',
    user: {
      id: 'user-1',
      name: '陈婉清',
      email: 'owner@example.com',
      phone: '13800000000',
      role: 'recruiter',
      departmentId: 'dept-hr',
      workspaceId: 'workspace-1',
      workspaceName: '龙道科技',
      workspaceKind: 'production',
      platformRole: 'viewer',
    },
    workspaces: [{ id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-26' }],
  },
  saveCurrentUserProfile: mocks.saveCurrentUserProfile,
  clearCredentialChangeSession: mocks.clearCredentialChangeSession,
}))

let app: App
let root: HTMLDivElement

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function input(selector: string): HTMLInputElement {
  return root.querySelector<HTMLInputElement>(selector)!
}

function setInputValue(element: HTMLInputElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  vi.clearAllMocks()
  authSession.sessionId = 'session-1'
  authSession.user = {
    id: 'user-1',
    name: '陈婉清',
    email: 'owner@example.com',
    phone: '13800000000',
    role: 'recruiter',
    departmentId: 'dept-hr',
    workspaceId: 'workspace-1',
    workspaceName: '龙道科技',
    workspaceKind: 'production',
    platformRole: 'viewer',
  }
  authSession.workspaces = [{ id: 'workspace-1', name: '龙道科技', kind: 'production', status: 'active', role: 'owner', createdAt: '2026-10-26' }]
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(ProfilePage)
  app.mount(root)
})

afterEach(() => {
  app.unmount()
  root.remove()
  vi.useRealTimers()
})

describe('profile page', () => {
  it('shows editable contact fields and read-only account and workspace facts', async () => {
    await flush()

    expect(input('input[autocomplete="name"]').value).toBe('陈婉清')
    expect(input('input[autocomplete="tel"]').value).toBe('13800000000')
    expect(root.textContent).toContain('owner@example.com')
    expect(root.textContent).toContain('龙道科技')
    expect(root.textContent).toContain('企业所有者')
    expect(root.textContent).toContain('企业用户')
    expect(root.textContent).toContain('平台只读运营')
    expect(root.querySelectorAll('.profile-facts input')).toHaveLength(0)
  })

  it('saves edited contact details and leaves the page on screen', async () => {
    await flush()
    mocks.saveCurrentUserProfile.mockImplementation(async (updates: { name: string; phone: string }) => {
      authSession.user = { ...authSession.user!, ...updates }
      return authSession.user
    })

    setInputValue(input('input[autocomplete="name"]'), '陈婉清（更新）')
    setInputValue(input('input[autocomplete="tel"]'), '13900000000')
    await flush()
    root.querySelector<HTMLButtonElement>('.profile-save')!.click()
    await flush()

    expect(saveCurrentUserProfile).toHaveBeenCalledWith({ name: '陈婉清（更新）', phone: '13900000000' })
    expect(root.querySelector('[role="status"]')?.textContent).toContain('个人信息已更新')
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('prevents saving a blank name and returns to workspace selection when no enterprise is active', async () => {
    await flush()
    setInputValue(input('input[autocomplete="name"]'), '   ')
    await flush()
    expect(root.querySelector<HTMLButtonElement>('.profile-save')?.disabled).toBe(true)

    authSession.user = { ...authSession.user!, workspaceId: undefined, workspaceName: undefined, workspaceKind: undefined }
    await flush()
    root.querySelector<HTMLButtonElement>('.profile-back')!.click()
    await flush()
    expect(mocks.push).toHaveBeenCalledWith('/workspaces')
  })

  async function open(kind: 'email' | 'password') {
    Array.from(root.querySelectorAll('button')).find(b => b.textContent?.includes(kind === 'email' ? '更换邮箱' : '修改密码'))!.click()
    await flush()
    return document.querySelector<HTMLDialogElement>('dialog')!
  }
  async function submit(dialog: HTMLDialogElement) {
    dialog.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
  }
  it('blocks duplicate requests and ignores results from a previous session', async () => {
    let resolve!: (value: { accepted: true; retryAfterSeconds: number }) => void
    mocks.requestAccountPasswordCode.mockReturnValue(new Promise(r => { resolve = r }))
    const dialog = await open('password')
    await submit(dialog)
    await submit(dialog)
    expect(mocks.requestAccountPasswordCode).toHaveBeenCalledTimes(1)
    expect(dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    authSession.sessionId = 'another-session'
    resolve({ accepted: true, retryAfterSeconds: 60 })
    await flush()
    expect(document.querySelector('dialog')).toBeNull()
    expect(mocks.changePasswordWithCode).not.toHaveBeenCalled()
  })
  it('supports cancellation without credential mutations', async () => {
    const dialog = await open('email')
    expect(root.querySelector('.profile-security-fact')?.textContent).toContain('owner@example.com')
    expect(dialog.querySelector('input[type="password"]')).toBeNull()
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
    await flush()
    expect(document.querySelector('dialog')).toBeNull()
    expect(mocks.confirmEmailChange).not.toHaveBeenCalled()
  })
  it('requires new email verification and shows success before relogin', async () => {
    const dialog = await open('email')
    mocks.requestEmailChangeCode.mockResolvedValue({ accepted: true, retryAfterSeconds: 60 })
    setInputValue(dialog.querySelector('input')!, 'new@example.invalid')
    await submit(dialog)
    expect(mocks.requestEmailChangeCode).toHaveBeenCalledWith('new@example.invalid')
    expect(dialog.textContent).toContain('验证码已发送至 new@example.invalid')
    expect(dialog.querySelector<HTMLButtonElement>('.text-button')!.disabled).toBe(true)
    setInputValue(dialog.querySelector('input')!, '123456')
    mocks.confirmEmailChange.mockRejectedValueOnce(new Error('验证码无效'))
    await submit(dialog)
    expect(authSession.user?.email).toBe('owner@example.com')
    expect(dialog.querySelector('[role="alert"]')).not.toBeNull()
    mocks.confirmEmailChange.mockResolvedValue({ ok: true })
    await submit(dialog)
    expect(mocks.confirmEmailChange).toHaveBeenLastCalledWith('new@example.invalid', undefined, '123456')
    expect(authSession.user?.email).toBe('new@example.invalid')
    expect(mocks.clearCredentialChangeSession).toHaveBeenCalledOnce()
    expect(dialog.textContent).toContain('更换邮箱成功')
    expect(dialog.querySelector('input')).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
    dialog.querySelector<HTMLButtonElement>('.success button')!.click()
    await flush()
    expect(mocks.replace).toHaveBeenCalledWith({ name: 'login', query: { credentials: 'email' } })
  })
  it('resends after cooldown and supports returning to the email step', async () => {
    vi.useFakeTimers()
    const dialog = await open('email')
    mocks.requestEmailChangeCode.mockResolvedValue({ accepted: true, retryAfterSeconds: 1 })
    setInputValue(dialog.querySelector('input')!, 'new@example.invalid')
    await submit(dialog)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    dialog.querySelector<HTMLButtonElement>('.text-button')!.click()
    await flush()
    expect(mocks.requestEmailChangeCode).toHaveBeenCalledTimes(2)
    dialog.querySelector<HTMLButtonElement>('.secondary')!.click()
    await flush()
    expect(dialog.querySelector<HTMLInputElement>('input[type="email"]')!.value).toBe('new@example.invalid')
    expect(dialog.querySelector('input[autocomplete="one-time-code"]')).toBeNull()
  })
  it('verifies password OTP before showing new password inputs', async () => {
    const dialog = await open('password')
    expect(dialog.textContent).toContain('owner@example.com')
    expect(dialog.querySelector('input')).toBeNull()
    mocks.requestAccountPasswordCode.mockResolvedValue({ accepted: true, retryAfterSeconds: 60 })
    await submit(dialog)
    expect(mocks.requestAccountPasswordCode).toHaveBeenCalledWith()
    setInputValue(dialog.querySelector('input')!, '123456')
    mocks.verifyAccountPasswordCode.mockRejectedValueOnce(new Error('错误验证码'))
    await submit(dialog)
    expect(dialog.querySelector('input[type="password"]')).toBeNull()
    mocks.verifyAccountPasswordCode.mockResolvedValue({ ok: true })
    await submit(dialog)
    expect(mocks.verifyAccountPasswordCode).toHaveBeenLastCalledWith('123456')
    const fields = dialog.querySelectorAll<HTMLInputElement>('input[type="password"]')
    expect(fields).toHaveLength(2)
    setInputValue(fields[0]!, 'new-password-test')
    setInputValue(fields[1]!, 'different-password')
    await submit(dialog)
    expect(dialog.textContent).toContain('两次输入的新密码不一致')
    expect(mocks.changePasswordWithCode).not.toHaveBeenCalled()
    setInputValue(fields[1]!, 'new-password-test')
    mocks.changePasswordWithCode.mockResolvedValue({ ok: true })
    await submit(dialog)
    expect(mocks.changePasswordWithCode).toHaveBeenCalledWith('123456', 'new-password-test')
    expect(mocks.clearCredentialChangeSession).toHaveBeenCalledOnce()
    expect(dialog.textContent).toContain('修改密码成功')
    dialog.querySelector<HTMLButtonElement>('.success button')!.click()
    await flush()
    expect(mocks.replace).toHaveBeenCalledWith({ name: 'login', query: { credentials: 'password' } })
  })
})
