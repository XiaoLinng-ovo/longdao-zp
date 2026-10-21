// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateDetailPage from './CandidateDetailPage.vue'
import { analyzeResumeForApplication, getAnalysisTask, getCandidate, getResumeDocument, processAnalysisTask, reanalyzeResume, type ApiCandidateDetail } from '../api'

vi.mock('../api', async (original) => ({
  ...await original<typeof import('../api')>(),
  getCandidate: vi.fn(), getAnalysisTask: vi.fn(), processAnalysisTask: vi.fn(),
  getResumeDocument: vi.fn(),
  analyzeResumeForApplication: vi.fn(), reanalyzeResume: vi.fn(),
}))
let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks(); vi.useRealTimers() })
function fixture(): ApiCandidateDetail {
  return {
    id: 'candidate-1', code: 'CAN-1', fullName: '多岗位测试候选人', status: 'active', createdAt: '2026-10-01', updatedAt: '2026-10-08',
    jobs: [{ id: 'job-1', code: 'J1', title: '前端工程师' }, { id: 'job-2', code: 'J2', title: '后端工程师' }],
    applications: ['1', '2'].map(id => ({ id: `application-${id}`, candidateId: 'candidate-1', jobId: `job-${id}`, status: 'human_review', aiStatus: 'completed', updatedAt: '2026-10-08' })),
    resumes: [{ id: 'resume-1', candidateId: 'candidate-1', applicationId: 'application-1', originalFilename: '共用简历.pdf', mimeType: 'application/pdf', sizeBytes: 100, contentHash: 'hash', scanStatus: 'clean', createdAt: '2026-10-01' }],
    analysisTasks: ['1', '2'].map(id => ({ id: `task-${id}`, resumeId: 'resume-1', applicationId: `application-${id}`, status: 'completed', attempts: 1, createdAt: `2026-10-0${id}` })),
    analysisResults: ['1', '2'].map(id => ({ id: `result-${id}`, analysisTaskId: `task-${id}`, resumeId: 'resume-1', applicationId: `application-${id}`, analyzerVersion: 'test', inputHash: 'hash', humanReviewStatus: 'pending', createdAt: `2026-10-0${id}`, result: { assessment: { score: id === '1' ? 91 : 62, strengths: [`岗位${id}独立评分依据`], matchedRequirements: [{ label: `岗位${id}独立评分依据`, rationale: `岗位${id}的详细评分依据`, evidence: [{ sourceText: `岗位${id}简历证据` }] }] } } })),
  }
}
async function mount(detail = fixture(), applicationId = 'application-1') {
  vi.mocked(getCandidate).mockResolvedValue(detail)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/candidates/:id', component: { template: '<div />' } }] })
  await router.push({ path: '/candidates/candidate-1', query: { applicationId } }); await router.isReady()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(CandidateDetailPage); app.use(router); app.mount(root); await flush()
}
function scoreText() { return root!.querySelector('.resume-review-panel')?.textContent || '' }
async function select(id: string) {
  const picker = root!.querySelector<HTMLSelectElement>('#detail-application')!
  picker.value = id; picker.dispatchEvent(new Event('change', { bubbles: true })); await flush()
}

describe('candidate detail application context', () => {
  it('places original-document access directly after reanalysis without starting a task', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() {} })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() {} })
    vi.mocked(getResumeDocument).mockRejectedValue(new Error('Preview test'))
    await mount(fixture(), 'application-2')
    const buttons = [...root!.querySelectorAll<HTMLButtonElement>('.resume-actions button')]
    expect(buttons.map(item => item.textContent?.trim())).toEqual(['重新解析', '查看原文档'])
    buttons[1]!.click(); await flush()
    expect(getResumeDocument).toHaveBeenCalledWith('candidate-1', 'resume-1')
    expect(reanalyzeResume).not.toHaveBeenCalled()
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    await select('application-1')
    expect(root!.querySelector('dialog')).toBeNull()
  })
  it('reopens a running task by observing it, without enqueuing or invoking inline scoring', async () => {
    vi.useFakeTimers()
    const detail = fixture(); detail.analysisTasks[0] = { ...detail.analysisTasks[0], status: 'processing' }
    vi.mocked(getAnalysisTask).mockResolvedValue(detail.analysisTasks[0])
    await mount(detail)
    expect(getAnalysisTask).toHaveBeenCalledWith('task-1')
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(reanalyzeResume).not.toHaveBeenCalled()
    expect(processAnalysisTask).not.toHaveBeenCalled()
    expect([...root!.querySelectorAll('button')].find(item => item.textContent?.includes('解析中'))?.disabled).toBe(true)
    const refreshed = fixture()
    vi.mocked(getCandidate).mockResolvedValue(refreshed)
    vi.mocked(getAnalysisTask).mockResolvedValue(refreshed.analysisTasks[0])
    await vi.advanceTimersByTimeAsync(3000); await flush()
    expect(root!.querySelector('.analysis-status')?.textContent).toContain('解析完成')
    expect(scoreText()).toContain('91')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps completed and failed records unchanged on reopening until a manual retry', async () => {
    vi.useFakeTimers()
    const detail = fixture(); detail.analysisTasks[0] = { ...detail.analysisTasks[0], status: 'failed', lastError: '大模型语义评分超时，本次解析已停止' }
    await mount(detail)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); await flush()
    expect(getAnalysisTask).not.toHaveBeenCalled()
    expect(reanalyzeResume).not.toHaveBeenCalled()
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(processAnalysisTask).not.toHaveBeenCalled()
    expect(root!.querySelector('.analysis-status')?.textContent).toContain('解析失败')
    expect(scoreText()).toContain('91')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('opens the requested application and switches between independent scores and evidence', async () => {
    await mount()
    expect(scoreText()).toContain('91')
    expect(scoreText()).toContain('岗位1独立评分依据')
    expect(scoreText()).not.toContain('岗位2独立评分依据')
    await select('application-2')
    expect(scoreText()).toContain('62')
    expect(scoreText()).toContain('岗位2独立评分依据')
    expect(scoreText()).not.toContain('岗位1独立评分依据')
    await select('')
    expect(scoreText()).toContain('岗位2独立评分依据')
  })
  it('never substitutes another application score when the selected one has no result', async () => {
    const detail = fixture(); detail.analysisResults = detail.analysisResults.slice(0, 1)
    await mount(detail, 'application-2')
    expect(root!.querySelector('.resume-review-panel')).toBeNull()
    expect(root!.textContent).toContain('暂无岗位匹配评分')
    expect(root!.textContent).not.toContain('岗位1独立评分依据')
    expect(root!.textContent).toContain('共用简历.pdf')
  })
  it('parses a new application with zero tasks using the candidate resume without borrowing an old score', async () => {
    const detail = fixture()
    detail.analysisTasks = detail.analysisTasks.slice(0, 1)
    detail.analysisResults = detail.analysisResults.slice(0, 1)
    detail.applications[1] = { ...detail.applications[1], status: 'pending_analysis', aiStatus: 'pending' }
    await mount(detail, 'application-2')
    expect(root!.querySelector('.resume-review-panel')).toBeNull()
    expect(root!.textContent).not.toContain('岗位1独立评分依据')
    expect(root!.textContent).toContain('共用简历.pdf')
    const button = [...root!.querySelectorAll('button')].find((item) => item.textContent?.trim() === '解析简历')!
    expect(button.disabled).toBe(false)
    vi.mocked(analyzeResumeForApplication).mockResolvedValue({ id: 'new-task', resumeId: 'resume-1', applicationId: 'application-2', status: 'queued', attempts: 0 })
    vi.mocked(getAnalysisTask).mockResolvedValue({ id: 'new-task', resumeId: 'resume-1', applicationId: 'application-2', status: 'completed', attempts: 1 })
    button.click(); await flush()
    expect(analyzeResumeForApplication).toHaveBeenCalledWith('candidate-1', 'resume-1', 'application-2')
    expect(reanalyzeResume).not.toHaveBeenCalled()
  })
  it('reanalyses a reused resume for the selected application without changing its original application', async () => {
    await mount(fixture(), 'application-2')
    vi.mocked(analyzeResumeForApplication).mockResolvedValue({ id: 'new-task', resumeId: 'resume-1', applicationId: 'application-2', status: 'queued', attempts: 0 })
    vi.mocked(getAnalysisTask).mockResolvedValue({ id: 'new-task', resumeId: 'resume-1', applicationId: 'application-2', status: 'completed', attempts: 1 })
    const button = [...root!.querySelectorAll('button')].find(item => item.textContent?.trim() === '重新解析')!
    button.click(); await flush()
    expect(analyzeResumeForApplication).toHaveBeenCalledWith('candidate-1', 'resume-1', 'application-2')
    expect(reanalyzeResume).not.toHaveBeenCalled()
    expect(getCandidate).toHaveBeenCalledTimes(2)
    expect(processAnalysisTask).not.toHaveBeenCalled()
  })
})


describe('candidate reanalysis job configuration failures', () => {
  it('shows a useful explanation for a historical failed task while preserving the previous score', async () => {
    const detail = fixture()
    detail.analysisTasks.push({ id: 'failed-task', resumeId: 'resume-1', applicationId: 'application-1', status: 'failed', attempts: 3, lastError: 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH: 企业归属不一致', createdAt: '2026-10-09' })
    await mount(detail)
    expect(root!.querySelector('.analysis-status')?.textContent).toContain('岗位评分配置异常')
    expect(root!.textContent).toContain('无需重新上传')
    expect(root!.textContent).toContain('上一次成功解析的结果')
    expect(root!.textContent).not.toContain('JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH')
    expect(scoreText()).toContain('91')
  })
  it('presents an enqueue preflight error without polling or overwriting a successful report', async () => {
    await mount(fixture(), 'application-2')
    vi.mocked(analyzeResumeForApplication).mockRejectedValue(Object.assign(new Error('企业归属不一致'), { code: 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH', status: 409 }))
    const button = [...root!.querySelectorAll('button')].find(item => item.textContent?.trim() === '重新解析')!
    button.click(); await flush()
    expect(root!.textContent).toContain('无需重新上传')
    expect(root!.textContent).not.toContain('JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH')
    expect(button.disabled).toBe(false)
    expect(getAnalysisTask).not.toHaveBeenCalled()
    expect(processAnalysisTask).not.toHaveBeenCalled()
    expect(root!.querySelector('.analysis-status')?.textContent).toContain('任务未启动')
    expect(root!.querySelector('.analysis-status')?.classList.contains('status-failed')).toBe(true)
    expect(root!.textContent).toContain('上一次成功解析的结果')
    expect(scoreText()).toContain('62')
  })
})


describe('reanalysis Worker failure recovery', () => {
  it('formats a polled Worker configuration failure and keeps the prior report visible', async () => {
    await mount(fixture(), 'application-2')
    const failed = { id: 'failed-task', resumeId: 'resume-1', applicationId: 'application-2', status: 'failed' as const, attempts: 1, lastError: 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH: 企业归属不一致', createdAt: '2026-10-09' }
    const refreshed = fixture(); refreshed.analysisTasks.push(failed)
    vi.mocked(getCandidate).mockResolvedValue(refreshed)
    vi.mocked(analyzeResumeForApplication).mockResolvedValue({ ...failed, status: 'queued', attempts: 0 })
    vi.mocked(getAnalysisTask).mockResolvedValue(failed)
    const button = [...root!.querySelectorAll('button')].find(item => item.textContent?.trim() === '重新解析')!
    button.click(); await flush()
    expect(root!.textContent).toContain('本次 AI 评分未执行')
    expect(root!.textContent).not.toContain('JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH')
    expect(root!.textContent).toContain('上一次成功解析的结果')
    expect(scoreText()).toContain('62')
    expect(button.disabled).toBe(false)
  })
})
