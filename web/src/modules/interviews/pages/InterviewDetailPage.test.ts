// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import InterviewDetailPage from './InterviewDetailPage.vue'
import { getInterview } from '../api'
import { apiClient } from '../../../shared/api'
import { loadWorkflowEvents } from '../../../shared/api/workflow-events'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getInterview: vi.fn(),
    concludeInterview: vi.fn(),
    lockFeedback: vi.fn(),
    submitFeedback: vi.fn(),
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

async function flush() {
  for (let index = 0; index < 20; index += 1) {
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

describe('InterviewDetailPage', () => {
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
    expect(root.textContent).toContain('逐题评价与 AI 评分')
    expect(root.textContent).toContain('填写综合反馈')
    expect(root.textContent).toContain('技术面试')
    expect(root.textContent).toContain('面试官甲')
    expect(root.textContent).not.toContain('基础信息')
    expect(root.textContent).not.toContain('面试操作')
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
