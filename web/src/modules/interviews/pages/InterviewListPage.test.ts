// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewListPage from './InterviewListPage.vue'
import type { InterviewView } from '../api'
import { createInterview, deleteInterview, loadInterviewScheduleData, loadInterviews, lockFeedback, submitFeedback, updateInterviewSchedule } from '../api'
import { createApplication } from '../../candidates/api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    loadInterviews: vi.fn(),
    loadInterviewScheduleData: vi.fn(),
    createInterview: vi.fn(),
    updateInterviewSchedule: vi.fn(),
    submitFeedback: vi.fn(),
    lockFeedback: vi.fn(),
    concludeInterview: vi.fn(),
    deleteInterview: vi.fn(),
  }
})

vi.mock('../../candidates/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../candidates/api')>()
  return { ...actual, createApplication: vi.fn() }
})

const mockedLoadInterviews = vi.mocked(loadInterviews)
const mockedLoadApplications = vi.mocked(loadInterviewScheduleData)
const mockedCreateInterview = vi.mocked(createInterview)
const mockedDeleteInterview = vi.mocked(deleteInterview)
const mockedCreateApplication = vi.mocked(createApplication)
const mockedUpdateSchedule = vi.mocked(updateInterviewSchedule)

function finalInterview(overrides: Partial<InterviewView> = {}): InterviewView {
  return {
    id: 'INT-final', entityId: 'final-1', applicationId: 'app-1',
    candidate: '王五', job: '后端工程师', stage: 'final', round: '2 轮',
    scheduledAt: '待安排', interviewers: [], interviewerIds: [], interviewerOptions: [],
    status: 'scheduled', feedbackStatus: 'scheduled', ...overrides,
  }
}

async function mountPage(path = '/') {
  root = document.createElement('div')
  document.body.appendChild(root)
  const router = createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push(path)
  app = createApp(InterviewListPage)
  app.use(router)
  app.mount(root)
  await flush()
  return router
}

function button(label: string) {
  return [...root!.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!
}

async function fillSchedule() {
  const time = root!.querySelector('input[type="datetime-local"]') as HTMLInputElement
  time.value = '2026-11-01T10:00'
  time.dispatchEvent(new Event('input'))
  const meeting = root!.querySelector('input[placeholder="https://..."]') as HTMLInputElement
  meeting.value = 'https://meeting.example.com/final'
  meeting.dispatchEvent(new Event('input'))
  const interviewer = root!.querySelector('select[aria-label="面试官"]') as HTMLSelectElement
  interviewer.value = '77777777-7777-4777-8777-777777777777'
  interviewer.dispatchEvent(new Event('change'))
  await flush()
}

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
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(InterviewListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    expect(root.querySelector('.page-header h2')?.textContent).toBe('面试中心')
    expect(root.querySelector('.page-header p')).toBeNull()
    const arrangeButton = [...root.querySelectorAll('button')].find((button) => button.textContent === '安排面试')
    expect(arrangeButton).toBeTruthy()
    arrangeButton!.click()
    await flush()

    expect(root.querySelector('.overlay')).not.toBeNull()
    const dialog = root.querySelector('.dialog')!
    expect(dialog.querySelector('h3')?.textContent).toBe('安排复试')
    expect(dialog.textContent).toContain('暂无通过初试且待安排复试的候选人')
    expect(button('确认安排复试').disabled).toBe(true)
    expect(dialog.textContent).not.toContain('轮次')
    expect(dialog.textContent).not.toContain('时区')
  })

  it('only offers unscheduled final interviews in the interview center', async () => {
    mockedLoadInterviews.mockResolvedValue([
      finalInterview(),
      finalInterview({ entityId: 'initial', stage: 'initial', round: '1 轮', candidate: '初试候选人' }),
      finalInterview({ entityId: 'scheduled', candidate: '已安排复试', scheduledAt: '11-01 10:00', scheduledStartAt: '2026-11-01T02:00:00Z' }),
      finalInterview({ entityId: 'completed', candidate: '已完成复试', status: 'completed' }),
      finalInterview({ entityId: 'cancelled', candidate: '已取消复试', status: 'cancelled' }),
      finalInterview({ entityId: 'legacy', candidate: '历史复试', stage: undefined }),
    ])
    mockedLoadApplications.mockResolvedValue({
      candidates: [
        { id: 'candidate-1', code: 'CAN-1', fullName: '张三' },
        { id: 'candidate-2', code: 'CAN-2', fullName: '李四' },
        { id: 'candidate-3', code: 'CAN-3', fullName: '王五' },
      ],
      jobs: [{ id: 'job-1', code: 'JOB-1', title: '后端工程师' }],
      applications: [],
      interviewers: [],
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

    expect(root.querySelector('input[placeholder="输入候选人姓名或编号搜索"]')).toBeNull()
    const options = [...root.querySelectorAll('#final-interview-select option')].map((option) => (option as HTMLOptionElement).value)
    expect(options).toEqual(['', 'final-1', 'legacy'])
  })

  it('creates the initial interview only through the resume-library application link', async () => {
    mockedLoadInterviews.mockResolvedValue([])
    mockedLoadApplications.mockResolvedValue({
      candidates: [{ id: 'candidate-1', code: 'CAN-1', fullName: '王五', email: 'wang@example.com' }],
      jobs: [{ id: 'job-1', code: 'JOB-1', title: '后端工程师' }],
      applications: [{ id: 'app-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' }],
      interviewers: [{ id: '77777777-7777-4777-8777-777777777777', displayName: '林晓', email: 'lin@example.com' }],
    })
    mockedCreateInterview.mockResolvedValue({} as never)
    await mountPage('/interviews?applicationId=app-1&stage=initial')
    expect(root!.querySelector('.dialog h3')?.textContent).toBe('初试邀约')
    expect((root!.querySelector('select[aria-label="岗位"]') as HTMLSelectElement).disabled).toBe(true)
    await fillSchedule()
    button('创建初试邀约').click()
    await flush()

    expect(mockedCreateApplication).not.toHaveBeenCalled()
    expect(mockedUpdateSchedule).not.toHaveBeenCalled()
    expect(mockedCreateInterview).toHaveBeenCalledWith(expect.objectContaining({
      applicationId: 'app-1', round: 1,
      participants: [expect.objectContaining({ userId: '77777777-7777-4777-8777-777777777777', name: '林晓', role: 'interviewer', required: true })],
    }))
  })

  it('opens the matching final interview from a task link and updates its schedule without creating records', async () => {
    const support = { userId: 'coordinator-1', name: '协调人', role: 'coordinator' as const, required: false }
    mockedLoadInterviews.mockResolvedValue([
      finalInterview({ entityId: 'other-final', applicationId: 'other-app' }),
      finalInterview({ participants: [support, { userId: 'old-interviewer', role: 'interviewer', required: true }] }),
    ])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [{ id: '77777777-7777-4777-8777-777777777777', displayName: '林晓' }] })
    mockedUpdateSchedule.mockResolvedValue({} as never)
    await mountPage('/interviews?applicationId=app-1&stage=final')
    expect(root!.querySelector('.dialog h3')?.textContent).toBe('安排复试')
    expect((root!.querySelector('#final-interview-select') as HTMLSelectElement).value).toBe('final-1')
    await fillSchedule()
    button('确认安排复试').click()
    await flush()
    expect(mockedUpdateSchedule).toHaveBeenCalledWith('final-1', {
      scheduledStartAt: new Date('2026-11-01T10:00').toISOString(), location: null,
      meetingUrl: 'https://meeting.example.com/final',
      participants: [support, { userId: '77777777-7777-4777-8777-777777777777', name: '林晓', role: 'interviewer', required: true }],
    })
    expect(mockedCreateInterview).not.toHaveBeenCalled()
    expect(mockedCreateApplication).not.toHaveBeenCalled()
    expect(root!.textContent).toContain('复试已安排')
  })

  it('does not fall back to a different candidate for an invalid final interview link', async () => {
    mockedLoadInterviews.mockResolvedValue([finalInterview()])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await mountPage('/interviews?applicationId=missing&stage=final')
    expect(root!.querySelector('[role="alert"]')?.textContent).toContain('未找到该候选人待安排的复试')
    expect(button('确认安排复试').disabled).toBe(true)
  })

  it('offers scheduling instead of feedback or completion for a pending final interview row', async () => {
    mockedLoadInterviews.mockResolvedValue([finalInterview()])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await mountPage()
    expect(button('填写反馈')).toBeUndefined()
    expect(button('完成面试')).toBeUndefined()
    expect(root!.textContent).not.toContain('需重排面试官')
    button('安排复试').click()
    await flush()
    expect((root!.querySelector('#final-interview-select') as HTMLSelectElement).value).toBe('final-1')
  })

  it('responds when a task link changes stage without changing application', async () => {
    mockedLoadInterviews.mockResolvedValue([finalInterview()])
    mockedLoadApplications.mockResolvedValue({
      candidates: [{ id: 'candidate-1', code: 'CAN-1', fullName: '王五' }],
      jobs: [{ id: 'job-1', code: 'JOB-1', title: '工程师' }],
      applications: [{ id: 'app-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' }], interviewers: [],
    })
    const router = await mountPage('/interviews?applicationId=app-1&stage=initial')
    await router.push('/interviews?applicationId=app-1&stage=final')
    await flush()
    expect(root!.querySelector('.dialog h3')?.textContent).toBe('安排复试')
    expect((root!.querySelector('#final-interview-select') as HTMLSelectElement).value).toBe('final-1')
  })

  it('prioritizes a row action for final scheduling over an initial task-link stage', async () => {
    mockedLoadInterviews.mockResolvedValue([finalInterview()])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await mountPage('/interviews?applicationId=app-1&stage=initial')
    button('取消').click()
    await flush()

    button('安排复试').click()
    await flush()
    expect(root!.querySelector('.dialog h3')?.textContent).toBe('安排复试')
    expect((root!.querySelector('#final-interview-select') as HTMLSelectElement).value).toBe('final-1')
  })

  it('feedback uses the scheduled interviewer instead of a free-text id', async () => {
    const interviewerId = '77777777-7777-4777-8777-777777777777'
    mockedLoadInterviews.mockResolvedValue([{
      id: 'INT-1',
      entityId: 'interview-1',
      candidate: '王五',
      job: '后端工程师',
      round: '1 轮',
      scheduledAt: '09-22 10:00',
      interviewers: ['林晓'],
      interviewerIds: [interviewerId],
      interviewerOptions: [{ id: interviewerId, name: '林晓' }],
      feedbackStatus: 'scheduled',
      status: 'scheduled',
      applicationId: 'app-1',
    }])
    vi.mocked(submitFeedback).mockResolvedValue({})
    vi.mocked(lockFeedback).mockResolvedValue({})

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(InterviewListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const feedbackButton = [...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === '填写反馈')
    feedbackButton!.click()
    await flush()

    const interviewer = root.querySelector('select[aria-label="反馈面试官"]') as HTMLSelectElement
    expect(interviewer.value).toBe(interviewerId)

    const submit = [...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === '提交并锁定')
    submit!.click()
    await flush()

    expect(submitFeedback).toHaveBeenCalledWith('interview-1', expect.objectContaining({ interviewerId }))
    expect(lockFeedback).toHaveBeenCalledWith('interview-1', interviewerId)
  })

  it('marks legacy interviews without a system interviewer for rescheduling', async () => {
    mockedLoadInterviews.mockResolvedValue([{
      id: 'INT-legacy',
      entityId: 'interview-legacy',
      candidate: '历史候选人',
      job: '历史岗位',
      round: '1 轮',
      scheduledAt: '待安排',
      interviewers: ['张三'],
      interviewerIds: [],
      interviewerOptions: [],
      feedbackStatus: 'scheduled',
      status: 'scheduled',
      applicationId: 'app-legacy',
    }])

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(InterviewListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    expect(root.textContent).toContain('需重排面试官')
    expect([...root.querySelectorAll('button')].some((button) => button.textContent === '填写反馈')).toBe(false)
  })

  it('confirms interview deletion, supports cancellation, and refreshes after success', async () => {
    const row: InterviewView = {
      id: 'INT-1',
      entityId: 'interview-1',
      candidate: 'Candidate One',
      job: 'Engineer',
      round: '1 round',
      scheduledAt: '09-22 10:00',
      interviewers: [],
      interviewerIds: [],
      interviewerOptions: [],
      feedbackStatus: 'scheduled',
      status: 'scheduled',
      applicationId: 'app-1',
    }
    mockedLoadInterviews.mockResolvedValueOnce([row]).mockResolvedValueOnce([])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    mockedDeleteInterview.mockResolvedValue()

    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(InterviewListPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()

    const findButton = (label: string) => [...root!.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)
    findButton('\u5220\u9664')!.click()
    await flush()
    expect(root.textContent).toContain('\u786e\u8ba4\u5220\u9664')

    findButton('\u53d6\u6d88')!.click()
    await flush()
    expect(mockedDeleteInterview).not.toHaveBeenCalled()
    expect(findButton('\u5220\u9664')).toBeTruthy()

    findButton('\u5220\u9664')!.click()
    await flush()
    findButton('\u786e\u8ba4\u5220\u9664')!.click()
    await flush()

    expect(mockedDeleteInterview).toHaveBeenCalledWith('interview-1')
    expect(mockedLoadInterviews).toHaveBeenCalledTimes(2)
    expect(root.textContent).toContain('\u5df2\u5220\u9664 Candidate One \u7684\u9762\u8bd5\u8bb0\u5f55')
  })

})


it('shows a retry state after a load failure and an empty state only after a successful retry', async () => {
  mockedLoadInterviews.mockRejectedValueOnce(new Error('面试服务暂时不可用')).mockResolvedValueOnce([])
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(InterviewListPage)
  app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
  app.mount(root)
  await flush()

  expect(root.textContent).toContain('面试列表加载失败，请重试')
  expect(root.textContent).not.toContain('暂无面试记录')
  const retry = [...root.querySelectorAll('button')].find((button) => button.textContent === '重新加载')!
  retry.click()
  await flush()

  expect(mockedLoadInterviews).toHaveBeenCalledTimes(2)
  expect(root.textContent).not.toContain('面试列表加载失败')
  expect(root.textContent).toContain('暂无面试记录')
})
