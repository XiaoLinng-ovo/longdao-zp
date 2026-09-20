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
})
