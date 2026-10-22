// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewListPage from './InterviewListPage.vue'
import InterviewDetailPage from './InterviewDetailPage.vue'
import { concludeInterview, getInterview, loadInterviews } from '../api'
import { apiClient } from '../../../shared/api'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  concludeInterview: vi.fn(),
  getInterview: vi.fn(),
  loadInterviews: vi.fn(),
}))
vi.mock('../../../shared/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../shared/api')>(),
  apiClient: { getJson: vi.fn() },
}))
vi.mock('../../../shared/api/workflow-events', () => ({ loadWorkflowEvents: vi.fn().mockResolvedValue([]) }))
vi.mock('../components/InterviewSummaryDialog.vue', () => ({ default: { template: '<div />' } }))
vi.mock('../components/QuestionSheetDialog.vue', () => ({ default: { template: '<div />' } }))

let app: App | undefined
let root: HTMLDivElement

async function flush() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function button(label: string, container: Element = root): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  expect(match, `Missing button: ${label}`).toBeTruthy()
  return match!
}

function dialog(): HTMLElement {
  const match = root.querySelector<HTMLElement>('[role="dialog"]')
  expect(match).not.toBeNull()
  return match!
}

async function chooseOutcome(outcome: string) {
  const select = dialog().querySelector('select')!
  select.value = outcome
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flush()
}

afterEach(() => {
  app?.unmount()
  root?.remove()
  vi.resetAllMocks()
})

describe.each(['list', 'detail'] as const)('Interview conclusion from %s', (entry) => {
  async function mount() {
    vi.mocked(loadInterviews).mockResolvedValue([{
      id: 'INT-1', entityId: 'interview-1', candidate: '林晓', job: '商务', round: '1 轮',
      scheduledAt: '待安排', interviewers: [], interviewerIds: [], interviewerOptions: [],
      feedbackStatus: 'scheduled', status: 'scheduled', applicationId: 'app-1',
    }])
    vi.mocked(getInterview).mockResolvedValue({
      id: 'interview-1', code: 'INT-1', title: '商务面试', applicationId: 'app-1', round: 1,
      type: 'technical', status: 'scheduled', timezone: 'Asia/Shanghai',
      participants: [], feedbackStatus: 'pending', feedback: [],
      application: { id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' },
      createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z',
    })
    vi.mocked(apiClient.getJson).mockImplementation(async (path) => ({
      ok: true, requestId: 'test', data: path === '/candidates'
        ? [{ id: 'candidate-1', fullName: '林晓' }]
        : [{ id: 'job-1', title: '商务' }],
    }) as never)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/interviews/:id?', component: { template: '<div />' } }],
    })
    await router.push(entry === 'list' ? '/interviews' : '/interviews/interview-1')
    await router.isReady()
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(entry === 'list' ? InterviewListPage : InterviewDetailPage)
    app.use(router)
    app.mount(root)
    await flush()
    button('完成面试').click()
    await flush()
  }

  it('shows feedback-lock failures inside the dialog and lets the user retry', async () => {
    vi.mocked(concludeInterview)
      .mockRejectedValueOnce(Object.assign(new Error('所有面试反馈锁定后才能完成面试'), { code: 'INTERVIEW_FEEDBACK_INCOMPLETE' }))
      .mockResolvedValueOnce({})
    await mount()
    await chooseOutcome('reject')
    button('确认完成', dialog()).click()
    await flush()

    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('请先填写并锁定所有面试官的综合反馈')
    expect(button('确认完成', dialog()).disabled).toBe(false)
    expect(dialog().querySelector('select')?.value).toBe('reject')
    button('确认完成', dialog()).click()
    await flush()

    expect(concludeInterview).toHaveBeenNthCalledWith(1, 'interview-1', 'reject')
    expect(concludeInterview).toHaveBeenNthCalledWith(2, 'interview-1', 'reject')
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(root.textContent).toContain('面试已完成：未通过')
    expect(entry === 'list' ? loadInterviews : getInterview).toHaveBeenCalledTimes(2)
  })

  it('keeps network errors visible in the modal and clears them on reopening', async () => {
    vi.mocked(concludeInterview).mockRejectedValue(new Error('网络连接失败，请重试'))
    await mount()
    button('确认完成', dialog()).click()
    await flush()

    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('网络连接失败，请重试')
    button('取消', dialog()).click()
    await flush()
    expect(root.textContent).not.toContain('网络连接失败')
    button('完成面试').click()
    await flush()
    expect(dialog().querySelector('[role="alert"]')).toBeNull()
  })

  it.each([
    ['continue', '进入下一轮'], ['offer', '通过，进入 Offer 阶段'], ['reject', '未通过'],
  ])('submits %s and retains success feedback after refreshing', async (outcome, label) => {
    vi.mocked(concludeInterview).mockResolvedValue({})
    await mount()
    await chooseOutcome(outcome)
    button('确认完成', dialog()).click()
    await flush()

    expect(concludeInterview).toHaveBeenCalledTimes(1)
    expect(concludeInterview).toHaveBeenCalledWith('interview-1', outcome)
    expect(root.querySelector('[role="dialog"]')).toBeNull()
    expect(root.textContent).toContain(`面试已完成：${label}`)
    expect(entry === 'list' ? loadInterviews : getInterview).toHaveBeenCalledTimes(2)
  })

  it('locks the outcome and backdrop while submitting and prevents duplicate requests', async () => {
    let resolve!: (value: unknown) => void
    vi.mocked(concludeInterview).mockReturnValue(new Promise((done) => { resolve = done }))
    await mount()
    const submit = button('确认完成', dialog())
    submit.click()
    submit.click()
    await flush()

    expect(concludeInterview).toHaveBeenCalledTimes(1)
    expect(button('提交中...', dialog()).disabled).toBe(true)
    expect(button('取消', dialog()).disabled).toBe(true)
    expect(dialog().querySelector('select')?.disabled).toBe(true)
    root.querySelector<HTMLElement>('.overlay')!.click()
    await flush()
    expect(root.querySelector('[role="dialog"]')).not.toBeNull()

    resolve({})
    await flush()
    expect(root.querySelector('[role="dialog"]')).toBeNull()
  })
})
