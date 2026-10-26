// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlatformUsersPage from './PlatformUsersPage.vue'
import { authSession } from '../../../auth/session'
import { getPlatformUser, listPlatformUsers, updatePlatformUserStatus, type PlatformUserDetail, type PlatformUserListItem } from '../api'

vi.mock('../api', () => ({
  getPlatformUser: vi.fn(),
  listPlatformUsers: vi.fn(),
  updatePlatformUserStatus: vi.fn(),
  updatePlatformUserProfile: vi.fn(),
  revokePlatformUserSessions: vi.fn(),
  resetPlatformUserPassword: vi.fn(),
}))
vi.mock('../../../auth/session', () => ({ authSession: { user: { platformRole: 'admin' } } }))

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
  vi.mocked(getPlatformUser).mockResolvedValue(detail)
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
