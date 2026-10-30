// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ApplicationCreateDialog from './ApplicationCreateDialog.vue'
import { analyzeResumeForApplication, createApplication, getCandidate, loadApplications, uploadResume, type ApiCandidateDetail } from '../api'

vi.mock('../api', () => ({ analyzeResumeForApplication: vi.fn(), createApplication: vi.fn(), getCandidate: vi.fn(), loadApplications: vi.fn(), uploadResume: vi.fn() }))
let app: App | undefined
let root: HTMLDivElement
const onCreated = vi.fn(), onChanged = vi.fn(), onView = vi.fn(), onClose = vi.fn()
const oldApplication = { id: 'old-app', candidateId: 'candidate-1', jobId: 'job-1', status: 'rejected', aiStatus: 'completed', updatedAt: '2026-10-01' }
const newApplication = { id: 'new-app', candidateId: 'candidate-1', jobId: 'job-2', status: 'pending_analysis', aiStatus: 'pending', updatedAt: '2026-10-08' }
function candidateDetail(): ApiCandidateDetail {
  return { id: 'candidate-1', code: 'CAN-1', fullName: '张明', phone: '13800138000', email: 'zhang@example.com', status: 'active', createdAt: '2026-10-01', updatedAt: '2026-10-08', applications: [oldApplication], jobs: [], analysisTasks: [], analysisResults: [], resumes: [
    { id: 'resume-old', candidateId: 'candidate-1', applicationId: 'old-app', originalFilename: '旧版本.txt', mimeType: 'text/plain', sizeBytes: 6, contentHash: 'hash-1', scanStatus: 'clean', createdAt: '2026-10-01' },
    { id: 'resume-new', candidateId: 'candidate-1', applicationId: 'old-app', originalFilename: '最新简历.txt', mimeType: 'text/plain', sizeBytes: 6, contentHash: 'hash-2', scanStatus: 'clean', createdAt: '2026-10-08' },
  ] }
}
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
async function mount(initialCandidateId = 'candidate-1', initialApplicationId?: string) {
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(ApplicationCreateDialog, { initialCandidateId, initialApplicationId, candidates: [
    { id: 'CAN-1', entityId: 'candidate-1', name: '张明', phone: '13800138000', email: 'zhang@example.com', job: '后端工程师', score: 72, aiStatus: 'completed', applicationStatus: 'rejected', updatedAt: '2026-10-08' },
    { id: 'CAN-2', entityId: 'candidate-2', name: '李华', phone: '13900139000', job: '设计师', score: 0, aiStatus: 'pending', applicationStatus: 'pending', updatedAt: '2026-10-08' },
  ], jobs: [{ id: 'JOB-1', entityId: 'job-1', title: '后端工程师' }, { id: 'JOB-2', entityId: 'job-2', title: '架构师' }], onCreated, onChanged, onView, onClose })
  app.mount(root); await flush()
}
async function select(selector: string, value: string) { const input = root.querySelector(selector) as HTMLSelectElement; input.value = value; input.dispatchEvent(new Event('change')); await flush() }
async function click(text: string) { const button = [...root.querySelectorAll('button')].find((button) => button.textContent === text)!; expect(button.disabled).toBe(false); button.click(); await flush() }
beforeEach(() => {
  vi.mocked(getCandidate).mockResolvedValue(candidateDetail())
  vi.mocked(loadApplications).mockResolvedValue([oldApplication])
  vi.mocked(createApplication).mockResolvedValue(newApplication)
  vi.mocked(analyzeResumeForApplication).mockResolvedValue({ id: 'task-new', resumeId: 'resume-new', applicationId: 'new-app', status: 'queued', attempts: 0 })
})
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })

describe('existing candidate application workflow', () => {
  it('targets a pending existing application and analyzes it without creating another application', async () => {
    const detail = candidateDetail(); detail.applications.push(newApplication)
    vi.mocked(getCandidate).mockResolvedValue(detail)
    await mount('candidate-1', 'new-app')
    expect(root.querySelector<HTMLSelectElement>('#application-job')!.value).toBe('job-2')
    expect(root.querySelector('.saved-note')?.textContent).toContain('不会重复创建')
    expect(root.querySelector('h3')?.textContent).toBe('岗位申请 · 简历解析')
    await click('解析此申请')
    expect(createApplication).not.toHaveBeenCalled()
    expect(analyzeResumeForApplication).toHaveBeenCalledWith('candidate-1', 'resume-new', 'new-app')
    expect(onCreated).toHaveBeenCalledWith({ application: newApplication, taskId: 'task-new', resumeName: '最新简历.txt' })
  })
  it('does not queue a second analysis when the target application is already processing', async () => {
    const detail = candidateDetail(); detail.applications.push(newApplication)
    detail.analysisTasks.push({ id: 'running', applicationId: 'new-app', resumeId: 'resume-new', status: 'processing', attempts: 1 })
    vi.mocked(getCandidate).mockResolvedValue(detail)
    await mount('candidate-1', 'new-app')
    expect(root.querySelector<HTMLButtonElement>('.application-footer .btn-primary')!.disabled).toBe(true)
    expect(root.querySelector('.duplicate-note')?.textContent).toContain('无需重复创建')
    expect(createApplication).not.toHaveBeenCalled()
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
  })

  it('defaults to the latest resume and creates a separate application analysis without uploading again', async () => {
    const original = candidateDetail()
    vi.mocked(getCandidate).mockResolvedValue(original)
    await mount(); await select('#application-job', 'job-2')
    expect((root.querySelector('#application-resume') as HTMLSelectElement).value).toBe('resume-new')
    await click('创建申请并分析')
    expect(createApplication).toHaveBeenCalledWith({ candidateId: 'candidate-1', jobId: 'job-2', source: undefined })
    expect(analyzeResumeForApplication).toHaveBeenCalledWith('candidate-1', 'resume-new', 'new-app')
    expect(uploadResume).not.toHaveBeenCalled()
    expect(original.resumes[1].applicationId).toBe('old-app')
    expect(onCreated).toHaveBeenCalledWith({ application: newApplication, taskId: 'task-new', resumeName: '最新简历.txt' })
  })
  it('blocks duplicate applications and provides the original application action', async () => {
    await mount(); await select('#application-job', 'job-1')
    expect(root.querySelector('.duplicate-note')?.textContent).toContain('无需重复创建')
    expect(root.querySelector<HTMLButtonElement>('.application-footer .btn-primary')!.disabled).toBe(true)
    await click('查看原申请')
    expect(onView).toHaveBeenCalledWith(oldApplication)
    expect(createApplication).not.toHaveBeenCalled()
  })
  it('rechecks duplicate applications on the server before creating', async () => {
    vi.mocked(loadApplications).mockResolvedValue([newApplication])
    await mount(); await select('#application-job', 'job-2'); await click('创建申请并分析')
    expect(createApplication).not.toHaveBeenCalled()
    expect(root.querySelector('[role=alert]')?.textContent).toContain('无需重复创建')
  })
  it('retries analysis after partial success without creating the application twice', async () => {
    vi.mocked(analyzeResumeForApplication).mockRejectedValueOnce(new Error('Worker 暂不可用'))
    await mount(); await select('#application-job', 'job-2'); await click('创建申请并分析')
    expect(root.querySelector('[role=alert]')?.textContent).toContain('申请已创建')
    expect(onCreated).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalledTimes(1)
    await click('重试分析')
    expect(createApplication).toHaveBeenCalledTimes(1)
    expect(analyzeResumeForApplication).toHaveBeenCalledTimes(2)
    expect(onCreated).toHaveBeenCalledTimes(1)
  })
  it('continues an existing unfinished application instead of creating a duplicate', async () => {
    const detail = candidateDetail(); detail.applications.push(newApplication)
    vi.mocked(getCandidate).mockResolvedValue(detail)
    await mount(); await select('#application-job', 'job-2'); await click('继续完成此申请'); await click('重试分析')
    expect(createApplication).not.toHaveBeenCalled()
    expect(analyzeResumeForApplication).toHaveBeenCalledWith('candidate-1', 'resume-new', 'new-app')
  })
  it('keeps the original create-only capability for later resume analysis', async () => {
    await mount(); await select('#application-job', 'job-2'); await click('仅创建申请')
    expect(createApplication).toHaveBeenCalledTimes(1)
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledWith({ application: newApplication })
  })
  it('searches candidate contacts without depending on list filters', async () => {
    await mount('')
    const search = root.querySelector<HTMLInputElement>('#application-search')!
    search.value = '1390013'; search.dispatchEvent(new Event('input')); await flush()
    expect(root.querySelector('#application-candidate')?.textContent).toContain('李华')
    expect(root.querySelector('#application-candidate')?.textContent).not.toContain('张明')
  })
  it('uploads a new resume only for the new application', async () => {
    vi.mocked(uploadResume).mockResolvedValue({ resume: candidateDetail().resumes[1], task: { id: 'upload-task', resumeId: 'uploaded', applicationId: 'new-app', status: 'queued', attempts: 0 } })
    await mount(); await select('#application-job', 'job-2')
    const radio = root.querySelector<HTMLInputElement>('input[value=upload]')!; radio.checked = true; radio.dispatchEvent(new Event('change')); await flush()
    const file = root.querySelector<HTMLInputElement>('#application-resume-file')!
    Object.defineProperty(file, 'files', { value: [new File(['new resume'], '新版本.txt', { type: 'text/plain' })] }); file.dispatchEvent(new Event('change')); await flush()
    await click('创建申请并分析')
    for (let i = 0; i < 30 && !onCreated.mock.calls.length; i++) { await new Promise((resolve) => setTimeout(resolve, 0)); await flush() }
    expect(uploadResume).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 'candidate-1', applicationId: 'new-app', originalFilename: '新版本.txt', encoding: 'base64' }))
    expect(analyzeResumeForApplication).not.toHaveBeenCalled()
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'upload-task' }))
  })
  it('ignores a stale detail response after choosing another candidate', async () => {
    let resolve!: (value: ApiCandidateDetail) => void
    vi.mocked(getCandidate).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    await mount(); await select('#application-candidate', 'candidate-2')
    resolve({ ...candidateDetail(), fullName: '不应出现的旧档案' }); await flush()
    expect(root.querySelector('.candidate-card')?.textContent).not.toContain('不应出现的旧档案')
  })
})
