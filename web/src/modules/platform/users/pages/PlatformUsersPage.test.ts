// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlatformUsersPage from './PlatformUsersPage.vue'
import { authSession } from '../../../auth/session'
import { getPlatformUser, listPlatformUsers, updatePlatformUserStatus, updatePlatformWorkspaceAiAccess, type PlatformUserDetail, type PlatformUserListItem } from '../api'

vi.mock('../api', () => ({
  getPlatformUser: vi.fn(),
  listPlatformUsers: vi.fn(),
  updatePlatformUserStatus: vi.fn(),
  updatePlatformWorkspaceAiAccess: vi.fn(),
  updatePlatformUserProfile: vi.fn(),
  revokePlatformUserSessions: vi.fn(),
  resetPlatformUserPassword: vi.fn(),
}))
vi.mock('../../../auth/session', () => ({ authSession: { user: { platformRole: 'admin', workspaceId: 'source-enterprise' }, workspaces: [{ id: 'source-enterprise', name: '平台运营企业' }] } }))

const account: PlatformUserListItem = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: '陈婉清',
  email: 'chen@example.com',
  phoneMasked: '+86****0926',
  isActive: true,
  platformRole: null,
  registrationSource: 'open_registration',
  createdAt: '2026-10-26T01:00:00.000Z',
  lastLoginAt: '2026-10-26T02:00:00.000Z',
  workspaceCount: 1,
  primaryWorkspace: {
    id: '22222222-2222-4222-8222-222222222222',
    name: '龙道科技',
    kind: 'production',
    status: 'active',
    serviceStatus: 'trial',
    usePlatformAi: false,
    platformAiAccessReady: true,
    membershipRole: 'owner',
    businessRole: 'recruiter',
  },
}

const detail: PlatformUserDetail = {
  user: {
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    phone: '+8613800000926',
    isActive: true,
    platformRole: null,
    registrationSource: 'open_registration',
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
  },
  workspaces: [{
    ...account.primaryWorkspace!,
    departmentId: null,
    departmentName: null,
    joinedAt: account.createdAt,
  }],
  activeSessions: [{
    id: 'session-1',
    createdAt: account.lastLoginAt!,
    lastSeenAt: account.lastLoginAt!,
    expiresAt: '2026-10-27T02:00:00.000Z',
    ipAddress: '127.0.0.1',
    userAgent: 'Chrome',
  }],
  recentAudit: [],
}

let app: App | undefined
let root: HTMLDivElement

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function mount(role: 'admin' | 'viewer' = 'admin') {
  authSession.user!.platformRole = role
  vi.mocked(listPlatformUsers).mockResolvedValue({ items: [account], total: 1, page: 1, pageSize: 20 })
  vi.mocked(getPlatformUser).mockResolvedValue(structuredClone(detail))
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(PlatformUsersPage)
  app.mount(root)
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = undefined
})

describe('platform users page', () => {
  async function openWorkspaces() {
    const button = [...root.querySelectorAll<HTMLButtonElement>('.tabs button')].find(button => button.textContent === '企业归属')!
    button.click()
    await nextTick()
  }

  async function prepareSharing() {
    await openWorkspaces()
    root.querySelector<HTMLInputElement>('[role="switch"]')!.click()
    await nextTick()
    const reason = root.querySelector<HTMLInputElement>('.ai-reason input')!
    reason.value = '授权企业共用模型'
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
  }

  it('saves enterprise sharing only after confirming a reason', async () => {
    await mount()
    await prepareSharing()
    expect(root.textContent).toContain('平台运营企业')
    expect(updatePlatformWorkspaceAiAccess).not.toHaveBeenCalled()
    const updated = structuredClone(detail)
    updated.workspaces[0]!.usePlatformAi = true
    updated.workspaces[0]!.platformAiSourceOrganizationName = '平台运营企业'
    vi.mocked(updatePlatformWorkspaceAiAccess).mockResolvedValue(updated)
    root.querySelector<HTMLFormElement>('.ai-edit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(updatePlatformWorkspaceAiAccess).toHaveBeenCalledWith(account.id, detail.workspaces[0]!.id, true, '授权企业共用模型')
    expect(root.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(true)
    expect(root.textContent).toContain('模型来源：平台运营企业')
    expect(root.querySelector('.ai-edit-form')).toBeNull()
  })

  it('cancels a draft without making an API request', async () => {
    await mount()
    await prepareSharing()
    root.querySelector<HTMLButtonElement>('.ai-edit-form button[type="button"]')!.click()
    await nextTick()
    expect(updatePlatformWorkspaceAiAccess).not.toHaveBeenCalled()
    expect(root.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(false)
  })

  it('leaves other tabs usable during a save and shows an inline failure', async () => {
    await mount()
    await prepareSharing()
    let fail!: (reason: Error) => void
    vi.mocked(updatePlatformWorkspaceAiAccess).mockImplementation(() => new Promise((_, reject) => { fail = reject }))
    root.querySelector<HTMLFormElement>('.ai-edit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(root.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(true)
    const overview = root.querySelector<HTMLButtonElement>('.tabs button')!
    expect(overview.disabled).toBe(false)
    overview.click()
    await nextTick()
    expect(root.textContent).toContain('基本信息')
    fail(new Error('测试保存失败'))
    await flush()
    await openWorkspaces()
    expect(root.textContent).toContain('测试保存失败')
    expect(root.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(false)
  })

  it('does not reopen a closed user detail when a pending save finishes', async () => {
    await mount()
    await prepareSharing()
    let finish!: (value: PlatformUserDetail) => void
    vi.mocked(updatePlatformWorkspaceAiAccess).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    root.querySelector<HTMLFormElement>('.ai-edit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    root.querySelector<HTMLButtonElement>('[aria-label="关闭用户详情"]')!.click()
    await nextTick()
    finish(structuredClone(detail))
    await flush()
    expect(root.querySelector('.drawer-header')).toBeNull()
  })

  it('disables enterprise switches for read-only operators', async () => {
    await mount('viewer')
    await openWorkspaces()
    expect(root.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(true)
  })

  it('keeps the switch unavailable before the database upgrade', async () => {
    await mount()
    const old = structuredClone(detail)
    old.workspaces[0]!.platformAiAccessReady = false
    vi.mocked(getPlatformUser).mockResolvedValue(old)
    root.querySelector<HTMLTableRowElement>('tbody tr')!.click()
    await flush()
    await openWorkspaces()
    expect(root.textContent).toContain('待启用')
    expect(root.querySelector<HTMLInputElement>('[role="switch"]')!.disabled).toBe(true)
  })
  it('loads the registered user and automatically opens account details', async () => {
    await mount()
    expect(root.textContent).toContain('陈婉清')
    expect(root.textContent).toContain('龙道科技')
    expect(root.textContent).toContain('企业归属')
    expect(getPlatformUser).toHaveBeenCalledWith(account.id)
  })

  it('shows account support actions to a platform administrator', async () => {
    await mount('admin')
    expect(root.textContent).toContain('重置密码')
    expect(root.querySelectorAll('.action-button')[0]?.hasAttribute('disabled')).toBe(false)
  })

  it('disables support actions for a platform viewer', async () => {
    await mount('viewer')
    expect(root.textContent).toContain('平台只读运营')
    expect([...root.querySelectorAll<HTMLButtonElement>('.action-button')].every(button => button.disabled)).toBe(true)
  })

  it('requires a reason before changing account status', async () => {
    await mount('admin')
    const statusButton = [...root.querySelectorAll<HTMLButtonElement>('.action-button')].find(button => button.textContent?.includes('停用账号'))
    statusButton?.click()
    await nextTick()
    const submit = [...root.querySelectorAll<HTMLButtonElement>('.action-dialog button')].find(button => button.textContent === '确认执行')
    submit?.click()
    await flush()
    expect(root.textContent).toContain('请填写 2～500 字的操作原因')
    expect(updatePlatformUserStatus).not.toHaveBeenCalled()
  })
})
