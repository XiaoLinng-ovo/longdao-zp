// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewDetailPage from './InterviewDetailPage.vue'
import { getInterview, updateInterviewSchedule, type ApiInterviewDetail } from '../api'
import { apiClient } from '../../../shared/api'

vi.mock('../api', async (original) => ({ ...await original<typeof import('../api')>(), getInterview: vi.fn(), updateInterviewSchedule: vi.fn() }))
vi.mock('../../../shared/api', async (original) => ({ ...await original<typeof import('../../../shared/api')>(), apiClient: { getJson: vi.fn() } }))
vi.mock('../../../shared/api/workflow-events', () => ({ loadWorkflowEvents: vi.fn().mockResolvedValue([]) }))

let app: App | undefined
let root: HTMLDivElement
async function flush() {
  for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() }
}
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

const fixture: ApiInterviewDetail = {
  id: 'interview-1', code: 'INT-1', applicationId: 'app-1', round: 1, type: 'technical', title: '技术面试', status: 'scheduled',
  scheduledStartAt: '2026-10-16T02:00:12.000Z', scheduledEndAt: '2026-10-16T03:00:00.000Z', timezone: 'Asia/Shanghai',
  location: 'A会议室', meetingUrl: 'https://meeting.example/old', participants: [{ userId: 'user-1', name: '面试官甲', role: 'interviewer', required: true }],
  feedbackStatus: 'pending', application: { id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' },
  feedback: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
}

async function mountSchedule(status: ApiInterviewDetail['status'] = 'scheduled') {
  vi.mocked(getInterview).mockResolvedValue({ ...fixture, status })
  vi.mocked(apiClient.getJson).mockImplementation(async (path) => ({ data: path === '/candidates' ? [{ id: 'candidate-1', fullName: '候选人甲' }] : [{ id: 'job-1', title: '工程师' }] }) as never)
  root = document.createElement('div')
  document.body.appendChild(root)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/interviews/:id', component: { template: '<div />' } }] })
  await router.push('/interviews/interview-1')
  await router.isReady()
  app = createApp(InterviewDetailPage).use(router)
  app.mount(root)
  await flush()
}
async function open() {
  ;[...root.querySelectorAll('button')].find((button) => button.textContent === '编辑安排')!.click()
  await flush()
}
async function fill(id: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`#schedule-${id}`)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}
async function save() {
  root.querySelector('form.schedule-dialog')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}

describe('编辑面试安排', () => {
  it('only patches changed fields and clears URL/end without shifting start time', async () => {
    await mountSchedule()
    vi.mocked(updateInterviewSchedule).mockResolvedValue({ scheduledStartAt: fixture.scheduledStartAt, location: 'B会议室', updatedAt: '2026-10-16T04:00:00Z' })
    await open()
    await fill('location', ' B会议室 ')
    await fill('url', '')
    await fill('end', '')
    await save()
    expect(updateInterviewSchedule).toHaveBeenCalledWith('interview-1', { location: 'B会议室', scheduledEndAt: null, meetingUrl: null })
    expect(root.querySelector('.schedule-dialog')).toBeNull()
    expect(root.textContent).toContain('面试安排已更新')
    expect(root.querySelector('.meeting-details')!.textContent).toBe('B会议室')
    expect(root.textContent).toContain('面试官甲')
    await open()
    expect(root.querySelector<HTMLInputElement>('#schedule-url')!.value).toBe('')
    expect(root.querySelector<HTMLInputElement>('#schedule-end')!.value).toBe('')
  })

  it('submits changed local date/time as UTC', async () => {
    await mountSchedule()
    const start = '2026-10-18T14:00', end = '2026-10-18T15:00'
    vi.mocked(updateInterviewSchedule).mockResolvedValue({ ...fixture, scheduledStartAt: new Date(start).toISOString(), scheduledEndAt: new Date(end).toISOString() })
    await open()
    await fill('start', start)
    await fill('end', end)
    await save()
    expect(updateInterviewSchedule).toHaveBeenCalledWith('interview-1', { scheduledStartAt: new Date(start).toISOString(), scheduledEndAt: new Date(end).toISOString() })
  })

  it('does not submit cancelled edits or unchanged fields', async () => {
    await mountSchedule()
    await open()
    await fill('location', '不保存')
    const cancel = [...root.querySelectorAll<HTMLButtonElement>('.schedule-dialog button')].find((button) => button.textContent === '取消')!
    cancel.click()
    await flush()
    await open()
    expect(root.querySelector<HTMLInputElement>('#schedule-location')!.value).toBe('A会议室')
    await save()
    expect(updateInterviewSchedule).not.toHaveBeenCalled()
  })

  it('validates times and URLs and preserves failed edits for retry', async () => {
    await mountSchedule()
    await open()
    await fill('end', '2026-10-15T00:00')
    await save()
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('结束时间必须晚于')
    expect(updateInterviewSchedule).not.toHaveBeenCalled()
    await fill('end', '')
    await fill('url', 'ftp://meeting.example')
    await save()
    expect(root.querySelector('[role="alert"]')!.textContent).toContain('http:// 或 https://')
    expect(updateInterviewSchedule).not.toHaveBeenCalled()
    await fill('url', 'https://meeting.example/new')
    vi.mocked(updateInterviewSchedule).mockRejectedValue(new Error('网络暂时不可用'))
    await save()
    expect(root.querySelector('.schedule-dialog')).not.toBeNull()
    expect(root.querySelector<HTMLInputElement>('#schedule-url')!.value).toBe('https://meeting.example/new')
    expect(root.querySelector('.meeting-details')!.textContent).toContain(fixture.meetingUrl)
    expect(root.querySelector('[role="alert"]')).not.toBeNull()
  })

  it.each(['completed', 'cancelled'] as const)('hides editing for %s interviews', async (status) => {
    await mountSchedule(status)
    expect([...root.querySelectorAll('button')].some((button) => button.textContent === '编辑安排')).toBe(false)
  })

  it('prefills local time and displays both physical location and meeting URL', async () => {
    await mountSchedule()
    expect(root.querySelector('.meeting-details')!.textContent).toContain('A会议室')
    expect(root.querySelector('.meeting-details')!.textContent).toContain(fixture.meetingUrl)
    await open()
    const start = root.querySelector<HTMLInputElement>('#schedule-start')!.value
    expect(new Date(start).getTime()).toBe(new Date(fixture.scheduledStartAt!).getTime() - 12000)
    expect(root.querySelector<HTMLInputElement>('#schedule-location')!.value).toBe('A会议室')
    expect(root.querySelector<HTMLInputElement>('#schedule-url')!.value).toBe(fixture.meetingUrl)
  })
})
