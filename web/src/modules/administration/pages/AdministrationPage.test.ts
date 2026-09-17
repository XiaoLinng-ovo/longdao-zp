// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdministrationPage from './AdministrationPage.vue'
import { listAdminChecks, loadWorkflowEvents, listAdminUsers, listAdminRoles, getAdminSettings, updateAdminSettings, listFailedAnalysisTasks, listAdminAuditLogs } from '../api'

vi.mock('../api', () => ({ listAdminChecks: vi.fn(), loadWorkflowEvents: vi.fn(), listAdminUsers: vi.fn(), listAdminRoles: vi.fn(), getAdminSettings: vi.fn(), updateAdminSettings: vi.fn(), listFailedAnalysisTasks: vi.fn(), listAdminAuditLogs: vi.fn() }))
const mockedChecks = vi.mocked(listAdminChecks)
const mockedEvents = vi.mocked(loadWorkflowEvents)
const mockedUsers = vi.mocked(listAdminUsers)
const mockedRoles = vi.mocked(listAdminRoles)
const mockedSettings = vi.mocked(getAdminSettings)
const mockedFailedTasks = vi.mocked(listFailedAnalysisTasks)
const mockedAuditLogs = vi.mocked(listAdminAuditLogs)

const checks = [{ category: '服务健康', owner: '系统管理员', status: 'active' as const, detail: 'smartrecruit-api' }]
const event = { id: 'event-1', subjectType: 'offer' as const, subjectId: 'OFF-1', subjectLabel: 'OFF-1', action: 'expire', fromStatus: 'sent', toStatus: 'expired', actorId: 'user-demo', createdAt: '2026-09-11T00:00:00Z' }

let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

describe('管理后台页面', () => {
  it('展示系统检查与流程审计记录，而不是空占位', async () => {
    mockedChecks.mockResolvedValue(checks)
    mockedEvents.mockResolvedValue([event])
    mockedUsers.mockResolvedValue([]); mockedRoles.mockResolvedValue([]); mockedSettings.mockResolvedValue({}); mockedFailedTasks.mockResolvedValue([]); mockedAuditLogs.mockResolvedValue([])
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(AdministrationPage); app.mount(root)
    await flush()
    expect(root.textContent).toContain('服务健康')
    expect(root.textContent).toContain('流程审计记录')
    expect(root.textContent).toContain('OFF-1')
    expect(root.textContent).toContain('过期')
  })

  it('加载并展示用户、角色、系统设置、失败任务和管理审计', async () => {
    mockedChecks.mockResolvedValue([]); mockedEvents.mockResolvedValue([])
    mockedUsers.mockResolvedValue([{ id: 'u1', email: 'admin@example.com', displayName: '管理员', role: 'admin', departmentCode: 'HQ', isActive: true, lastLoginAt: null, createdAt: '2026-09-01T00:00:00Z' }])
    mockedRoles.mockResolvedValue([{ id: 'r1', code: 'admin', name: '系统管理员' }])
    mockedSettings.mockResolvedValue({ timezone: 'Asia/Shanghai' })
    mockedFailedTasks.mockResolvedValue([{ id: 't1', resumeId: 'res-1', status: 'failed', attempts: 2, idempotencyKey: 'k', lastError: '解析失败', availableAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' }])
    mockedAuditLogs.mockResolvedValue([{ id: 'a1', actorId: 'u1', actorEmail: 'admin@example.com', action: 'admin.settings.update', resourceType: 'system_settings', resourceId: null, requestId: 'req-1', metadata: {}, createdAt: '2026-09-01T00:00:00Z' }])
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(AdministrationPage); app.mount(root); await flush()
    expect(root.textContent).toContain('用户与角色')
    expect(root.textContent).toContain('admin@example.com')
    expect(root.textContent).toContain('系统管理员')
    expect(root.textContent).toContain('Asia/Shanghai')
    expect(root.textContent).toContain('解析失败')
    expect(root.textContent).toContain('admin.settings.update')
  })
})
