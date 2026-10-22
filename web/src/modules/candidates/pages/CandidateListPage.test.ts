// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import { authSession } from '../../auth/session'
import { createApplication, createCandidate, deleteCandidate, loadCandidateTags, loadCandidates, loadJobs, uploadResume } from '../api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    createApplication: vi.fn(),
    createCandidate: vi.fn(),
    deleteCandidate: vi.fn(),
    getAnalysisTask: vi.fn(),
    loadCandidateTags: vi.fn(),
    loadCandidates: vi.fn(),
    loadJobs: vi.fn(),
    uploadResume: vi.fn(),
  }
})

const mockedCreateApplication = vi.mocked(createApplication)
const mockedCreateCandidate = vi.mocked(createCandidate)
const mockedLoadCandidateTags = vi.mocked(loadCandidateTags)
const mockedLoadCandidates = vi.mocked(loadCandidates)
const mockedLoadJobs = vi.mocked(loadJobs)
const mockedUploadResume = vi.mocked(uploadResume)

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 16; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown
  for (let index = 0; index < 30; index += 1) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 0))
      await flush()
    }
  }
  throw lastError
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  vi.restoreAllMocks()
  vi.resetAllMocks()
  authSession.user = null
  vi.useRealTimers()
})

describe('CandidateListPage resume upload', () => {
  it('requires a job and links the uploaded resume to the created application', async () => {
    mockedLoadCandidates.mockResolvedValue([])
    mockedLoadJobs.mockResolvedValue([{ id: 'JOB-1', entityId: 'job-1', title: '后端工程师' } as never])
    mockedLoadCandidateTags.mockResolvedValue([])
    mockedCreateCandidate.mockResolvedValue({ id: 'candidate-1', code: 'CAN-1', fullName: '待解析候选人', status: 'active', updatedAt: '2026-09-20T00:00:00Z', applications: [] })
    mockedCreateApplication.mockResolvedValue({ id: 'app-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'new', aiStatus: 'pending', updatedAt: '2026-09-20T00:00:00Z' })
    mockedUploadResume.mockResolvedValue({
      resume: { id: 'resume-1', candidateId: 'candidate-1', applicationId: 'app-1', originalFilename: 'resume.txt', mimeType: 'text/plain', sizeBytes: 6, contentHash: 'hash', scanStatus: 'clean', createdAt: '2026-09-20T00:00:00Z' },
      task: { id: 'task-1', resumeId: 'resume-1', applicationId: 'app-1', status: 'queued', attempts: 0 },
    })

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()
    expect(root.querySelector('.page-header h2')?.textContent).toBe('简历库 · AI 评分')
    expect(root.querySelector('.page-header p')).toBeNull()

    const openButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '上传简历并建档')
    openButton!.click()
    await flush()

    expect(root.querySelector('.overlay')).not.toBeNull()
    expect(root.querySelector('.dialog h3')?.textContent).toBe('上传简历自动建库')

    const fileInput = root.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['resume'], 'resume.txt', { type: 'text/plain' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fileInput.dispatchEvent(new Event('change'))

    const jobSelect = root.querySelector('select[aria-label="上传简历岗位"]') as HTMLSelectElement
    jobSelect.value = 'job-1'
    jobSelect.dispatchEvent(new Event('change'))
    await flush()

    const uploadButton = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes('上传并解析'))
    uploadButton!.click()
    await waitFor(() => expect(mockedCreateApplication).toHaveBeenCalledWith({ candidateId: 'candidate-1', jobId: 'job-1' }))
    await waitFor(() => expect(mockedUploadResume).toHaveBeenCalledWith(expect.objectContaining({
      candidateId: 'candidate-1',
      applicationId: 'app-1',
    })))
  })

  it('opens the new application form in a modal', async () => {
    mockedLoadCandidates.mockResolvedValue([])
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadCandidateTags.mockResolvedValue([])

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const openButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '新建应聘申请')
    openButton!.click()
    await flush()

    expect(root.querySelector('.overlay')).not.toBeNull()
    expect(root.querySelector('.dialog h3')?.textContent).toBe('新建应聘申请')
  })

  it('sorts candidates by AI score in both directions', async () => {
    mockedLoadCandidates.mockResolvedValue([
      { id: 'CAN-1', entityId: 'candidate-1', name: '低分候选人', job: '后端工程师', score: 62, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'CAN-2', entityId: 'candidate-2', name: '高分候选人', job: '后端工程师', score: 96, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'CAN-3', entityId: 'candidate-3', name: '待评分候选人', job: '后端工程师', score: 0, aiStatus: 'pending', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
    ])
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadCandidateTags.mockResolvedValue([])

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const renderedNames = () => [...root!.querySelectorAll('.name-link')].map((node) => node.textContent)
    expect(renderedNames()).toEqual(['低分候选人', '高分候选人', '待评分候选人'])

    const sort = root.querySelector('select[aria-label="评分排序"]') as HTMLSelectElement
    sort.value = 'desc'
    sort.dispatchEvent(new Event('change'))
    await flush()
    expect(renderedNames()).toEqual(['高分候选人', '低分候选人', '待评分候选人'])

    sort.value = 'asc'
    sort.dispatchEvent(new Event('change'))
    await flush()
    expect(renderedNames()).toEqual(['低分候选人', '高分候选人', '待评分候选人'])
  })

  it('defaults to the most recently updated candidates first', async () => {
    mockedLoadCandidates.mockResolvedValue([
      { id: 'CAN-17', entityId: 'candidate-17', name: '17号候选人', job: '后端工程师', score: 86, aiStatus: 'completed', applicationStatus: 'active', rawApplicationStatus: 'completed', updatedAt: '2026-10-17T09:00:00Z' },
      { id: 'CAN-19', entityId: 'candidate-19', name: '19号候选人', job: '后端工程师', score: 72, aiStatus: 'pending', applicationStatus: 'pending', rawApplicationStatus: 'pending', updatedAt: '2026-10-19T09:00:00Z' },
      { id: 'CAN-18', entityId: 'candidate-18', name: '18号候选人', job: '后端工程师', score: 91, aiStatus: 'completed', applicationStatus: 'active', rawApplicationStatus: 'completed', updatedAt: '2026-10-18T09:00:00Z' },
    ])
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadCandidateTags.mockResolvedValue([])

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    expect([...root.querySelectorAll('.name-link')].map((node) => node.textContent)).toEqual(['19号候选人', '18号候选人', '17号候选人'])
  })

  it('filters and sorts candidates by job', async () => {
    mockedLoadCandidates.mockResolvedValue([
      { id: 'CAN-1', entityId: 'candidate-1', name: '后端候选人', job: '后端工程师', score: 72, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'CAN-2', entityId: 'candidate-2', name: '产品候选人', job: '产品经理', score: 88, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'CAN-3', entityId: 'candidate-3', name: '后端高分候选人', job: '后端工程师', score: 95, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
    ])
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadCandidateTags.mockResolvedValue([])

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const renderedNames = () => [...root!.querySelectorAll('.name-link')].map((node) => node.textContent)
    const jobFilter = root.querySelector('select[aria-label="岗位筛选"]') as HTMLSelectElement
    const jobSort = root.querySelector('select[aria-label="岗位排序"]') as HTMLSelectElement
    const scoreSort = root.querySelector('select[aria-label="评分排序"]') as HTMLSelectElement

    jobSort.value = 'asc'
    jobSort.dispatchEvent(new Event('change'))
    scoreSort.value = 'desc'
    scoreSort.dispatchEvent(new Event('change'))
    await flush()
    expect(renderedNames()).toEqual(['产品候选人', '后端高分候选人', '后端候选人'])

    jobFilter.value = '后端工程师'
    jobFilter.dispatchEvent(new Event('change'))
    await flush()
    expect(renderedNames()).toEqual(['后端高分候选人', '后端候选人'])
  })

  it('searches candidates by name, company, skill, job and source', async () => {
    mockedLoadCandidates.mockResolvedValue([
      { id: 'CAN-1', entityId: 'candidate-1', name: '林晓', job: '后端工程师', source: 'BOSS直聘', company: '星河科技', skills: ['Java', 'PostgreSQL'], score: 86, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'CAN-2', entityId: 'candidate-2', name: '周芳', job: '产品经理', source: '官网投递', company: '远山网络', skills: ['需求分析'], score: 78, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
      { id: 'CAN-3', entityId: 'candidate-3', name: '林北⾠', job: 'AI应用工程师', source: '官网投递', company: '星河科技', skills: ['Python'], score: 81, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-09-20T00:00:00Z' },
    ])
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadCandidateTags.mockResolvedValue([])

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const renderedNames = () => [...root!.querySelectorAll('.name-link')].map((node) => node.textContent)
    const search = root.querySelector('input[aria-label="简历库搜索"]') as HTMLInputElement
    for (const [query, expected] of [['星河', ['林晓', '林北⾠']], ['PostgreSQL', ['林晓']], ['产品经理', ['周芳']], ['官网', ['周芳', '林北⾠']], ['林北辰', ['林北⾠']]] as const) {
      search.value = query
      search.dispatchEvent(new Event('input'))
      await flush()
      expect(renderedNames()).toEqual(expected)
    }
  })
})

describe('CandidateListPage deletion', () => {
  const candidate = { id: 'CAN-1', entityId: 'candidate-1', name: '测试候选人', job: '后端工程师', score: 86, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-10-08' } as const

  async function mountPage(role: 'recruiter' | 'hiring_manager' = 'recruiter') {
    authSession.user = { id: 'u1', name: '招聘专员', email: 'test@example.com', role, departmentId: 'd1' }
    mockedLoadCandidates.mockResolvedValue([{ ...candidate }])
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadCandidateTags.mockResolvedValue([])
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()
  }

  it('shows delete beside detail and cancellation does not call the API', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await mountPage()
    expect(root!.querySelector('.row-actions')?.textContent).toContain('详情')
    ;(root!.querySelector('.delete-button') as HTMLButtonElement).click()
    await flush()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('此操作不可恢复'))
    expect(deleteCandidate).not.toHaveBeenCalled()
    expect(root!.querySelector('.name-link')?.textContent).toBe(candidate.name)
  })

  it('uses the entity ID, disables duplicate submissions and refreshes after deletion', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await mountPage()
    let resolveDelete!: () => void
    vi.mocked(deleteCandidate).mockReturnValue(new Promise<void>((resolve) => { resolveDelete = resolve }))
    ;(root!.querySelector('.delete-button') as HTMLButtonElement).click()
    await flush()
    const button = root!.querySelector('.delete-button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe('删除中…')
    button.click()
    expect(deleteCandidate).toHaveBeenCalledTimes(1)
    expect(deleteCandidate).toHaveBeenCalledWith('candidate-1')
    mockedLoadCandidates.mockResolvedValue([])
    resolveDelete()
    await flush()
    expect(mockedLoadCandidates).toHaveBeenCalledTimes(2)
    expect(root!.querySelector('.name-link')).toBeNull()
    expect(root!.querySelector('.success-note')?.textContent).toContain('已删除候选人')
  })

  it('keeps the candidate and displays a failure reason', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.mocked(deleteCandidate).mockRejectedValue(new Error('该候选人已有面试记录，不能直接删除'))
    await mountPage()
    ;(root!.querySelector('.delete-button') as HTMLButtonElement).click()
    await flush()
    expect(root!.querySelector('.error-note')?.textContent).toContain('已有面试记录')
    expect(root!.querySelector('.name-link')?.textContent).toBe(candidate.name)
    expect((root!.querySelector('.delete-button') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not expose delete to a hiring manager', async () => {
    await mountPage('hiring_manager')
    expect(root!.querySelector('.delete-button')).toBeNull()
  })
})


describe('CandidateListPage score review dialog', () => {
  it('keeps the close control outside the scrolling review body and closes after scrolling', async () => {
    mockedLoadCandidates.mockResolvedValue([{
      id: 'CAN-1', entityId: 'candidate-1', name: '测试候选人',
      job: '后端工程师', score: 88, aiStatus: 'completed', applicationStatus: 'active',
      updatedAt: '2026-10-08', rawApplicationStatus: 'human_review',
      resumeReview: {
        resultId: 'result-1', aiScore: 88, humanScore: 85, finalScore: 86.2,
        talentPool: false, history: [], evidence: [], strengths: [], risks: [],
      },
    }])
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadCandidateTags.mockResolvedValue([])
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    root.querySelector<HTMLButtonElement>('.basis-link')!.click()
    await flush()

    const dialog = root.querySelector('.score-review-dialog')!
    const body = dialog.querySelector<HTMLElement>('.review-dialog-body')!
    const close = dialog.querySelector<HTMLButtonElement>('.review-dialog-head button')!
    expect(body.querySelector('.resume-review-panel')).not.toBeNull()
    expect(close.textContent).toBe('关闭')
    expect(body.contains(close)).toBe(false)
    expect(close.closest('.review-dialog-head')?.parentElement).toBe(dialog)

    body.scrollTop = 1000
    body.dispatchEvent(new Event('scroll'))
    await flush()
    close.click()
    await flush()
    expect(root.querySelector('.score-review-dialog')).toBeNull()
  })
})


describe('CandidateListPage multiple applications', () => {
  it('polls an active secondary application sequentially and stops after completion', async () => {
    vi.useFakeTimers()
    const completed = { id: 'CAN-1', entityId: 'candidate-1', name: '轮询测试', job: '后端工程师', applicationId: 'app-1', score: 88, aiStatus: 'completed' as const, analysisStatus: 'completed', applicationStatus: 'active' as const, updatedAt: '2026-10-08' }
    const processing = { ...completed, job: '架构师', applicationId: 'app-2', aiStatus: 'pending' as const, analysisStatus: 'processing' }
    mockedLoadCandidates.mockResolvedValue([{ ...completed, applicationRows: [completed, processing] }])
    mockedLoadJobs.mockResolvedValue([])
    mockedLoadCandidateTags.mockResolvedValue([])
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root); await flush()
    expect(mockedLoadCandidates).toHaveBeenCalledTimes(1)
    let finishRefresh!: (rows: Awaited<ReturnType<typeof loadCandidates>>) => void
    mockedLoadCandidates.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve }))
    await vi.advanceTimersByTimeAsync(5000); await flush()
    expect(mockedLoadCandidates).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30000); await flush()
    expect(mockedLoadCandidates).toHaveBeenCalledTimes(2)
    finishRefresh([{ ...completed, applicationRows: [completed, { ...processing, aiStatus: 'completed', analysisStatus: 'completed', score: 81 }] }])
    await flush()
    await vi.advanceTimersByTimeAsync(30000); await flush()
    expect(mockedLoadCandidates).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not restart polling when a pending refresh resolves after unmount', async () => {
    vi.useFakeTimers()
    let finishRefresh!: (rows: Awaited<ReturnType<typeof loadCandidates>>) => void
    mockedLoadCandidates.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve }))
    mockedLoadJobs.mockResolvedValue([]); mockedLoadCandidateTags.mockResolvedValue([])
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root); await flush()
    app.unmount(); app = undefined
    finishRefresh([{ id: 'CAN-1', entityId: 'candidate-1', name: '卸载测试', job: '后端工程师', score: 0, aiStatus: 'pending', analysisStatus: 'processing', applicationStatus: 'active', updatedAt: '2026-10-08' }])
    await flush()
    await vi.advanceTimersByTimeAsync(30000); await flush()
    expect(mockedLoadCandidates).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('opens the selected job review instead of another application belonging to the same person', async () => {
    const base = { id: 'CAN-1', entityId: 'candidate-1', name: '张明', score: 0, scoreAvailable: false, aiStatus: 'pending' as const, applicationStatus: 'pending_analysis' as const, updatedAt: '2026-10-08' }
    const newJob = { ...base, job: '架构师', applicationId: 'app-new', rawApplicationStatus: 'pending_analysis', analysisStatus: 'queued' }
    const oldJob = { ...base, job: '后端工程师', applicationId: 'app-old', rawApplicationStatus: 'human_review', aiStatus: 'completed' as const, analysisStatus: 'completed', resumeReview: { resultId: 'result-old', aiScore: 88, talentPool: true, history: [], evidence: [], strengths: [], risks: [] } }
    mockedLoadCandidates.mockResolvedValue([{ ...newJob, applicationRows: [newJob, oldJob] }])
    mockedLoadJobs.mockResolvedValue([]); mockedLoadCandidateTags.mockResolvedValue([])
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(CandidateListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root); await flush()
    expect(root.querySelectorAll('tbody tr')).toHaveLength(1)
    root.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await flush()
    expect(root.querySelectorAll('tbody tr')).toHaveLength(2)
    root.querySelector<HTMLButtonElement>('.application-subrow .basis-link')!.click(); await flush()
    expect(root.querySelector('.review-dialog-head h3')?.textContent).toContain('后端工程师')
    expect(root.querySelector('.review-dialog-body')?.textContent).toContain('88')
    root.querySelector<HTMLButtonElement>('.review-dialog-head button')!.click(); await flush()
    const filter = root.querySelector<HTMLSelectElement>('#candidate-job-filter')!
    filter.value = '后端工程师'; filter.dispatchEvent(new Event('change')); await flush()
    expect(root.querySelector('tbody tr')?.textContent).toContain('后端工程师')
    expect(root.querySelector('tbody tr')?.textContent).not.toContain('架构师')
  })
})
