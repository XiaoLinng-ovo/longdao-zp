// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import JobListPage from './JobListPage.vue'
import { deleteJob, loadJobs, type JobView } from '../api'
import { authSession } from '../../auth/session'
import { loadDepartments } from '../../requisitions/api'

vi.mock('../api', () => ({ loadJobs: vi.fn(), createJob: vi.fn(), jobAction: vi.fn(), deleteJob: vi.fn() }))
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
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/jobs', component: { template: '<div />' } }] })
  await router.push('/jobs')
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(JobListPage); app.use(router); app.mount(root); await flush()
}
function button(text: string) { return [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === text)! }
async function openDelete() { button('删除岗位').click(); await flush() }
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

describe('岗位删除', () => {
  it('requires confirmation and cancel does not delete', async () => {
    await mount(); await openDelete()
    expect(root.querySelector('[role=dialog]')?.textContent).toContain('人事测试岗位')
    expect(root.querySelector('[role=dialog]')?.textContent).toContain('候选人、简历及面试资料不会被自动删除')
    expect(deleteJob).not.toHaveBeenCalled()
    button('取消').click(); await flush()
    expect(root.querySelector('[role=dialog]')).toBeNull()
    expect(deleteJob).not.toHaveBeenCalled()
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
