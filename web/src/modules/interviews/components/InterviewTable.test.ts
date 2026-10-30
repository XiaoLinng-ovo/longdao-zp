// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import InterviewTable from './InterviewTable.vue'
import type { InterviewView } from '../api'

let app: App | undefined
let root: HTMLDivElement | undefined
afterEach(() => { app?.unmount(); root?.remove() })
const row = (overrides: Partial<InterviewView> = {}): InterviewView => ({
  id: 'INT-1', entityId: 'interview-1', applicationId: 'app-1', candidate: '测试候选人', job: '工程师',
  stage: 'initial', round: '1 轮', scheduledAt: '10/30 15:30', interviewers: [], interviewerIds: [], interviewerOptions: [],
  status: 'scheduled', feedbackStatus: 'scheduled', ...overrides,
})
function mount(item: InterviewView) {
  const onPrepare = vi.fn()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp({ render: () => h(InterviewTable, { rows: [item], onPrepare }) }); app.mount(root)
  return { el: root, onPrepare }
}

describe('interview preparation diagnostics', () => {
  it('shows the actual failure, separate rubric progress, and a diagnostic reference without hover', () => {
    const item = row({ questionPreparation: {
      status: 'failed', completedGroups: ['ai'], rubricsStatus: 'ready', error: 'HR题组生成失败：模型请求超时。',
      failure: { stage: 'question_generation', group: 'hr', code: 'MODEL_REQUEST_FAILED', diagnosticId: 'diagnostic-123', durationMs: 4200, model: 'approved-model' },
    } })
    const { el, onPrepare } = mount(item)
    expect(el.textContent).toContain('评价表已就绪 · 题组 1/3')
    expect(el.querySelector('details')?.hasAttribute('open')).toBe(true)
    expect(el.textContent).toContain('HR题组生成失败：模型请求超时。')
    expect(el.textContent).toContain('MODEL_REQUEST_FAILED')
    expect(el.textContent).toContain('模型：approved-model')
    expect(el.textContent).toContain('耗时：4.2 秒')
    expect(el.textContent).toContain('diagnostic-123')
    el.querySelector<HTMLButtonElement>('.preparation-retry')!.click()
    expect(onPrepare).toHaveBeenCalledWith(item)
  })
  it('retains legacy failure messages and updates cleanly after a successful retry', async () => {
    const item = reactive(row({ questionPreparation: { status: 'failed', completedGroups: [], error: '历史任务失败，请重试。' } }))
    const { el } = mount(item)
    expect(el.textContent).toContain('历史任务失败，请重试。')
    item.questionPreparation = { status: 'ready', completedGroups: ['ai', 'hr', 'department'], rubricsStatus: 'ready' }
    await nextTick()
    expect(el.textContent).toContain('已就绪'); expect(el.querySelector('details')).toBeNull()
    expect(el.querySelector('.preparation-retry')).toBeNull()
  })
  it('shows retry state rather than presenting a queued failure as a terminal result', () => {
    const { el } = mount(row({ questionPreparation: {
      status: 'queued', completedGroups: ['ai'], attempts: 1, error: '模型暂时限流。',
      failure: { stage: 'question_generation', group: 'hr', code: 'MODEL_HTTP_ERROR', httpStatus: 429 },
    } }))
    expect(el.textContent).toContain('等待自动重试 · 第 2 次尝试')
    expect(el.querySelector('.preparation-tag')?.textContent).toContain('准备中')
    expect(el.querySelector('.preparation-retry')).toBeNull()
  })
})
