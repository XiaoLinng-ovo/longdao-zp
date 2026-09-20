// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewListPage from './InterviewListPage.vue'
import { createInterview, loadInterviewScheduleData, loadInterviews } from '../api'
import { createApplication } from '../../candidates/api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    loadInterviews: vi.fn(),
    loadInterviewScheduleData: vi.fn(),
    createInterview: vi.fn(),
    submitFeedback: vi.fn(),
    lockFeedback: vi.fn(),
    concludeInterview: vi.fn(),
  }
})

vi.mock('../../candidates/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../candidates/api')>()
  return { ...actual, createApplication: vi.fn() }
})

const mockedLoadInterviews = vi.mocked(loadInterviews)
const mockedLoadApplications = vi.mocked(loadInterviewScheduleData)
const mockedCreateInterview = vi.mocked(createInterview)
const mockedCreateApplication = vi.mocked(createApplication)

let app: App | undefined
let root: HTMLDivElement | undefined

async function flush() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  vi.resetAllMocks()
})

describe('InterviewListPage', () => {
  it('opens the arrange interview form in a modal instead of below the table', async () => {
    mockedLoadInterviews.mockResolvedValue([])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [] })

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(InterviewListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const arrangeButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '安排面试')
    expect(arrangeButton).toBeTruthy()
    arrangeButton!.click()
    await flush()

    expect(root.querySelector('.overlay')).not.toBeNull()
    const dialog = root.querySelector('.dialog')!
    expect(dialog.querySelector('h3')?.textContent).toBe('安排面试')
    expect(dialog.textContent).not.toContain('轮次')
    expect(dialog.textContent).not.toContain('时区')
  })

  it('filters resume candidates by name', async () => {
    mockedLoadInterviews.mockResolvedValue([])
    mockedLoadApplications.mockResolvedValue({
      candidates: [
        { id: 'candidate-1', code: 'CAN-1', fullName: '张三' },
        { id: 'candidate-2', code: 'CAN-2', fullName: '李四' },
        { id: 'candidate-3', code: 'CAN-3', fullName: '王五' },
      ],
      jobs: [{ id: 'job-1', code: 'JOB-1', title: '后端工程师' }],
      applications: [],
    })

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(InterviewListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const arrangeButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '安排面试')
    arrangeButton!.click()
    await flush()

    const search = root.querySelector('input[placeholder="输入候选人姓名或编号搜索"]') as HTMLInputElement
    search.value = '王五'
    search.dispatchEvent(new Event('input'))
    await flush()

    const options = [...root.querySelectorAll('datalist option')].map((option) => (option as HTMLOptionElement).value)
    expect(options).toContain('王五（CAN-3）')
    expect(options).not.toContain('张三（CAN-1）')
  })

  it('starts from resume candidates and creates an application before scheduling when needed', async () => {
    mockedLoadInterviews.mockResolvedValue([])
    mockedLoadApplications.mockResolvedValue({
        candidates: [{ id: 'candidate-1', code: 'CAN-1', fullName: '王五', email: 'wang@example.com' }],
      jobs: [{ id: 'job-1', code: 'JOB-1', title: '后端工程师' }],
      applications: [],
    })
    mockedCreateApplication.mockResolvedValue({
      id: 'app-new',
      candidateId: 'candidate-1',
      jobId: 'job-1',
      status: 'new',
      aiStatus: 'pending',
      updatedAt: '2026-09-20T00:00:00Z',
    })
    mockedCreateInterview.mockResolvedValue({} as never)

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(InterviewListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const arrangeButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '安排面试')
    arrangeButton!.click()
    await flush()

    const candidateSearch = root.querySelector('input[placeholder="输入候选人姓名或编号搜索"]') as HTMLInputElement
    candidateSearch.value = '王五（CAN-1）'
    candidateSearch.dispatchEvent(new Event('input'))
    await flush()

    const jobSelect = root.querySelector('select[aria-label="岗位"]') as HTMLSelectElement
    jobSelect.value = 'job-1'
    jobSelect.dispatchEvent(new Event('change'))
    await flush()

    const interviewer = root.querySelector('input[placeholder="输入系统用户姓名或邮箱"]') as HTMLInputElement
    interviewer.value = '林晓'
    interviewer.dispatchEvent(new Event('input'))
    await flush()

    const createButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '创建面试')
    createButton!.click()
    await flush()

    expect(mockedCreateApplication).toHaveBeenCalledWith({ candidateId: 'candidate-1', jobId: 'job-1' })
    expect(mockedCreateInterview).toHaveBeenCalledWith(expect.objectContaining({
      applicationId: 'app-new',
      participants: [expect.objectContaining({ userId: '林晓', name: '林晓', role: 'interviewer', required: true })],
    }))
  })
})
