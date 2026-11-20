// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import JobListPage from './JobListPage.vue'
import { deleteJob, loadJobs, loadJobRelatedRecords, type JobView } from '../api'
import { ApiResponseError } from '../../../shared/api'
import { authSession } from '../../auth/session'
import { loadDepartments } from '../../requisitions/api'
import { deleteApplication, detachResumeImportJob } from '../../candidates/api'
vi.mock('../../candidates/api', () => ({ deleteApplication: vi.fn(), detachResumeImportJob: vi.fn() }))

vi.mock('../api', () => ({ loadJobs: vi.fn(), createJob: vi.fn(), jobAction: vi.fn(), deleteJob: vi.fn(), loadJobRelatedRecords: vi.fn() }))
vi.mock('../../../shared/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../../../shared/api')>(), apiClient: { getJson: vi.fn() } }))
vi.mock('../../requisitions/api', () => ({ loadDepartments: vi.fn().mockResolvedValue([]) }))
vi.mock('../../auth/session', async () => {
  const { reactive } = await import('vue')
  return { authSession: reactive({ user: { role: 'recruiter' } }) }
})
const job = { id: 'JOB-42', entityId: 'job-uuid', title: '人事测试岗位', department: '人事部', statusLabel: '草稿', recruitmentRequestId: '', headcount: 1, filledCount: 0, status: 'draft', channels: [], updatedAt: '2026-10-10' } as JobView
let app: App | undefined
let root: HTMLDivElement
async function flush() { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
async function mount(role = 'recruiter') {
  authSession.user = { role } as never
  vi.mocked(loadDepartments).mockResolvedValue([])
  vi.mocked(loadJobs).mockResolvedValue([{ ...job }])
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/jobs', name: 'jobs', component: { template: '<div />' } },
    { path: '/candidates/:id', name: 'candidate-detail', component: { template: '<div />' } },
    { path: '/resume-import-batches/:id', name: 'resume-import-detail', component: { template: '<div />' } },
  ] })
  await router.push('/jobs')
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(JobListPage); app.use(router); app.mount(root); await flush()
  return router
}
function button(text: string) { return [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === text)! }
async function openDelete() { button('删除岗位').click(); await flush() }
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

describe('岗位删除', () => {
  const blocked = () => vi.mocked(deleteJob).mockRejectedValue(new ApiResponseError('该岗位存在关联业务记录，不能直接删除', { status: 409, code: 'JOB_IN_USE' }))
  const records = [
    { kind: 'application' as const, id: 'application-1', title: '张三 · APP-1', candidateId: 'candidate-1', applicationId: 'application-1', status: 'rejected', updatedAt: '2026-11-12' },
    { kind: 'resume_import' as const, id: 'batch-1', title: '简历.pdf', status: 'cancelled', updatedAt: '2026-11-11' },
  ]
  it('删除受阻后列出实际关联业务并准确跳转到申请和导入批次', async () => {
    blocked(); vi.mocked(loadJobRelatedRecords).mockResolvedValue(records)
    const router = await mount(); await openDelete(); button('确认删除').click(); await flush()
    expect(root.querySelector('[role=dialog]')).toBeNull()
    expect(loadJobRelatedRecords).toHaveBeenCalledWith('job-uuid')
    const section = root.querySelector('.job-related-records')!
    expect(section.textContent).toContain('张三 · APP-1')
    expect(section.textContent).toContain('简历导入批次')
    const links = section.querySelectorAll('a')
    expect(links[0]!.getAttribute('href')).toBe('/candidates/candidate-1?applicationId=application-1')
    expect(links[1]!.getAttribute('href')).toBe('/resume-import-batches/batch-1')
    links[0]!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.query.applicationId).toBe('application-1'))
    links[1]!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('resume-import-detail'))
    expect(deleteJob).toHaveBeenCalledTimes(1)
  })
  it('关联记录读取失败可重试且不重复删除岗位', async () => {
    blocked(); vi.mocked(loadJobRelatedRecords).mockRejectedValueOnce(new Error('读取关联记录失败')).mockResolvedValueOnce(records)
    await mount(); await openDelete(); button('确认删除').click(); await flush()
    expect(root.querySelector('.job-related-records')?.textContent).toContain('读取关联记录失败')
    button('重试').click(); await flush()
    expect(root.querySelector('.job-related-records')?.textContent).toContain('张三')
    expect(loadJobRelatedRecords).toHaveBeenCalledTimes(2)
    expect(deleteJob).toHaveBeenCalledTimes(1)
  })
  it('加载中关闭关联列表后不被迟到响应重新打开', async () => {
    blocked()
    let resolve!: (value: typeof records) => void
    vi.mocked(loadJobRelatedRecords).mockImplementation(() => new Promise(done => { resolve = done }))
    await mount(); await openDelete(); button('确认删除').click(); await flush()
    expect(root.querySelector('.job-related-records [role=status]')).not.toBeNull()
    root.querySelector<HTMLButtonElement>('.job-related-records button[aria-label="关闭关联业务"]')!.click(); await flush()
    resolve(records); await flush()
    expect(root.querySelector('.job-related-records')).toBeNull()
  })
  it('requires confirmation and cancel does not delete', async () => {
    await mount(); await openDelete()
    expect(root.querySelector('[role=dialog]')?.textContent).toContain('人事测试岗位')
    expect(root.querySelector('[role=dialog]')?.textContent).toContain('候选人、简历及面试资料不会被自动删除')
    expect(deleteJob).not.toHaveBeenCalled()
    button('取消').click(); await flush()
    expect(root.querySelector('[role=dialog]')).toBeNull()
    expect(deleteJob).not.toHaveBeenCalled()
  })
  it('可直接解除导入关联，刷新后继续删除岗位，不删除候选人', async () => {
    blocked(); vi.mocked(loadJobRelatedRecords).mockResolvedValueOnce([records[1]!]).mockResolvedValueOnce([])
    vi.mocked(detachResumeImportJob).mockResolvedValue({} as never)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount(); await openDelete(); button('确认删除').click(); await flush()
    button('解除岗位关联').click(); await flush()
    expect(detachResumeImportJob).toHaveBeenCalledWith('batch-1')
    expect(deleteApplication).not.toHaveBeenCalled()
    expect(root.textContent).not.toContain('该岗位存在关联业务记录')
    expect(root.querySelector('.job-related-records')?.textContent).toContain('可以继续删除岗位')
    root.querySelector<HTMLButtonElement>('.job-related-records .btn-danger')!.click(); await flush()
    expect(root.querySelector('[role=dialog]')?.textContent).toContain('删除岗位')
    confirm.mockRestore()
  })
  for (const candidateDeleted of [false, true]) {
    it('删除关联申请后按实际清理结果反馈 ' + candidateDeleted, async () => {
      blocked()
      vi.mocked(loadJobRelatedRecords).mockResolvedValueOnce([records[0]!]).mockResolvedValueOnce([])
      vi.mocked(deleteApplication).mockResolvedValue({ candidateDeleted })
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      try {
        await mount(); await openDelete(); button('确认删除').click(); await flush()
        button('删除申请').click(); await flush()
        expect(confirm).toHaveBeenCalledWith(expect.stringContaining('最后一条申请'))
        expect(deleteApplication).toHaveBeenCalledExactlyOnceWith('application-1')
        expect(root.textContent).toContain(candidateDeleted
          ? '申请、候选人档案及相关资料已一并删除。'
          : '申请及专属资料已删除，其他岗位申请及共用资料已保留。')
        expect(root.querySelector('.job-related-records')?.textContent).toContain('可以继续删除岗位')
      } finally { confirm.mockRestore() }
    })
  }
  it('可直接删除指定申请，失败时保留关联列表并展示原因', async () => {
    blocked(); vi.mocked(loadJobRelatedRecords).mockResolvedValue(records)
    vi.mocked(deleteApplication).mockRejectedValue(new Error('此岗位申请已有面试记录，不能直接删除'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount(); await openDelete(); button('确认删除').click(); await flush()
    button('删除申请').click(); await flush()
    expect(deleteApplication).toHaveBeenCalledWith('application-1')
    expect(root.querySelector('.job-related-records [role=alert]')?.textContent).toContain('已有面试记录')
    expect(root.querySelectorAll('.job-related-records tbody tr')).toHaveLength(2)
    confirm.mockRestore()
  })
  it('sends the entity id, prevents duplicate requests and removes the row after success', async () => {
    let resolve!: () => void
    vi.mocked(deleteJob).mockImplementation(() => new Promise<void>(done => { resolve = done }))
    await mount(); await openDelete()
    const confirm = button('确认删除'); confirm.click(); confirm.click(); await flush()
    expect(deleteJob).toHaveBeenCalledTimes(1)
    expect(deleteJob).toHaveBeenCalledWith('job-uuid')
    expect(button('删除中...').disabled).toBe(true)
    expect(button('取消').disabled).toBe(true)
    expect(root.querySelector('tbody')?.textContent).toContain(job.title)
    resolve(); await flush()
    expect(root.querySelector('[role=dialog]')).toBeNull()
    expect(root.querySelector('tbody')?.textContent).not.toContain(job.title)
    expect(root.textContent).toContain('已删除')
  })
  it('retains the row and shows the server error for associated applications', async () => {
    vi.mocked(deleteJob).mockRejectedValue(new Error('该岗位已有候选人申请记录，不能直接删除'))
    await mount(); await openDelete(); button('确认删除').click(); await flush()
    expect(root.querySelector('[role=alert]')?.textContent).toContain('该岗位已有候选人申请记录')
    expect(root.querySelector('tbody')?.textContent).toContain(job.title)
    expect(button('确认删除').disabled).toBe(false)
    button('取消').click(); await flush()
    expect(root.querySelector('[role=dialog]')).toBeNull()
  })
  for (const role of ['hiring_manager', 'interviewer', 'approver']) {
    it(`hides the delete entry for ${role}`, async () => {
      await mount(role)
      expect(button('删除岗位')).toBeUndefined()
      expect(deleteJob).not.toHaveBeenCalled()
    })
  }
  for (const role of ['admin', 'hr_admin']) {
    it(`allows ${role} to open confirmation`, async () => {
      await mount(role); await openDelete()
      expect(root.querySelector('[role=dialog]')).not.toBeNull()
    })
  }
})
