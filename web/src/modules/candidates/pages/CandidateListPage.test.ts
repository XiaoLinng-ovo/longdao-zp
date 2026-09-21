// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import { createApplication, createCandidate, loadCandidateTags, loadCandidates, loadJobs, uploadResume } from '../api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    createApplication: vi.fn(),
    createCandidate: vi.fn(),
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
  vi.resetAllMocks()
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

    const openButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '新建候选人')
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

    const uploadButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '上传并解析')
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

    const openButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '新建申请')
    openButton!.click()
    await flush()

    expect(root.querySelector('.overlay')).not.toBeNull()
    expect(root.querySelector('.dialog h3')?.textContent).toBe('新建申请')
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
})
