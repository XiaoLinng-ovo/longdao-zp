// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewDetailPage from './InterviewDetailPage.vue'
import { completeInterview, correctInterviewConclusion, getInterview } from '../api'
import { apiClient } from '../../../shared/api'
import { loadWorkflowEvents } from '../../../shared/api/workflow-events'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getInterview: vi.fn(),
    completeInterview: vi.fn(),
    correctInterviewConclusion: vi.fn(),
    updateInterviewSchedule: vi.fn(),
  }
})
vi.mock('../../../shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/api')>()
  return { ...actual, apiClient: { getJson: vi.fn() } }
})
vi.mock('../../../shared/api/workflow-events', () => ({ loadWorkflowEvents: vi.fn().mockResolvedValue([]) }))
vi.mock('../api/question-sheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/question-sheets')>()
  return {
    ...actual,
    loadQuestionSheets: vi.fn().mockResolvedValue({ applicationId: 'app-1', sheets: [], reviews: [], stages: [] }),
  }
})

const mockedGetInterview = vi.mocked(getInterview)
const mockedGetJson = vi.mocked(apiClient.getJson)

let app: App | undefined
let root: HTMLDivElement | undefined
const baseInterview = {
  id: 'interview-1',
  code: 'INT-1',
  applicationId: 'app-1',
  round: 1,
  type: 'technical',
  title: '技术面试',
  timezone: 'Asia/Shanghai',
  participants: [{ userId: 'user-1', name: '面试官甲', role: 'interviewer', required: true }],
  feedbackStatus: 'pending',
  application: { id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' },
  feedback: [],
  createdAt: '2026-09-20T00:00:00Z',
  updatedAt: '2026-09-20T00:00:00Z',
}

async function flush() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function mountPage(status: 'scheduled' | 'completed' | 'cancelled', overrides: Record<string, unknown> = {}) {
  mockedGetInterview.mockResolvedValue({ ...baseInterview, ...overrides, status } as never)
  mockedGetJson.mockImplementation(async (path) => {
    if (path === '/candidates') return { ok: true, requestId: 'test', data: [{ id: 'candidate-1', code: 'CAN-1', fullName: '跨部门候选人' }] } as never
    if (path === '/jobs') return { ok: true, requestId: 'test', data: [{ id: 'job-1', title: '跨部门越权验证岗位' }] } as never
    throw new Error(`unexpected path ${path}`)
  })
  root = document.createElement('div')
  document.body.appendChild(root)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/interviews', component: { template: '<div />' } },
      { path: '/interviews/:id', component: { template: '<div />' } },
    ],
  })
  await router.push('/interviews/interview-1')
  await router.isReady()
  app = createApp(InterviewDetailPage)
  app.use(router)
  app.mount(root)
  await flush()
  return root
}

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  vi.resetAllMocks()
})

describe('InterviewDetailPage', () => {
  it('允许从详情修改已记录的结论并填写原因', async () => {
    vi.mocked(correctInterviewConclusion).mockResolvedValue({})
    const page = await mountPage('completed', { outcome: 'reject' })
    const action = [...page.querySelectorAll('button')].find((item) => item.textContent?.trim() === '修改面试结论')
    expect(action).toBeTruthy()
    expect(action?.classList.contains('btn-primary')).toBe(true)
    expect(action?.textContent?.trim()).toBe('修改面试结论')
    action!.click()
    await flush()
    const dialog = page.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('未通过')
    const select = dialog.querySelector('select') as HTMLSelectElement
    select.value = 'continue'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const reason = dialog.querySelector('textarea') as HTMLTextAreaElement
    reason.value = '复核后发现选择有误'
    reason.dispatchEvent(new Event('input', { bubbles: true }))
    dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(correctInterviewConclusion).toHaveBeenCalledWith('interview-1', 'continue', '复核后发现选择有误')
    expect(page.textContent).toContain('面试结论已更正')
  })

  it('已完成的面试只提供查看记录入口，不再显示进入 AI 面试室', async () => {
    const page = await mountPage('completed')

    expect(page.textContent).toContain('查看面试记录')
    expect(page.textContent).not.toContain('进入 AI 面试室')
  })

  it('已取消的面试不显示实时面试入口', async () => {
    const page = await mountPage('cancelled')

    expect(page.textContent).not.toContain('查看面试记录')
    expect(page.textContent).not.toContain('进入 AI 面试室')
  })

  it('renders a compact key-information summary instead of repeated detail cards', async () => {
    mockedGetInterview.mockResolvedValue({
      id: 'interview-1',
      code: 'INT-1',
      applicationId: 'app-1',
      round: 1,
      type: 'technical',
      title: '技术面试',
      status: 'scheduled',
      timezone: 'Asia/Shanghai',
      participants: [{ userId: 'user-1', name: '面试官甲', role: 'interviewer', required: true }],
      feedbackStatus: 'pending',
      application: { id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' },
      feedback: [],
      createdAt: '2026-09-20T00:00:00Z',
      updatedAt: '2026-09-20T00:00:00Z',
    })
    mockedGetJson.mockImplementation(async (path) => {
      if (path === '/candidates') return { ok: true, requestId: 'test', data: [{ id: 'candidate-1', code: 'CAN-1', fullName: '跨部门候选人' }] } as never
      if (path === '/jobs') return { ok: true, requestId: 'test', data: [{ id: 'job-1', title: '跨部门越权验证岗位' }] } as never
      throw new Error(`unexpected path ${path}`)
    })

    root = document.createElement('div')
    document.body.appendChild(root)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/interviews', component: { template: '<div />' } },
        { path: '/interviews/:id', component: { template: '<div />' } },
      ],
    })
    await router.push('/interviews/interview-1')
    await router.isReady()
    app = createApp(InterviewDetailPage)
    app.use(router)
    app.mount(root)
    await flush()

    expect(vi.mocked(loadWorkflowEvents)).toHaveBeenCalledWith(undefined, 500, 'candidate-1')
    expect(root.querySelector('.interview-summary')).not.toBeNull()
    expect(root.textContent).toContain('考察点评分')
    expect(root.textContent).toContain('完成面试')
    expect(root.textContent).not.toContain('填写综合反馈')
    expect(root.textContent).toContain('技术面试')
    expect(root.textContent).toContain('面试官甲')
    expect(root.textContent).not.toContain('基础信息')
    expect(root.textContent).not.toContain('面试操作')
  })

  it('keeps historical feedback visible without exposing the old feedback form', async () => {
    const page = await mountPage('completed', {
      feedback: [{
        id: 'feedback-1',
        interviewId: 'interview-1',
        interviewerId: 'user-1',
        status: 'locked',
        overallScore: 88,
        recommendation: 'yes',
        ratings: {},
        strengths: ['基础扎实'],
        concerns: ['沟通需继续观察'],
        notes: '历史反馈',
        submittedAt: '2026-09-20T01:00:00Z',
        lockedAt: '2026-09-20T01:05:00Z',
      }],
    })

    expect(page.textContent).toContain('历史反馈')
    expect(page.textContent).toContain('基础扎实')
    expect(page.textContent).not.toContain('填写综合反馈')
    expect(completeInterview).not.toHaveBeenCalled()
  })

  it('面试问题表通过弹窗打开，不直接铺在页面上', async () => {
    mockedGetInterview.mockResolvedValue({
      id: 'interview-1',
      code: 'INT-1',
      applicationId: 'app-1',
      round: 2,
      stage: 'final',
      type: 'onsite',
      title: '复试',
      status: 'scheduled',
      timezone: 'Asia/Shanghai',
      participants: [{ userId: 'user-1', name: '面试官甲', role: 'interviewer', required: true }],
      feedbackStatus: 'pending',
      application: { id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing' },
      feedback: [],
      createdAt: '2026-09-20T00:00:00Z',
      updatedAt: '2026-09-20T00:00:00Z',
    })
    mockedGetJson.mockImplementation(async (path) => {
      if (path === '/candidates') return { ok: true, requestId: 'test', data: [{ id: 'candidate-1', code: 'CAN-1', fullName: '跨部门候选人' }] } as never
      if (path === '/jobs') return { ok: true, requestId: 'test', data: [{ id: 'job-1', title: '跨部门越权验证岗位' }] } as never
      throw new Error(`unexpected path ${path}`)
    })

    root = document.createElement('div')
    document.body.appendChild(root)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/interviews', component: { template: '<div />' } },
        { path: '/interviews/:id', component: { template: '<div />' } },
      ],
    })
    await router.push('/interviews/interview-1')
    await router.isReady()
    app = createApp(InterviewDetailPage)
    app.use(router)
    app.mount(root)
    await flush()

    expect(root.querySelector('.sheet-panel')).toBeNull()
    const trigger = [...root.querySelectorAll('button')].find((button) => button.textContent?.includes('面试问题表'))
    expect(trigger).toBeTruthy()
    trigger?.click()
    await flush()

    expect(root.querySelector('.sheet-dialog')).not.toBeNull()
    expect(root.querySelector('.sheet-panel')).not.toBeNull()
  })
})
