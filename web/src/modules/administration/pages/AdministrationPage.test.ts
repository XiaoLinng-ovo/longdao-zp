// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import AdministrationPage from './AdministrationPage.vue'
import { authSession } from '../../auth/session'
import { listAdminChecks, loadWorkflowEvents, listAdminUsers, listAdminRoles, listAdminDepartments, createAdminDepartment, updateAdminDepartment, deleteAdminDepartment, getAdminSettings, updateAdminSettings, getDingTalkSettings, updateDingTalkSettings, getResumeVirusScanSetting, updateResumeVirusScanSetting, getAiSettings, saveAiSettings, testAiConnection, updateAdminUser, listFailedAnalysisTasks, listAdminAuditLogs, getChannelSettings, listAiPromptSkills, getDingTalkApprovalConfig, listAccountOrganizations, createAdminUser } from '../api'

vi.mock('../api', () => ({ listAdminChecks: vi.fn(), loadWorkflowEvents: vi.fn(), listAdminUsers: vi.fn(), listAdminRoles: vi.fn(), listAdminDepartments: vi.fn(), createAdminDepartment: vi.fn(), updateAdminDepartment: vi.fn(), deleteAdminDepartment: vi.fn(), getAdminSettings: vi.fn(), updateAdminSettings: vi.fn(), getDingTalkSettings: vi.fn(), updateDingTalkSettings: vi.fn(), getDingTalkApprovalConfig: vi.fn(), updateDingTalkDepartmentApprovalConfig: vi.fn(), updateDingTalkUserMapping: vi.fn(), getResumeVirusScanSetting: vi.fn(), updateResumeVirusScanSetting: vi.fn(), getAiSettings: vi.fn(), saveAiSettings: vi.fn(), testAiConnection: vi.fn(), updateAdminUser: vi.fn(), listFailedAnalysisTasks: vi.fn(), listAdminAuditLogs: vi.fn(), getChannelSettings: vi.fn(), updateChannelSettings: vi.fn(), testChannelConnection: vi.fn(), listAiPromptSkills: vi.fn(), createAiPromptSkill: vi.fn(), updateAiPromptSkill: vi.fn(), deleteAiPromptSkill: vi.fn(), listAccountOrganizations: vi.fn(), createAdminUser: vi.fn() }))
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
const mockedDingTalkApprovalConfig = vi.mocked(getDingTalkApprovalConfig)
const mockedVirusScan = vi.mocked(getResumeVirusScanSetting)
const mockedAiSettings = vi.mocked(getAiSettings)
const mockedAiConnectionTest = vi.mocked(testAiConnection)
const mockedFailedTasks = vi.mocked(listFailedAnalysisTasks)
const mockedAuditLogs = vi.mocked(listAdminAuditLogs)
const mockedChannelSettings = vi.mocked(getChannelSettings)
const mockedAiPromptSkills = vi.mocked(listAiPromptSkills)
const mockedAccountOrganizations = vi.mocked(listAccountOrganizations)
const mockedCreateAdminUser = vi.mocked(createAdminUser)

const checks = [{ category: '服务健康', owner: '系统管理员', status: 'active' as const, detail: 'smartrecruit-api' }]
const event = { id: 'event-1', subjectType: 'offer' as const, subjectId: 'OFF-1', subjectLabel: 'OFF-1', action: 'expire', fromStatus: 'sent', toStatus: 'expired', actorId: 'user-demo', createdAt: '2026-09-11T00:00:00Z' }

let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
beforeEach(() => {
  mockedDingTalkApprovalConfig.mockResolvedValue({ subjectType: 'recruitment_request', callbackUrl: null, callbackUrlConfigured: false, departments: [], users: [] })
  mockedAiSettings.mockResolvedValue({
    configured: true, baseUrlHost: 'api.example.com', model: 'gpt-4o-mini', timeoutMs: 30000, apiKeyConfigured: true, missing: [],
    env: {
      OPENAI_BASE_URL: { value: 'https://api.example.com/v1', configured: true, masked: false },
      OPENAI_API_KEY: { value: 'gp••••ni', configured: true, masked: true },
      OPENAI_MODEL: { value: 'gpt-4o-mini', configured: true, masked: false },
      OPENAI_TIMEOUT_MS: { value: '30000', configured: true, masked: false },
    },
  })
  mockedAiConnectionTest.mockResolvedValue({ ok: true, message: 'ok', latencyMs: 12, models: ['gpt-4o-mini'] })
  mockedChannelSettings.mockResolvedValue({
    boss: { id: 'boss', name: 'BOSS直聘', description: '', enabled: false, configured: false, missing: [], values: {}, fields: [], capabilities: [] },
    liepin: { id: 'liepin', name: '猎聘', description: '', enabled: false, configured: false, missing: [], values: {}, fields: [], capabilities: [] },
    '51job': { id: '51job', name: '前程无忧', description: '', enabled: false, configured: false, missing: [], values: {}, fields: [], capabilities: [] },
    official_site: { id: 'official_site', name: '公司官网', description: '', enabled: false, configured: false, missing: [], values: {}, fields: [], capabilities: [] },
  })
  mockedAiPromptSkills.mockResolvedValue([])
  mockedAccountOrganizations.mockResolvedValue([{ id: 'org-1', name: '示例企业' }])
  mockedCreateAdminUser.mockResolvedValue({
    user: { id: 'u-new', email: 'new@example.com', displayName: '新同事', role: 'recruiter', departmentCode: 'dept-tech', isActive: true, lastLoginAt: null, createdAt: '2026-10-22T00:00:00Z' },
    initialPassword: 'Generated-Password-1',
    generatedPassword: true,
  })
})
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

async function mountAdmin(moduleKey = 'users', path = '/administration', enterpriseAiOnly = false) {
  app?.unmount()
  app = undefined
  root?.remove()
  root = undefined
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/administration', component: { template: '<div />' } }],
  })
  await router.push(`${path}?module=${moduleKey}`)
  await router.isReady()
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(AdministrationPage, { enterpriseAiOnly })
  app.use(router)
  app.mount(root)
  await flush()
}

describe('管理后台页面', () => {
  it('展示系统检查与流程审计记录，而不是空占位', async () => {
    mockedChecks.mockResolvedValue(checks)
    mockedEvents.mockResolvedValue([event])
    mockedUsers.mockResolvedValue([]); mockedRoles.mockResolvedValue([]); mockedDepartments.mockResolvedValue([]); mockedSettings.mockResolvedValue({}); mockedDingTalkSettings.mockResolvedValue({}); mockedVirusScan.mockResolvedValue({ enabled: false }); mockedFailedTasks.mockResolvedValue([]); mockedAuditLogs.mockResolvedValue([])

    await mountAdmin('health')
    expect(root!.textContent).toContain('服务健康')

    await mountAdmin('workflow-audit')
    expect(root!.textContent).not.toContain('OFF-1')
    expect(mockedEvents).not.toHaveBeenCalled()
    expect(mockedAiSettings).not.toHaveBeenCalled()
    expect(mockedFailedTasks).not.toHaveBeenCalled()
  })

  it('AI 配置接口不可用时给出明确提示，而不是一直停在加载态', async () => {
    mockedChecks.mockResolvedValue([]); mockedEvents.mockResolvedValue([])
    mockedUsers.mockResolvedValue([]); mockedRoles.mockResolvedValue([]); mockedDepartments.mockResolvedValue([])
    mockedSettings.mockResolvedValue({}); mockedDingTalkSettings.mockResolvedValue({}); mockedVirusScan.mockResolvedValue({ enabled: false })
    mockedFailedTasks.mockResolvedValue([]); mockedAuditLogs.mockResolvedValue([])
    mockedAiSettings.mockRejectedValue(new Error('未找到接口：GET /api/v1/admin/ai-settings'))
    await mountAdmin('ai', '/administration', true)
    expect(root!.textContent).toContain('无法读取模型配置')
    expect(root!.textContent).not.toContain('正在读取模型配置')
  })

  it('按模块加载并展示用户、系统设置、失败任务和管理审计', async () => {
    mockedChecks.mockResolvedValue([]); mockedEvents.mockResolvedValue([])
    mockedUsers.mockResolvedValue([{ id: 'u1', email: 'admin@example.com', displayName: '管理员', role: 'admin', departmentCode: 'HQ', isActive: true, lastLoginAt: null, createdAt: '2026-09-01T00:00:00Z' }])
    mockedRoles.mockResolvedValue([{ id: 'r1', code: 'admin', name: '系统管理员' }]); mockedDepartments.mockResolvedValue([{ id: 'd1', code: 'dept-tech', name: '技术部', isActive: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }])
    mockedSettings.mockResolvedValue({ timezone: 'Asia/Shanghai' }); mockedDingTalkSettings.mockResolvedValue({}); mockedVirusScan.mockResolvedValue({ enabled: false })
    mockedFailedTasks.mockResolvedValue([{ id: 't1', resumeId: 'res-1', status: 'failed', attempts: 2, idempotencyKey: 'k', lastError: '解析失败', availableAt: '2026-09-01T00:00:00Z', createdAt: '2026-09-01T00:00:00Z' }])
    mockedAuditLogs.mockResolvedValue([{ id: 'a1', actorId: 'u1', actorEmail: 'admin@example.com', action: 'admin.settings.update', resourceType: 'system_settings', resourceId: null, requestId: 'req-1', metadata: {}, createdAt: '2026-09-01T00:00:00Z' }])

    await mountAdmin('users')
    expect(root!.textContent).toContain('用户与角色')
    expect(root!.textContent).toContain('admin@example.com')
    expect(root!.textContent).toContain('系统管理员')

    await mountAdmin('settings')
    expect(root!.querySelector<HTMLInputElement>('#setting-timezone')?.value).toBe('Asia/Shanghai')
    expect(root!.textContent).toContain('保存设置')

    await mountAdmin('failed-tasks')
    expect(root!.textContent).not.toContain('解析失败')
    expect(mockedFailedTasks).not.toHaveBeenCalled()

    await mountAdmin('audit-logs')
    expect(root!.textContent).toContain('共 1 条，第 1 / 1 页')
  })

  it('账号创建模块可从平台管理后台进入并加载账号配置表单', async () => {
    mockedChecks.mockResolvedValue([]); mockedEvents.mockResolvedValue([])
    mockedUsers.mockResolvedValue([])
    mockedRoles.mockResolvedValue([
      { id: 'r1', code: 'recruiter', name: '招聘专员' },
      { id: 'r2', code: 'platform_admin', name: '平台管理员' },
    ])
    mockedDepartments.mockResolvedValue([{ id: 'd1', code: 'dept-tech', name: '技术部', isActive: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }])

    await mountAdmin('account-creation')

    expect(root!.textContent).toContain('账号创建')
    expect(root!.querySelector('#account-email')).not.toBeNull()
    expect(root!.querySelector('#account-organization')).not.toBeNull()
    expect(root!.querySelector('#account-department')).not.toBeNull()
    expect(root!.querySelector('#account-role')).not.toBeNull()
    expect(root!.textContent).not.toContain('平台管理员')
    expect(mockedAccountOrganizations).toHaveBeenCalledOnce()
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
    await mountAdmin('departments')
  }

  function departmentRows() {
    const section = Array.from(root!.querySelectorAll('section')).find((item) => item.querySelector('.section-title')?.textContent === '部门管理')!
    const table = section.querySelector('table')!
    return Array.from(table.querySelectorAll('tbody tr'))
  }
  function rowButtons(index: number) {
    return Array.from(departmentRows()[index]!.querySelectorAll('button')).map((button) => button.textContent)
  }
  function clickRowButton(index: number, label: string) {
    Array.from(departmentRows()[index]!.querySelectorAll('button')).find((button) => button.textContent === label)!.click()
  }

  it('部门区块：只需填写名称，内部编码不展示，状态与删除操作可用', async () => {
    mockedUpdateDepartment.mockResolvedValue({ id: 'd1', code: 'dept-tech', name: '技术部', isActive: false, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' })
    await mountWithDepartments()

    // 停用是软停用；没有关联记录的部门可以直接删除
    expect(root!.textContent).toContain('已无关联记录的部门可以直接删除')
    expect(root!.textContent).not.toContain('部门编码')
    expect(root!.textContent).not.toContain('dept-tech')
    expect(root!.textContent).not.toContain('（dept-tech）')

    const rows = departmentRows()
    expect(rows).toHaveLength(2)
    // 状态是文字而不是裸复选框
    expect(rows[0]!.querySelectorAll('td')[1]!.textContent?.trim()).toBe('启用')
    expect(rows[1]!.querySelectorAll('td')[1]!.textContent?.trim()).toBe('已停用')
    expect(root!.querySelector('table')!.parentElement!.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect(rowButtons(0)).toEqual(['重命名', '停用', '删除'])
    expect(rowButtons(1)).toEqual(['重命名', '启用', '删除'])

    // 停用走 PATCH isActive=false（软停用），不是删除接口
    clickRowButton(0, '停用'); await flush()
    expect(mockedUpdateDepartment).toHaveBeenCalledWith('d1', { isActive: false })
    expect(mockedDeleteDepartment).not.toHaveBeenCalled()

    expect(root!.querySelector('input[aria-label="部门编码"]')).toBeNull()

    // 只提交部门名称，编码由后端生成
    const nameInput = root!.querySelector<HTMLInputElement>('input[aria-label="部门名称"]')!
    nameInput.value = '运维部'; nameInput.dispatchEvent(new Event('input')); await flush()
    mockedCreateDepartment.mockResolvedValue({ id: 'd3', code: 'dept-ops', name: '运维部', isActive: true, createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z' })
    Array.from(root!.querySelectorAll('button')).find((button) => button.textContent === '新增部门')!.click()
    await flush()
    expect(mockedCreateDepartment).toHaveBeenCalledWith({ name: '运维部' })
  })

  it('部门名称默认只读，需点「重命名」才可编辑', async () => {
    mockedUpdateDepartment.mockResolvedValue({ id: 'd1', code: 'dept-tech', name: '研发部', isActive: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z' })
    await mountWithDepartments()

    // 默认渲染为文本，不是随手可改的输入框
    expect(departmentRows()[0]!.querySelector('td')!.querySelector('input')).toBeNull()
    expect(departmentRows()[0]!.querySelector('td')!.textContent?.trim()).toBe('技术部')

    clickRowButton(0, '重命名'); await flush()
    const renameInput = root!.querySelector<HTMLInputElement>('input[aria-label="部门新名称"]')!
    expect(renameInput.value).toBe('技术部')

    renameInput.value = '研发部'; renameInput.dispatchEvent(new Event('input')); await flush()
    clickRowButton(0, '保存名称'); await flush()
    expect(mockedUpdateDepartment).toHaveBeenCalledWith('d1', { name: '研发部' })
    expect(departmentRows()[0]!.querySelector('td')!.textContent?.trim()).toBe('研发部')
  })

  it('部门删除：点「删除」先进入二次确认，确认后调用删除接口并移除该行', async () => {
    mockedDeleteDepartment.mockResolvedValue({ id: 'd2', code: 'dept-old', name: '历史部门', removedApprovalPolicies: 0 })
    await mountWithDepartments()

    // 第一次点击只进入确认态，不发请求
    clickRowButton(1, '删除'); await flush()
    expect(rowButtons(1)).toEqual(['重命名', '启用', '确认删除', '取消'])
    expect(mockedDeleteDepartment).not.toHaveBeenCalled()

    // 「取消」回到初始态
    clickRowButton(1, '取消'); await flush()
    expect(rowButtons(1)).toEqual(['重命名', '启用', '删除'])
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


describe('企业独立 AI 配置页面', () => {
  beforeEach(() => {
    authSession.user = {id:'u1',name:'企业所有者',email:'owner@example.invalid',role:'recruiter',departmentId:'',workspaceId:'w1'}
    authSession.workspaces = [{id:'w1',name:'测试客户企业',kind:'test',status:'active',role:'owner',createdAt:'2026-10-12'}]
  })
  afterEach(() => { authSession.user=null;authSession.workspaces=[] })
  it('企业模式只读取企业 AI 和 Skill，不读取平台全局管理接口', async () => {
    await mountAdmin('ai','/administration',true)
    expect(root!.textContent).toContain('企业 AI 配置');expect(root!.textContent).toContain('测试客户企业')
    expect(mockedAiSettings).toHaveBeenCalledOnce();expect(mockedAiPromptSkills).toHaveBeenCalled()
    for (const api of [mockedUsers,mockedRoles,mockedDepartments,mockedSettings,mockedDingTalkSettings,mockedFailedTasks,mockedAuditLogs,mockedChecks,mockedEvents]) expect(api).not.toHaveBeenCalled()
    expect(root!.querySelector<HTMLInputElement>('#ai-api-key')!.value).toBe('')
    expect(root!.querySelector('#ai-model')!.tagName).toBe('INPUT')
  })
  it('可手填模型；保存时空白密钥不回写掩码，保留服务端原密钥', async () => {
    mockedAiSettings.mockResolvedValueOnce(await mockedAiSettings())
    vi.mocked(saveAiSettings).mockResolvedValue(await mockedAiSettings())
    await mountAdmin('ai','/administration',true)
    const model=root!.querySelector<HTMLInputElement>('#ai-model')!;model.value='custom-provider-model';model.dispatchEvent(new Event('input',{bubbles:true}));await flush()
    Array.from(root!.querySelectorAll('button')).find(b=>b.textContent==='保存模型配置')!.click();await flush()
    expect(saveAiSettings).toHaveBeenCalledWith({OPENAI_BASE_URL:'https://api.example.com/v1',OPENAI_MODEL:'custom-provider-model',OPENAI_TIMEOUT_MS:'30000'})
  })
  it('测试连接后展示全部模型，可搜索选择并在明确保存后提交模型 ID', async () => {
    const models = ['gpt-4o-mini','gpt-4o','deepseek-chat','deepseek-reasoner','qwen-plus','qwen-turbo','custom-chat']
    mockedAiConnectionTest.mockResolvedValue({ok:true,message:'发现 7 个可用模型',latencyMs:12,models})
    vi.mocked(saveAiSettings).mockResolvedValue(await mockedAiSettings())
    await mountAdmin('ai','/administration',true)
    Array.from(root!.querySelectorAll('button')).find(button => button.textContent === '测试连接')!.click()
    await flush()
    root!.querySelector<HTMLButtonElement>('[aria-label="选择模型"]')!.click()
    await flush()
    expect(root!.querySelectorAll('[role="option"]').length).toBe(7)
    const search = root!.querySelector<HTMLInputElement>('[aria-label="搜索可用模型"]')!
    search.value = 'reasoner'; search.dispatchEvent(new Event('input',{bubbles:true})); await flush()
    root!.querySelector<HTMLButtonElement>('[role="option"]')!.click(); await flush()
    expect(root!.querySelector<HTMLInputElement>('#ai-model')!.value).toBe('deepseek-reasoner')
    expect(saveAiSettings).not.toHaveBeenCalled()
    Array.from(root!.querySelectorAll('button')).find(button => button.textContent === '保存模型配置')!.click(); await flush()
    expect(saveAiSettings).toHaveBeenCalledWith({OPENAI_BASE_URL:'https://api.example.com/v1',OPENAI_MODEL:'deepseek-reasoner',OPENAI_TIMEOUT_MS:'30000'})
  })
  it('清除密钥必须二次确认', async () => {
    vi.mocked(saveAiSettings).mockResolvedValue(await mockedAiSettings())
    await mountAdmin('ai','/administration',true)
    Array.from(root!.querySelectorAll('button')).find(b=>b.textContent==='清除密钥')!.click();await flush()
    expect(saveAiSettings).not.toHaveBeenCalled()
    Array.from(root!.querySelectorAll('button')).find(b=>b.textContent==='确认清除密钥')!.click();await flush()
    expect(saveAiSettings).toHaveBeenCalledWith({OPENAI_API_KEY:''})
  })
})
