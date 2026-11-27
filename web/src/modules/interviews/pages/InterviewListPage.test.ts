// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewListPage from './InterviewListPage.vue'
import type { InterviewView } from '../api'
import { completeInterview, concludeInterview, createInterview, deleteInterview, loadInterviewScheduleData, loadInterviews, lockFeedback, submitFeedback, updateInterviewSchedule } from '../api'
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
    completeInterview: vi.fn(),
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
  const interviewer = root!.querySelector('input[type="checkbox"][value="77777777-7777-4777-8777-777777777777"]') as HTMLInputElement
  interviewer.checked = true
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
  it('restores every selected interviewer and saves distinct scorer assignments with one lead', async () => {
    const a = '77777777-7777-4777-8777-777777777777', b = '88888888-8888-4888-8888-888888888888'
    mockedLoadInterviews.mockResolvedValue([finalInterview({interviewerIds:[a,b],participants:[
      {userId:a,name:'林晓',role:'interviewer',required:true,lead:false,sheetTypes:['business']},
      {userId:b,name:'赵明',role:'interviewer',required:true,lead:true,sheetTypes:['hr','boss']},
    ]})])
    mockedLoadApplications.mockResolvedValue({candidates:[],jobs:[],applications:[],interviewers:[{id:a,displayName:'林晓'},{id:b,displayName:'赵明'}]})
    mockedUpdateSchedule.mockResolvedValue({} as never)
    await mountPage('/interviews?applicationId=app-1&interviewId=final-1&stage=final')
    expect([...root!.querySelectorAll<HTMLInputElement>('.interviewer-options input:checked')].map(item=>item.value)).toEqual([a,b])
    expect(root!.querySelector<HTMLSelectElement>('#interview-lead')!.value).toBe(b)
    expect(root!.querySelector<HTMLSelectElement>('#sheet-owner-business')!.value).toBe(a)
    await fillSchedule();button('确认安排复试').click();await flush()
    expect(mockedUpdateSchedule).toHaveBeenCalledWith('final-1',expect.objectContaining({participants:[
      expect.objectContaining({userId:a,lead:false,sheetTypes:['business']}),
      expect.objectContaining({userId:b,lead:true,sheetTypes:['hr','boss']}),
    ]}))
  })
  it('disables scheduling inputs until asynchronous defaults have loaded', async () => {
    mockedLoadInterviews.mockResolvedValue([finalInterview()])
    let finish!: (value: Awaited<ReturnType<typeof loadInterviewScheduleData>>) => void
    mockedLoadApplications.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await mountPage()
    button('安排面试').click()
    await flush()
    const fieldset = root!.querySelector<HTMLFieldSetElement>('.schedule-fields')!
    expect(fieldset.disabled).toBe(true)
    expect(fieldset.querySelector('input[type="datetime-local"]')?.matches(':disabled')).toBe(true)
    expect(fieldset.querySelector('select[aria-label="复试方式"]')?.matches(':disabled')).toBe(true)
    expect(button('确认安排复试').disabled).toBe(true)
    finish({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await flush()
    expect(fieldset.disabled).toBe(false)
    expect(fieldset.querySelector('input[type="datetime-local"]')?.matches(':disabled')).toBe(false)
  })

  it('shows a reschedule action for a cancelled interview', async () => {
    mockedLoadInterviews.mockResolvedValue([finalInterview({ status: 'cancelled' })])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await mountPage()
    expect(button('重新安排')).toBeTruthy()
  })

  it('creates a replacement schedule for a cancelled final interview', async () => {
    const interviewerId = '77777777-7777-4777-8777-777777777777'
    mockedLoadInterviews.mockResolvedValue([finalInterview({ status: 'cancelled', title: '技术复试', type: 'technical', interviewerIds: [interviewerId] })])
    mockedLoadApplications.mockResolvedValue({
      candidates: [{ id: 'candidate-1', code: 'CAN-1', fullName: '王五' }],
      jobs: [{ id: 'job-1', code: 'JOB-1', title: '后端工程师' }],
      applications: [{ id: 'app-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' }],
      interviewers: [{ id: interviewerId, displayName: '林晓' }],
    })
    mockedCreateInterview.mockResolvedValue({} as never)
    await mountPage()
    button('重新安排').click()
    await flush()
    expect(root!.querySelector('.dialog h3')?.textContent).toBe('重新安排复试')
    await fillSchedule()
    button('确认重新安排').click()
    await flush()
    expect(mockedCreateInterview).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'app-1', round: 2, title: '技术复试' }))
    expect(mockedUpdateSchedule).not.toHaveBeenCalled()
  })

  it.each([
    ['initial', '1 轮', 'cancelled', ['continue', 'reject', 'cancelled']],
    ['final', '2 轮', 'offer', ['offer', 'reject', 'cancelled']],
    ['final', '2 轮', 'reject', ['offer', 'reject', 'cancelled']],
    ['final', '2 轮', 'cancelled', ['offer', 'reject', 'cancelled']],
  ] as const)('completes %s with %s and only stage-appropriate outcomes', async (stage, round, outcome, options) => {
    mockedLoadInterviews.mockResolvedValue([{ ...finalInterview(), stage, round, scheduledAt: '10/29 10:00', scheduledStartAt: '2026-10-29T02:00:00Z', interviewerIds: ['interviewer-1'], aiScore: 82.5 }])
    vi.mocked(completeInterview).mockResolvedValue({})
    const router = await mountPage()
    button('完成').click(); await flush()
    expect([...root!.querySelectorAll<HTMLOptionElement>('#conclude-outcome option')].map(item => item.value)).toEqual(options)
    expect(root!.querySelector('.completion-score')?.textContent).toContain('82.5')
    const select = root!.querySelector<HTMLSelectElement>('#conclude-outcome')!
    select.value = outcome; select.dispatchEvent(new Event('change')); await flush()
    button('确认完成').click(); await flush()
    expect(completeInterview).toHaveBeenCalledWith('final-1', outcome)
    if (outcome === 'offer') await vi.waitFor(() => expect(router.currentRoute.value.query).toEqual({ createApplicationId: 'app-1' }))
    expect(root!.querySelector('[role="dialog"]')).toBeNull()
    expect(submitFeedback).not.toHaveBeenCalled()
  })

  it('keeps the interview list visible while synchronizing after completion', async () => {
    const scheduled = { ...finalInterview(), stage: 'initial' as const, round: '1 轮', scheduledAt: '10/29 10:00' }
    const completed = { ...scheduled, status: 'completed', outcome: 'continue' as const, feedbackStatus: 'completed' as const }
    let resolveSync!: (rows: InterviewView[]) => void
    mockedLoadInterviews
      .mockResolvedValueOnce([scheduled])
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSync = resolve }))
    vi.mocked(completeInterview).mockResolvedValue({})

    await mountPage()
    button('完成').click()
    await flush()
    button('确认完成').click()
    await flush()

    expect(completeInterview).toHaveBeenCalledWith('final-1', 'continue')
    expect(root!.querySelector('.loading-note')).toBeNull()
    expect(root!.querySelector('.interview-filters')).toBeTruthy()
    expect(root!.querySelector('.table-wrap')).toBeTruthy()
    expect(root!.textContent).toContain('初试通过')

    resolveSync([completed])
    await flush()
    expect(mockedLoadInterviews).toHaveBeenCalledTimes(2)
  })

  it('prevents duplicate completion and keeps failures in the dialog for retry', async () => {
    mockedLoadInterviews.mockResolvedValue([{ ...finalInterview(), stage: 'initial', round: '1 轮', scheduledAt: '10/29 10:00' }])
    let fail!: (error: Error) => void
    vi.mocked(completeInterview).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    await mountPage(); button('完成').click(); await flush()
    const submit = button('确认完成'); submit.click(); submit.click(); await flush()
    expect(completeInterview).toHaveBeenCalledTimes(1)
    expect(button('取消').disabled).toBe(true)
    fail(new Error('连接暂不可用')); await flush()
    expect(root!.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('连接暂不可用')
    vi.mocked(completeInterview).mockResolvedValue({})
    button('确认完成').click(); await flush()
    expect(completeInterview).toHaveBeenCalledTimes(2)
  })
  it('refreshes pending final interviews each time arrangement opens', async () => {
    mockedLoadInterviews.mockResolvedValueOnce([]).mockResolvedValue([finalInterview()])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await mountPage()
    button('安排面试').click()
    await flush()
    expect(mockedLoadInterviews).toHaveBeenCalledTimes(2)
    expect(root!.querySelector('.arrange-dialog')?.textContent).toContain('王五')
    expect(root!.querySelector('.arrange-dialog')?.textContent).not.toContain('暂无通过初试')
  })

  it('only lists pending finals without adding a second initial-pass confirmation', async () => {
    mockedLoadInterviews.mockResolvedValue([
      finalInterview({ entityId: 'initial-1', candidate: '已完成初试', stage: 'initial', round: '1 轮', status: 'completed', feedbackStatus: 'completed' }),
      finalInterview({ entityId: 'initial-2', candidate: '仅锁定反馈', stage: 'initial', round: '1 轮', feedbackStatus: 'completed', applicationId: 'app-2' }),
      finalInterview(),
    ])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await mountPage()
    button('安排面试').click()
    await flush()
    const dialog = root!.querySelector('.arrange-dialog')!
    expect(dialog.textContent).not.toContain('待确认结论')
    expect(dialog.textContent).not.toContain('确认初试通过')
    expect(dialog.textContent).not.toContain('已完成初试')
    expect(dialog.textContent).not.toContain('仅锁定反馈')
    const select = dialog.querySelector('#final-interview-select') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['', 'final-1'])
    expect(select.value).toBe('final-1')
    expect(concludeInterview).not.toHaveBeenCalled()
    expect(createInterview).not.toHaveBeenCalled()
  })

  it('does not advance an initial interview merely by opening arrangement', async () => {
    mockedLoadInterviews.mockResolvedValue([finalInterview({ stage: 'initial', round: '1 轮', feedbackStatus: 'completed' })])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await mountPage()
    button('安排面试').click()
    await flush()
    expect(button('确认初试通过')).toBeUndefined()
    expect(root!.querySelector('.arrange-dialog')?.textContent).toContain('暂无通过初试')
    expect(concludeInterview).not.toHaveBeenCalled()
  })

  it('never offers another final round when a cancelled final already exists', async () => {
    mockedLoadInterviews.mockResolvedValue([
      finalInterview({ entityId: 'initial-1', stage: 'initial', round: '1 轮' }),
      finalInterview({ status: 'cancelled' }),
    ])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [] })
    await mountPage()
    button('安排面试').click()
    await flush()
    expect(button('确认初试通过')).toBeUndefined()
    expect(root!.querySelector('.arrange-dialog')?.textContent).toContain('暂无通过初试')
  })

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
      finalInterview({ entityId: 'scheduled', candidate: '已安排复试', scheduledAt: '11-01 10:00', scheduledStartAt: '2026-11-01T02:00:00Z', interviewerIds: ['interviewer-1'] }),
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

  it('opens an incomplete final schedule by exact ID and retains its time and meeting when assigning an interviewer', async () => {
    mockedLoadInterviews.mockResolvedValue([
      finalInterview({ entityId: 'other-final' }),
      finalInterview({ scheduledStartAt: '2026-11-19T02:00:00Z', scheduledAt: '11-19 11:00', meetingUrl: 'https://meeting.example.com/retained' }),
    ])
    mockedLoadApplications.mockResolvedValue({ candidates: [], jobs: [], applications: [], interviewers: [{ id: '77777777-7777-4777-8777-777777777777', displayName: '林晓' }] })
    mockedUpdateSchedule.mockResolvedValue({} as never)
    await mountPage('/interviews?applicationId=app-1&interviewId=final-1&stage=final')
    expect((root!.querySelector('#final-interview-select') as HTMLSelectElement).value).toBe('final-1')
    const time = root!.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    expect(new Date(time.value).toISOString()).toBe('2026-11-19T02:00:00.000Z')
    expect(root!.querySelector<HTMLInputElement>('input[placeholder="https://..."]')!.value).toBe('https://meeting.example.com/retained')
    const interviewer = root!.querySelector<HTMLInputElement>('input[type="checkbox"][value="77777777-7777-4777-8777-777777777777"]')!
    interviewer.checked = true
    interviewer.dispatchEvent(new Event('change'))
    await flush()
    button('确认安排复试').click()
    await flush()
    expect(mockedUpdateSchedule).toHaveBeenCalledWith('final-1', expect.objectContaining({
      scheduledStartAt: '2026-11-19T02:00:00.000Z', meetingUrl: 'https://meeting.example.com/retained',
      participants: [expect.objectContaining({ userId: '77777777-7777-4777-8777-777777777777' })],
    }))
    expect(mockedCreateInterview).not.toHaveBeenCalled()
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

  it('requires an interviewer when creating a scheduled initial invitation', async () => {
    mockedLoadInterviews.mockResolvedValue([])
    mockedLoadApplications.mockResolvedValue({
      candidates: [{ id: 'candidate-1', code: 'CAN-1', fullName: '王五' }],
      jobs: [{ id: 'job-1', code: 'JOB-1', title: '后端工程师' }],
      applications: [{ id: 'app-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' }],
      interviewers: [],
    })
    mockedCreateInterview.mockResolvedValue({} as never)
    await mountPage('/interviews?applicationId=app-1&stage=initial')
    expect(root!.textContent).toContain('面试官 · 已选 0 人')
    const time = root!.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    time.value = '2026-11-01T10:00'; time.dispatchEvent(new Event('input'))
    const meeting = root!.querySelector<HTMLInputElement>('input[placeholder="https://..."]')!
    meeting.value = 'https://meeting.example.com/initial'; meeting.dispatchEvent(new Event('input'))
    await flush()
    button('创建初试邀约').click()
    await flush()

    expect(mockedCreateInterview).not.toHaveBeenCalled()
    expect(root!.textContent).toContain('请至少选择一名有效面试官')
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
      participants: [support, { userId: '77777777-7777-4777-8777-777777777777', name: '林晓', role: 'interviewer', required: true, lead: true, sheetTypes: ['business','hr','boss'] }],
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

  it('completes from one entry without creating a separate feedback record', async () => {
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

    expect(button('填写反馈')).toBeUndefined()
    expect(button('完成面试')).toBeUndefined()
    vi.mocked(completeInterview).mockResolvedValue({})
    button('完成').click()
    await flush()
    expect(root.querySelector('.dialog h3')?.textContent).toBe('完成初试')
    expect([...root.querySelectorAll('#conclude-outcome option')].map(option => option.textContent)).toEqual(['下一轮', '未通过', '取消面试'])
    button('确认完成').click()
    await flush()
    expect(completeInterview).toHaveBeenCalledWith('interview-1', 'continue')
    expect(submitFeedback).not.toHaveBeenCalled()
    expect(lockFeedback).not.toHaveBeenCalled()
  })

  it('allows completion without a system interviewer', async () => {
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

    expect(root.textContent).not.toContain('需重排面试官')
    expect(button('完成')).toBeDefined()
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
