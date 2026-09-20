// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdministrationPage from './AdministrationPage.vue'
import { listAdminChecks, loadWorkflowEvents, listAdminUsers, listAdminRoles, listAdminDepartments, createAdminDepartment, updateAdminDepartment, deleteAdminDepartment, getAdminSettings, updateAdminSettings, getDingTalkSettings, updateDingTalkSettings, getResumeVirusScanSetting, updateResumeVirusScanSetting, listFailedAnalysisTasks, listAdminAuditLogs } from '../api'

vi.mock('../api', () => ({ listAdminChecks: vi.fn(), loadWorkflowEvents: vi.fn(), listAdminUsers: vi.fn(), listAdminRoles: vi.fn(), listAdminDepartments: vi.fn(), createAdminDepartment: vi.fn(), updateAdminDepartment: vi.fn(), deleteAdminDepartment: vi.fn(), getAdminSettings: vi.fn(), updateAdminSettings: vi.fn(), getDingTalkSettings: vi.fn(), updateDingTalkSettings: vi.fn(), getResumeVirusScanSetting: vi.fn(), updateResumeVirusScanSetting: vi.fn(), listFailedAnalysisTasks: vi.fn(), listAdminAuditLogs: vi.fn() }))
const mockedChecks = vi.mocked(listAdminChecks)
const mockedCreateDepartment = vi.mocked(createAdminDepartment)
const mockedUpdateDepartment = vi.mocked(updateAdminDepartment)
const mockedDeleteDepartment = vi.mocked(deleteAdminDepartment)
const mockedEvents = vi.mocked(loadWorkflowEvents)
const mockedUsers = vi.mocked(listAdminUsers)
const mockedRoles = vi.mocked(listAdminRoles)
const mockedDepartments = vi.mocked(listAdminDepartments)
const mockedSettings = vi.mocked(getAdminSettings)
const mockedDingTalkSettings = vi.mocked(getDingTalkSettings)
const mockedVirusScan = vi.mocked(getResumeVirusScanSetting)
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
    mockedUsers.mockResolvedValue([]); mockedRoles.mockResolvedValue([]); mockedDepartments.mockResolvedValue([]); mockedSettings.mockResolvedValue({}); mockedDingTalkSettings.mockResolvedValue({}); mockedVirusScan.mockResolvedValue({ enabled: false }); mockedFailedTasks.mockResolvedValue([]); mockedAuditLogs.mockResolvedValue([])
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
    mockedRoles.mockResolvedValue([{ id: 'r1', code: 'admin', name: '系统管理员' }]); mockedDepartments.mockResolvedValue([{ id: 'd1', code: 'dept-tech', name: '技术部', isActive: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }])
    mockedSettings.mockResolvedValue({ timezone: 'Asia/Shanghai' }); mockedDingTalkSettings.mockResolvedValue({}); mockedVirusScan.mockResolvedValue({ enabled: false })
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

  const departmentsFixture = [
    { id: 'd1', code: 'dept-tech', name: '技术部', isActive: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
    { id: 'd2', code: 'dept-old', name: '历史部门', isActive: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  ]

  async function mountWithDepartments(departments = departmentsFixture) {
    mockedChecks.mockResolvedValue([]); mockedEvents.mockResolvedValue([])
    mockedUsers.mockResolvedValue([]); mockedRoles.mockResolvedValue([])
    mockedDepartments.mockResolvedValue(departments)
    mockedSettings.mockResolvedValue({}); mockedDingTalkSettings.mockResolvedValue({}); mockedVirusScan.mockResolvedValue({ enabled: false })
    mockedFailedTasks.mockResolvedValue([]); mockedAuditLogs.mockResolvedValue([])
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(AdministrationPage); app.mount(root); await flush()
  }

  function departmentRows() {
    const table = Array.from(root!.querySelectorAll('table')).find((item) => (item.textContent ?? '').includes('dept-tech'))!
    return Array.from(table.querySelectorAll('tbody tr'))
  }
  function rowButtons(index: number) {
    return Array.from(departmentRows()[index]!.querySelectorAll('button')).map((button) => button.textContent)
  }
  function clickRowButton(index: number, label: string) {
    Array.from(departmentRows()[index]!.querySelectorAll('button')).find((button) => button.textContent === label)!.click()
  }

  it('部门区块：状态与停用/启用可操作、编码规则有行内提示、删除需二次确认', async () => {
    mockedUpdateDepartment.mockResolvedValue({ id: 'd1', code: 'dept-tech', name: '技术部', isActive: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' })
    await mountWithDepartments()

    // 停用是软停用；没有关联记录的部门可以直接删除
    expect(root!.textContent).toContain('已无关联记录的部门可以直接删除')
    expect(root!.textContent).toContain('编码规则：3-64 位')

    const rows = departmentRows()
    expect(rows).toHaveLength(2)
    // 状态是文字而不是裸复选框
    expect(rows[0]!.querySelectorAll('td')[2]!.textContent?.trim()).toBe('启用')
    expect(rows[1]!.querySelectorAll('td')[2]!.textContent?.trim()).toBe('已停用')
    expect(root!.querySelector('table')!.parentElement!.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(rowButtons(0)).toEqual(['保存名称', '停用', '删除'])
    expect(rowButtons(1)).toEqual(['保存名称', '启用', '删除'])

    // 停用走 PATCH isActive=false（软停用），不是删除接口
    clickRowButton(0, '停用'); await flush()
    expect(mockedUpdateDepartment).toHaveBeenCalledWith('d1', { isActive: false })
    expect(mockedDeleteDepartment).not.toHaveBeenCalled()

    // 编码非法标红，合法恢复
    const codeInput = root!.querySelector<HTMLInputElement>('input[aria-label="部门编码"]')!
    codeInput.value = '研发部'; codeInput.dispatchEvent(new Event('input')); await flush()
    expect(root!.querySelector('.dept-code-hint')!.classList.contains('is-invalid')).toBe(true)
    codeInput.value = 'dept-ops'; codeInput.dispatchEvent(new Event('input')); await flush()
    expect(root!.querySelector('.dept-code-hint')!.classList.contains('is-invalid')).toBe(false)

    // 合法编码可以新增
    const nameInput = root!.querySelector<HTMLInputElement>('input[aria-label="部门名称"]')!
    nameInput.value = '运维部'; nameInput.dispatchEvent(new Event('input')); await flush()
    mockedCreateDepartment.mockResolvedValue({ id: 'd3', code: 'dept-ops', name: '运维部', isActive: true, createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z' })
    Array.from(root!.querySelectorAll('button')).find((button) => button.textContent === '新增部门')!.click()
    await flush()
    expect(mockedCreateDepartment).toHaveBeenCalledWith({ code: 'dept-ops', name: '运维部' })
  })

  it('部门删除：点「删除」先进入二次确认，确认后调用删除接口并移除该行', async () => {
    mockedDeleteDepartment.mockResolvedValue({ id: 'd2', code: 'dept-old', name: '历史部门', removedApprovalPolicies: 0 })
    await mountWithDepartments()

    // 第一次点击只进入确认态，不发请求
    clickRowButton(1, '删除'); await flush()
    expect(rowButtons(1)).toEqual(['保存名称', '启用', '确认删除', '取消'])
    expect(mockedDeleteDepartment).not.toHaveBeenCalled()

    // 「取消」回到初始态
    clickRowButton(1, '取消'); await flush()
    expect(rowButtons(1)).toEqual(['保存名称', '启用', '删除'])
    expect(mockedDeleteDepartment).not.toHaveBeenCalled()

    // 再次进入确认态并确认删除
    clickRowButton(1, '删除'); await flush()
    clickRowButton(1, '确认删除'); await flush()
    expect(mockedDeleteDepartment).toHaveBeenCalledWith('d2')
    expect(departmentRows()).toHaveLength(1)
    expect(root!.textContent).toContain('已删除部门「历史部门」')
  })

  it('部门删除：被引用时展示后端返回的原因且保留该行', async () => {
    mockedDeleteDepartment.mockRejectedValue(new Error('无法删除部门「历史部门」：仍有 2 个岗位引用该部门。请先转移这些记录，或改用「停用」。'))
    await mountWithDepartments()

    clickRowButton(1, '删除'); await flush()
    clickRowButton(1, '确认删除'); await flush()

    expect(mockedDeleteDepartment).toHaveBeenCalledWith('d2')
    // 行级错误只出现在部门区块内：整页内容（表格等）保持可用，不会被错误横幅替换
    expect(root!.querySelector('.error-note')!.textContent).toContain('仍有 2 个岗位引用该部门')
    expect(root!.textContent).toContain('用户与角色')
    expect(departmentRows()).toHaveLength(2)
  })
})
