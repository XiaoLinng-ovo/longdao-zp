// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ApplicationCreateDialog from './ApplicationCreateDialog.vue'
import { analyzeResumeForApplication, createApplication, getCandidate, loadApplications } from '../api'
import { ApiResponseError } from '../../../shared/api/errors'
import type { ApiApplication, ApiCandidateDetail } from '../api'

vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(),
  getCandidate: vi.fn(), loadApplications: vi.fn(), createApplication: vi.fn(), analyzeResumeForApplication: vi.fn(),
}))
let app: App | undefined, root: HTMLDivElement | undefined
const existing: ApiApplication = { id: 'app-old', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing', aiStatus: 'completed', updatedAt: '2026-10-08',
  resumeReview: { resultId: 'result-old', aiScore: 88, humanScore: 85, finalScore: 86.2, decision: 'passed', talentPool: false, history: [], evidence: [], risks: [], strengths: [] } }
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })
async function mount(applications: ApiApplication[] = [existing], canArrange = true) {
  const arrange = vi.fn()
  vi.mocked(getCandidate).mockResolvedValue({ id: 'candidate-1', code: 'CAN-1', fullName: '测试候选人', applications, resumes: [], analysisResults: [], analysisTasks: [], jobs: [] } as unknown as ApiCandidateDetail)
  vi.mocked(loadApplications).mockResolvedValue(applications)
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(ApplicationCreateDialog, { initialCandidateId: 'candidate-1', canArrange,
    candidates: [{ id: 'CAN-1', entityId: 'candidate-1', name: '测试候选人' }],
    jobs: [{ id: 'JOB-1', entityId: 'job-1', title: '算法工程师' }, { id: 'JOB-2', entityId: 'job-2', title: '产品经理' }], onArrange: arrange })
  app.mount(root); await flush()
  await selectJob('job-1')
  return arrange
}
async function selectJob(id: string) { const select = root!.querySelector<HTMLSelectElement>('#application-job')!; select.value = id; select.dispatchEvent(new Event('change')); await flush() }
function button(text: string) { return [...root!.querySelectorAll('button')].find(item => item.textContent?.trim() === text) }
describe('duplicate application next-step guidance', () => {
  it('keeps the original scores and schedules with the existing application', async () => {
    const arrange = await mount()
    expect(root!.textContent).toContain('无需重复创建')
    expect(button('仅创建申请')!.disabled).toBe(true)
    button('使用已有申请安排面试')!.click(); await flush()
    expect(arrange).toHaveBeenCalledWith('app-old')
    expect(createApplication).not.toHaveBeenCalled()
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(existing.resumeReview?.finalScore).toBe(86.2)
  })
  it('clears duplicate guidance when a different job is selected and allows creating that application', async () => {
    await mount(); await selectJob('job-2')
    expect(button('使用已有申请安排面试')).toBeUndefined()
    vi.mocked(createApplication).mockResolvedValue({ ...existing, id: 'app-new', jobId: 'job-2' })
    button('仅创建申请')!.click(); await flush()
    expect(createApplication).toHaveBeenCalledWith({ candidateId: 'candidate-1', jobId: 'job-2', source: undefined })
  })
  it('does not expose schedule to a user without interview write permission', async () => {
    await mount([existing], false)
    expect(button('使用已有申请安排面试')).toBeUndefined()
  })
  it('recovers the existing application after a concurrent creation conflict', async () => {
    await mount([])
    vi.mocked(loadApplications).mockResolvedValueOnce([]).mockResolvedValueOnce([existing])
    vi.mocked(createApplication).mockRejectedValue(new ApiResponseError('此岗位已有申请', { code: 'APPLICATION_ALREADY_EXISTS', status: 409 }))
    button('仅创建申请')!.click(); await flush()
    expect(root!.querySelector('[role=alert]')?.textContent).toContain('此岗位已有申请')
    expect(button('使用已有申请安排面试')).toBeTruthy()
    expect(createApplication).toHaveBeenCalledTimes(1)
  })
})
