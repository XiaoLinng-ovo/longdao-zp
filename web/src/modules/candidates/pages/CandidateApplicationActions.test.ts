// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import { authSession } from '../../auth/session'
import { deleteApplication, deleteCandidate, getCandidate, loadCandidateTags, loadCandidates, loadJobs, type ApiCandidateDetail } from '../api'
import type { Candidate } from '../../../shared/types/recruiting'

vi.mock('../api', async (original) => ({
  ...await original<typeof import('../api')>(),
  deleteApplication: vi.fn(), deleteCandidate: vi.fn(), getCandidate: vi.fn(),
  loadCandidateTags: vi.fn(), loadCandidates: vi.fn(), loadJobs: vi.fn(),
}))
const pending: Candidate = { id: 'CAN-1', entityId: 'candidate-1', name: '王强', job: '人事', applicationId: 'application-1', rawApplicationStatus: 'pending_analysis', score: 0, aiStatus: 'pending', applicationStatus: 'pending', updatedAt: '2026-10-08' }
const sibling: Candidate = { ...pending, applicationId: 'application-2', job: '算法工程师', rawApplicationStatus: 'rejected', aiStatus: 'completed', score: 85, applicationStatus: 'rejected' }
let app: App | undefined
let root: HTMLDivElement
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
async function mount() {
  root = document.createElement('div'); document.body.appendChild(root)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  app = createApp(CandidateListPage); app.use(router); app.mount(root); await flush()
}
async function expand() { root.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await flush() }
beforeEach(() => {
  authSession.user = { id: 'u1', name: '管理员', email: 'test@example.com', role: 'admin', departmentId: 'd1' }
  vi.mocked(loadCandidates).mockResolvedValue([{ ...pending, applicationRows: [pending, sibling] }])
  vi.mocked(loadJobs).mockResolvedValue([])
  vi.mocked(loadCandidateTags).mockResolvedValue([])
  vi.mocked(deleteApplication).mockResolvedValue()
})
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks(); vi.restoreAllMocks(); authSession.user = null })
describe('candidate application actions', () => {
  it('deletes only the selected child application and retains the candidate with its remaining application', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount(); await expand()
    vi.mocked(loadCandidates).mockResolvedValue([pending])
    root.querySelectorAll<HTMLButtonElement>('.delete-button')[1].click(); await flush()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('王强 · 算法工程师'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('其他岗位申请保持不变'))
    expect(deleteApplication).toHaveBeenCalledOnce()
    expect(deleteApplication).toHaveBeenCalledWith('application-2')
    expect(deleteCandidate).not.toHaveBeenCalled()
    expect(root.querySelector('.name-link')?.textContent).toBe('王强')
    expect(root.querySelector('tbody')?.textContent).toContain('人事')
    expect(root.querySelector('tbody')?.textContent).not.toContain('算法工程师')
  })
  it('deletes only the selected main application and preserves its sibling score', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mount()
    vi.mocked(loadCandidates).mockResolvedValue([sibling])
    root.querySelector<HTMLButtonElement>('.delete-button')!.click(); await flush()
    expect(deleteApplication).toHaveBeenCalledWith('application-1')
    expect(deleteCandidate).not.toHaveBeenCalled()
    expect(root.querySelector('tbody')?.textContent).toContain('算法工程师')
    expect(root.querySelector('tbody')?.textContent).toContain('85')
  })
  it('does not call either delete API on cancellation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mount(); await expand()
    root.querySelectorAll<HTMLButtonElement>('.delete-button')[1].click(); await flush()
    expect(deleteApplication).not.toHaveBeenCalled(); expect(deleteCandidate).not.toHaveBeenCalled()
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
  })
  it('preserves both applications if the server rejects deletion', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(deleteApplication).mockRejectedValue(new Error('此岗位申请已有面试记录'))
    await mount(); await expand()
    root.querySelectorAll<HTMLButtonElement>('.delete-button')[1].click(); await flush()
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(root.querySelector('.error-note')?.textContent).toContain('已有面试记录')
    expect(deleteCandidate).not.toHaveBeenCalled()
  })
  it('keeps the candidate file entry when deleting its last application', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(loadCandidates).mockResolvedValue([pending])
    await mount()
    vi.mocked(loadCandidates).mockResolvedValue([{ ...pending, job: '未关联岗位', applicationId: undefined }])
    root.querySelector<HTMLButtonElement>('.delete-button')!.click(); await flush()
    expect(root.querySelector('.name-link')?.textContent).toBe('王强')
    expect(root.querySelector('tbody')?.textContent).toContain('未关联岗位')
    expect(deleteCandidate).not.toHaveBeenCalled()
  })
  it('opens analysis for the chosen existing application with its job already selected', async () => {
    vi.mocked(loadJobs).mockResolvedValue([{ id: 'JOB-1', entityId: 'job-1', title: '人事', department: '人事部', status: 'published', statusLabel: '招聘中', recruitmentRequestId: '', headcount: 1, filledCount: 0, channels: [], updatedAt: '2026-10-08' }])
    vi.mocked(getCandidate).mockResolvedValue({ id: 'candidate-1', code: 'CAN-1', fullName: '王强', status: 'active', createdAt: '2026-10-01', updatedAt: '2026-10-08', applications: [{ id: 'application-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'pending_analysis', aiStatus: 'pending', updatedAt: '2026-10-08' }], resumes: [{ id: 'resume', candidateId: 'candidate-1', originalFilename: '共用简历.pdf', mimeType: 'application/pdf', sizeBytes: 1, contentHash: 'hash', scanStatus: 'clean', createdAt: '2026-10-08' }], analysisTasks: [], analysisResults: [], jobs: [] } satisfies ApiCandidateDetail)
    await mount()
    const button = [...root.querySelectorAll('button')].find((item) => item.textContent === '解析简历')!
    button.click(); await flush()
    expect(getCandidate).toHaveBeenCalledWith('candidate-1')
    expect(root.querySelector<HTMLSelectElement>('#application-job')?.value).toBe('job-1')
    expect(root.querySelector('.saved-note')?.textContent).toContain('不会重复创建')
    expect(root.querySelector<HTMLButtonElement>('.application-footer .btn-primary')?.disabled).toBe(false)
  })
})
