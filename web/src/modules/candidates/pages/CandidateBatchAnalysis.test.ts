// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import { authSession } from '../../auth/session'
import { analyzeResumeForApplication, createApplication, deleteApplication, getApplicationResume, getCandidate, loadCandidateTags, loadCandidates, loadJobs } from '../api'
import type { ApiAnalysisTask, ApiApplication, ApiCandidateDetail, ApiResume } from '../api'
import type { Candidate } from '../../../shared/types/recruiting'

vi.mock('../api', async (original) => ({
  ...await original<typeof import('../api')>(),
  analyzeResumeForApplication: vi.fn(), getApplicationResume: vi.fn(), getCandidate: vi.fn(),
  createApplication: vi.fn(), deleteApplication: vi.fn(),
  loadCandidateTags: vi.fn(), loadCandidates: vi.fn(), loadJobs: vi.fn(),
}))
const first: Candidate = { id: 'CAN-1', entityId: 'candidate-1', name: '王强', job: '人事', applicationId: 'application-1', rawApplicationStatus: 'pending_analysis', score: 0, aiStatus: 'pending', analysisStatus: 'failed', analysisError: '旧错误', applicationStatus: 'pending', updatedAt: '2026-11-20' }
const second: Candidate = { ...first, applicationId: 'application-2', job: '工程师' }
const orphan: Candidate = { ...first, id: 'CAN-2', entityId: 'candidate-2', applicationId: undefined, name: '李明', job: '未关联岗位' }
const application = (row: Candidate): ApiApplication => ({ id: row.applicationId!, candidateId: row.entityId!, jobId: row.job, status: row.rawApplicationStatus!, aiStatus: row.aiStatus, analysisStatus: row.analysisStatus, updatedAt: row.updatedAt })
const resume = (id: string): ApiResume => ({ id: 'resume-' + id, candidateId: 'candidate-1', applicationId: id, originalFilename: id + '.pdf', mimeType: 'application/pdf', sizeBytes: 100, contentHash: 'hash', scanStatus: 'clean', createdAt: '2026-11-20' })
const task = (id: string): ApiAnalysisTask => ({ id: 'task-' + id, applicationId: id, resumeId: 'resume-' + id, status: 'queued', attempts: 0 })
let app: App | undefined
let root: HTMLDivElement
let stored: Candidate[]
let detail: ApiCandidateDetail
async function flush() { for (let i = 0; i < 30; i++) { await Promise.resolve(); await nextTick() } }
async function mount(expand = true) {
  root = document.createElement('div'); document.body.appendChild(root)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
  app = createApp(CandidateListPage); app.use(router); app.mount(root); await flush()
  if (expand) root.querySelector<HTMLButtonElement>('.applications-toggle')?.click()
  await flush()
}
const batch = () => root.querySelector<HTMLButtonElement>('.batch-analyze-button')!
async function selectAll() { root.querySelector<HTMLInputElement>('thead input')!.click(); await flush() }
const summary = () => root.querySelector('.success-note')?.textContent
const notes = () => root.querySelector('.batch-analysis-results')?.textContent
beforeEach(() => {
  authSession.user = { id: 'u1', name: '企业用户', email: 'test@example.invalid', role: 'admin', departmentId: 'dept', workspaceId: 'org' }
  stored = [{ ...first, applicationRows: [first, second] }, orphan]
  detail = { id: 'candidate-1', code: 'CAN-1', fullName: '王强', status: 'active', createdAt: '2026-11-20', updatedAt: '2026-11-20', applications: [application(first), application(second)], resumes: [resume('application-2'), resume('application-1')], analysisTasks: [], analysisResults: [], jobs: [] }
  vi.mocked(loadCandidates).mockImplementation(async () => stored)
  vi.mocked(loadJobs).mockResolvedValue([]); vi.mocked(loadCandidateTags).mockResolvedValue([])
  vi.mocked(getCandidate).mockImplementation(async () => detail)
  vi.mocked(getApplicationResume).mockImplementation(async id => resume(id))
  vi.mocked(analyzeResumeForApplication).mockImplementation(async (_candidate, _resume, id) => task(id))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks(); vi.restoreAllMocks(); authSession.user = null; localStorage.clear(); vi.useRealTimers() })
describe('candidate batch analysis', () => {
  it('queues each selected application with its own linked resume, not the newest sibling file', async () => {
    await mount(); expect(batch().disabled).toBe(true)
    await selectAll(); batch().click(); await flush()
    expect(getApplicationResume).toHaveBeenCalledWith('application-1')
    expect(analyzeResumeForApplication).toHaveBeenNthCalledWith(1, 'candidate-1', 'resume-application-1', 'application-1')
    expect(analyzeResumeForApplication).toHaveBeenNthCalledWith(2, 'candidate-1', 'resume-application-2', 'application-2')
    expect(createApplication).not.toHaveBeenCalled()
    expect(summary()).toContain('已提交 2 条，跳过 1 条，失败 0 条')
    expect(notes()).toContain('未关联岗位')
    expect(root.querySelectorAll('tbody input:checked')).toHaveLength(1)
    expect([...root.querySelectorAll('tbody tr')].slice(0, 2).every(row => !row.textContent?.includes('旧错误'))).toBe(true)
    expect(loadCandidates).toHaveBeenCalledTimes(1)
  })
  it('does nothing when confirmation is cancelled', async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    await mount(); await selectAll(); batch().click(); await flush()
    expect(getCandidate).not.toHaveBeenCalled(); expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(root.querySelectorAll('tbody input:checked')).toHaveLength(3)
  })
  it('continues after a submission fails and keeps failed selections for retry', async () => {
    vi.mocked(analyzeResumeForApplication).mockRejectedValueOnce(new Error('企业 AI 配置不可用'))
    await mount(); await selectAll(); batch().click(); await flush()
    expect(analyzeResumeForApplication).toHaveBeenCalledTimes(2)
    expect(summary()).toContain('已提交 1 条，跳过 1 条，失败 1 条')
    expect(notes()).toContain('失败 · 王强 · 人事：企业 AI 配置不可用')
    expect(root.querySelectorAll('tbody input:checked')).toHaveLength(2)
  })
  it('skips busy tasks using fresh detail even if the list still says failed', async () => {
    detail.analysisTasks = [{ ...task('application-1'), status: 'processing' }]
    await mount(); await selectAll(); batch().click(); await flush()
    expect(analyzeResumeForApplication).toHaveBeenCalledExactlyOnceWith('candidate-1', 'resume-application-2', 'application-2')
    expect(summary()).toContain('已提交 1 条，跳过 2 条，失败 0 条')
    expect(notes()).toContain('已排队或正在解析')
  })
  it('skips locally busy and advanced applications without submitting them', async () => {
    stored = [{ ...first, analysisStatus: 'queued' }, { ...second, entityId: 'candidate-3', id: 'CAN-3' }]
    detail.id = 'candidate-3'; detail.applications = [{ ...application(second), candidateId: 'candidate-3', status: 'interviewing' }]
    await mount(); await selectAll(); batch().click(); await flush()
    expect(getCandidate).toHaveBeenCalledTimes(1); expect(getApplicationResume).not.toHaveBeenCalled()
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(summary()).toContain('已提交 0 条，跳过 2 条，失败 0 条')
    expect(notes()).toContain('后续流程')
  })
  it('reports missing and unsafe resumes without silently borrowing another application file', async () => {
    vi.mocked(getApplicationResume).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...resume('application-2'), scanStatus: 'infected' })
    await mount(); await selectAll(); batch().click(); await flush()
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(summary()).toContain('已提交 0 条，跳过 3 条，失败 0 条')
    expect(notes()).toContain('没有关联的简历'); expect(notes()).toContain('安全检查')
  })
  it('rejects missing applications and mismatched candidate files', async () => {
    detail.applications = [application(second)]
    vi.mocked(getApplicationResume).mockResolvedValue({ ...resume('application-2'), candidateId: 'other-company-candidate' })
    await mount(); await selectAll(); batch().click(); await flush()
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(summary()).toContain('已提交 0 条，跳过 1 条，失败 2 条')
    expect(notes()).toContain('无权访问'); expect(notes()).toContain('候选人不一致')
  })
  it('allows reanalysis of completed screening results while leaving unselected siblings unchanged', async () => {
    stored = [{ ...first, aiStatus: 'completed', analysisStatus: 'completed', rawApplicationStatus: 'human_review', applicationRows: [{ ...first, aiStatus: 'completed', analysisStatus: 'completed', rawApplicationStatus: 'human_review' }, second] }]
    detail.applications[0]!.status = 'human_review'
    await mount(false); await selectAll(); batch().click(); await flush()
    expect(analyzeResumeForApplication).toHaveBeenCalledExactlyOnceWith('candidate-1', 'resume-application-1', 'application-1')
    root.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await flush()
    expect(root.querySelector('tbody')?.textContent).toContain('旧错误')
  })
  it('locks selection, deletion and individual parsing until the batch has finished', async () => {
    let finish!: (value: ApiAnalysisTask) => void
    vi.mocked(analyzeResumeForApplication).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await mount(); await selectAll(); batch().click(); await flush()
    expect(batch().disabled).toBe(true)
    expect(root.querySelector<HTMLButtonElement>('.batch-delete-button')!.disabled).toBe(true)
    expect(root.querySelector<HTMLInputElement>('thead input')!.disabled).toBe(true)
    expect([...root.querySelectorAll<HTMLButtonElement>('.analyze-button, .delete-button')].every(button => button.disabled)).toBe(true)
    batch().click(); root.querySelector<HTMLButtonElement>('.batch-delete-button')!.click(); await flush()
    expect(analyzeResumeForApplication).toHaveBeenCalledTimes(1); expect(deleteApplication).not.toHaveBeenCalled()
    finish(task('application-1')); await flush()
    expect(analyzeResumeForApplication).toHaveBeenCalledTimes(2)
  })
  it('does not submit old selections after switching enterprise while a read is in flight', async () => {
    let finish!: (value: ApiCandidateDetail) => void
    vi.mocked(getCandidate).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await mount(); await selectAll(); batch().click(); await flush()
    authSession.user = { ...authSession.user!, workspaceId: 'another-org' }
    finish(detail); await flush()
    expect(analyzeResumeForApplication).not.toHaveBeenCalled(); expect(getCandidate).toHaveBeenCalledTimes(1)
    expect(summary()).toBeUndefined()
  })
  it('polls queued applications with the shared list refresh and cannot submit them twice', async () => {
    vi.useFakeTimers()
    await mount(); await selectAll(); batch().click(); await flush()
    await selectAll(); batch().click(); await flush()
    expect(analyzeResumeForApplication).toHaveBeenCalledTimes(2)
    stored = stored.map(row => row.applicationRows ? { ...row, analysisStatus: 'completed', applicationRows: row.applicationRows.map(item => ({ ...item, analysisStatus: 'completed' })) } : row)
    await vi.advanceTimersByTimeAsync(5000); await flush()
    expect(loadCandidates).toHaveBeenCalledTimes(2)
  })
  it('hides bulk parsing outside an enterprise', async () => {
    authSession.user = { ...authSession.user!, workspaceId: undefined }
    await mount(); expect(root.querySelector('.batch-analyze-button')).toBeNull()
  })
})
