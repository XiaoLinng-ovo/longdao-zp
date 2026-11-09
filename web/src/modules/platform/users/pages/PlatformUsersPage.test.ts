// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import PlatformUsersPage from './PlatformUsersPage.vue'
import { authSession } from '../../../auth/session'
import { getPlatformUser, listPlatformUsers, resetPlatformUserAiGenerationQuota, updatePlatformUserStatus, updatePlatformWorkspaceAiAccess, type PlatformUserDetail, type PlatformUserListItem } from '../api'

vi.mock('../api', () => ({
  getPlatformUser: vi.fn(),
  listPlatformUsers: vi.fn(),
  updatePlatformUserStatus: vi.fn(),
  updatePlatformWorkspaceAiAccess: vi.fn(),
  updatePlatformUserProfile: vi.fn(),
  revokePlatformUserSessions: vi.fn(),
  resetPlatformUserPassword: vi.fn(),
  resetPlatformUserAiGenerationQuota: vi.fn(),
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
  function platformRoleFilterValues() {
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="平台身份"]')!
    return [...select.options].map(option => option.value)
  }

  async function openWorkspaces() {
    const button = [...root.querySelectorAll<HTMLButtonElement>('.tabs button')].find(button => button.textContent === '企业归属')!
    button.click()
    await nextTick()
  }

  it.each(['admin', 'viewer'] as const)('保留模型共享控件并按平台权限限制 %s 的操作能力', async role => {
    await mount(role)
    await openWorkspaces()
    expect(root.textContent).toContain('龙道科技')
    expect(root.querySelector('[role="switch"]')).not.toBeNull()
    expect((root.querySelector('[role="switch"]') as HTMLInputElement).disabled).toBe(role === 'viewer')
    expect(root.querySelector('.ai-edit-form')).toBeNull()
    expect(updatePlatformWorkspaceAiAccess).not.toHaveBeenCalled()
  })
  it('允许可写平台账号提交模型共享变更，并刷新企业归属状态', async () => {
    await mount('admin')
    await openWorkspaces()
    const updated = structuredClone(detail)
    updated.workspaces[0]!.usePlatformAi = true
    updated.workspaces[0]!.platformAiSourceOrganizationName = '平台运营企业'
    vi.mocked(updatePlatformWorkspaceAiAccess).mockResolvedValue(updated)

    const toggle = root.querySelector<HTMLInputElement>('[role="switch"]')!
    toggle.click()
    await nextTick()

    const reason = root.querySelector<HTMLInputElement>('.ai-reason input')!
    reason.value = '统一模型配置'
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('.ai-edit-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()

    expect(updatePlatformWorkspaceAiAccess).toHaveBeenCalledWith(account.id, detail.workspaces[0]!.id, true, '统一模型配置')
    expect(root.querySelector<HTMLInputElement>('[role="switch"]')!.checked).toBe(true)
    expect(root.textContent).toContain('模型来源：平台运营企业')
  })
  it('允许平台管理员重置所选试用企业的 AI 生成次数', async () => {
    await mount('admin')
    await openWorkspaces()
    vi.mocked(resetPlatformUserAiGenerationQuota).mockResolvedValue({
      organizationId: detail.workspaces[0]!.id,
      organizationName: detail.workspaces[0]!.name,
      previousGenerations: 3,
      generations: 0,
    })

    root.querySelector<HTMLButtonElement>('.quota-reset-button')!.click()
    await nextTick()
    expect(root.textContent).toContain('重置 AI 生成次数')
    const reason = root.querySelector<HTMLTextAreaElement>('.reason-field textarea')!
    reason.value = '修复误扣额度'
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    root.querySelector<HTMLButtonElement>('.primary-button')!.click()
    await flush()

    expect(resetPlatformUserAiGenerationQuota).toHaveBeenCalledWith(account.id, detail.workspaces[0]!.id, '修复误扣额度')
    expect(root.textContent).toContain('已将「龙道科技」的 AI 生成次数从 3 次重置为 0 次')
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

  it('shows platform role filters to a platform administrator', async () => {
    await mount('admin')
    expect(platformRoleFilterValues()).toContain('admin')
    expect(platformRoleFilterValues()).toContain('viewer')
  })

  it('keeps the platform role filters available to viewers', async () => {
    await mount('admin')
    expect(platformRoleFilterValues()).toContain('admin')
  })

  it('disables support actions for a platform viewer', async () => {
    await mount('viewer')
    expect(root.textContent).toContain('普通账号')
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
