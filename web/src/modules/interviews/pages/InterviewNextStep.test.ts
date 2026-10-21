// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewListPage from './InterviewListPage.vue'
import { createInterview, loadInterviewScheduleData, loadInterviews, type InterviewScheduleData } from '../api'
import { createApplication } from '../../candidates/api'

vi.mock('../api', async (importOriginal) => ({ ...await importOriginal<typeof import('../api')>(),
  loadInterviews: vi.fn(), loadInterviewScheduleData: vi.fn(), createInterview: vi.fn(),
}))
vi.mock('../../candidates/api', async (importOriginal) => ({ ...await importOriginal<typeof import('../../candidates/api')>(), createApplication: vi.fn() }))
let app: App | undefined, root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 24; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks() })
function options(status = 'interviewing'): InterviewScheduleData {
  return { candidates: [{ id: 'candidate-1', code: 'CAN-1', fullName: '测试候选人' }],
    jobs: [{ id: 'job-1', code: 'JOB-1', title: '算法工程师' }],
    applications: [{ id: 'app-1', candidateId: 'candidate-1', jobId: 'job-1', status }],
    interviewers: [{ id: 'user-1', displayName: '测试面试官' }] }
}
async function mount(query: Record<string, string> = { applicationId: 'app-1', filter: 'keep' }) {
  vi.mocked(loadInterviews).mockResolvedValue([])
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/interviews', name: 'interviews', component: { template: '<div />' } }] })
  await router.push({ name: 'interviews', query }); await router.isReady()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(InterviewListPage); app.use(router); app.mount(root); await flush()
  return router
}
function button(text: string) { return [...root!.querySelectorAll('button')].find(item => item.textContent?.trim() === text) }
async function selectInterviewer() { const select = root!.querySelector<HTMLSelectElement>('select[aria-label="面试官"]')!; select.value = 'user-1'; select.dispatchEvent(new Event('change')); await flush() }

describe('schedule interview from a passed resume application', () => {
  it('preselects and locks the candidate/job, reuses the original application and clears the deep link after success', async () => {
    vi.mocked(loadInterviewScheduleData).mockResolvedValue(options())
    vi.mocked(createInterview).mockResolvedValue({} as never)
    const router = await mount()
    const candidate = root!.querySelector<HTMLInputElement>('input[placeholder="输入候选人姓名或编号搜索"]')!
    const job = root!.querySelector<HTMLSelectElement>('select[aria-label="岗位"]')!
    expect(candidate.value).toBe('测试候选人（CAN-1）'); expect(candidate.disabled).toBe(true)
    expect(job.value).toBe('job-1'); expect(job.disabled).toBe(true)
    await selectInterviewer(); button('创建面试')!.click(); await flush()
    expect(createApplication).not.toHaveBeenCalled()
    expect(createInterview).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'app-1' }))
    expect(root!.querySelector('.arrange-dialog')).toBeNull()
    expect(root!.textContent).toContain('面试已创建')
    expect(router.currentRoute.value.query).toEqual({ filter: 'keep' })
  })
  it.each(['human_review', 'rejected', 'offer_accepted'])('blocks scheduling when the application is now %s', async (status) => {
    vi.mocked(loadInterviewScheduleData).mockResolvedValue(options(status)); await mount()
    expect(root!.querySelector('[role=alert]')?.textContent).toContain('不在待面试阶段')
    expect(button('创建面试')!.disabled).toBe(true)
    button('创建面试')!.click(); await flush()
    expect(createInterview).not.toHaveBeenCalled(); expect(createApplication).not.toHaveBeenCalled()
  })
  it('never falls back to a new application when the requested application is missing or out of scope', async () => {
    vi.mocked(loadInterviewScheduleData).mockResolvedValue({ ...options(), applications: [] }); await mount()
    expect(root!.querySelector('[role=alert]')?.textContent).toContain('无权访问')
    expect(button('创建面试')!.disabled).toBe(true)
    expect(createApplication).not.toHaveBeenCalled()
  })
  it('can retry a failed loading request and still reuse the original application', async () => {
    vi.mocked(loadInterviewScheduleData).mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce(options())
    await mount(); expect(button('创建面试')!.disabled).toBe(true)
    button('重试')!.click(); await flush()
    expect(root!.querySelector('[role=alert]')).toBeNull()
    expect(root!.querySelector<HTMLSelectElement>('select[aria-label="岗位"]')!.value).toBe('job-1')
    expect(button('创建面试')!.disabled).toBe(false)
  })
  it('clears only applicationId on cancel, so revisiting does not reopen the same arrangement', async () => {
    vi.mocked(loadInterviewScheduleData).mockResolvedValue(options()); const router = await mount()
    button('取消')!.click(); await flush()
    expect(root!.querySelector('.arrange-dialog')).toBeNull()
    expect(router.currentRoute.value.query).toEqual({ filter: 'keep' })
    expect(createInterview).not.toHaveBeenCalled()
  })
  it('ignores an obsolete load response when the route changes to another application', async () => {
    let completeFirst!: (value: InterviewScheduleData) => void
    vi.mocked(loadInterviewScheduleData).mockImplementationOnce(() => new Promise(resolve => { completeFirst = resolve }))
      .mockResolvedValueOnce({ ...options(), applications: [{ ...options().applications[0]!, id: 'app-2' }] })
    const router = await mount()
    await router.push({ query: { applicationId: 'app-2' } }); await flush()
    completeFirst(options()); await flush()
    vi.mocked(createInterview).mockResolvedValue({} as never)
    await selectInterviewer(); button('创建面试')!.click(); await flush()
    expect(createInterview).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'app-2' }))
    expect(createApplication).not.toHaveBeenCalled()
  })
})

describe('initial interview invitation modes', () => {
  it.each(['online', 'offline'])('requires date and %s contact details and reuses the original application', async (mode) => {
    vi.mocked(loadInterviewScheduleData).mockResolvedValue(options())
    vi.mocked(createInterview).mockResolvedValue({} as never)
    const router = await mount({ applicationId: 'app-1', stage: 'initial', filter: 'keep' })
    expect(root!.querySelector('.arrange-dialog h3')?.textContent).toBe('初试邀约')
    const select = root!.querySelector<HTMLSelectElement>('[aria-label="初试方式"]')!
    select.value = mode; select.dispatchEvent(new Event('change')); await flush()
    await selectInterviewer()
    button('创建面试')!.click(); await flush()
    expect(root!.textContent).toContain('请选择初试开始时间')
    const date = root!.querySelector<HTMLInputElement>('input[type="datetime-local"]')!
    date.value = '2026-10-20T10:00'; date.dispatchEvent(new Event('input')); await flush()
    button('创建面试')!.click(); await flush()
    expect(root!.textContent).toContain(mode === 'online' ? '请填写线上初试会议链接' : '请填写线下初试地点')
    expect(createInterview).not.toHaveBeenCalled()
    const field = root!.querySelector<HTMLInputElement>(mode === 'online' ? 'input[placeholder="https://..."]' : 'input[placeholder="线下地点"]')!
    field.value = mode === 'online' ? 'https://meeting.example.invalid/initial' : '办公室 201'
    field.dispatchEvent(new Event('input')); await flush()
    button('创建面试')!.click(); await flush()
    expect(createInterview).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'app-1', title: '初试',
      ...(mode === 'online' ? { meetingUrl: field.value, location: undefined } : { location: field.value, meetingUrl: undefined }) }))
    expect(createApplication).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query).toEqual({ filter: 'keep' })
  })
})
