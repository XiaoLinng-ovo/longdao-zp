// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DashboardPage from '../pages/DashboardPage.vue'
import { loadDashboard } from './index'
import { apiClient } from '../../../shared/api'
import { createRouter, createMemoryHistory } from 'vue-router'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)
const summary = {
  generatedAt: '2026-09-14T00:00:00.000Z',
  metrics: [{ label: '收到申请', value: 3, detail: '全部申请记录' }],
  funnel: [{ stage: '收到申请', count: 3, conversionRate: null }],
  pendingApprovals: [{ id: 'real-request', code: 'REQ-7', title: '测试招聘', department: '技术', headcount: 1, status: 'pending_approval', updatedAt: '2026-09-10T00:00:00Z', approval: { approver: '审批人' } }],
  pendingFeedback: [{ id: 'interview-1', code: 'IV-1', title: '初试', round: 1, scheduledStartAt: '2026-09-11T00:00:00Z', status: 'completed', feedbackStatus: 'pending', candidateName: '张三', jobTitle: '前端工程师' }],
  failedTasks: [{ id: 'task-1', resumeId: 'resume-1', status: 'failed', attempts: 2, lastError: '解析失败', availableAt: '2026-09-10T00:00:00Z' }],
}
let app: App | undefined
let root: HTMLDivElement | undefined
function respond() {
  getJson.mockImplementation(async (path) => ({ ok: true, data: summary, requestId: 'test' }) as never)
}
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })
describe('真实招聘首页', () => {
  it('使用汇总接口返回指标、漏斗和待办事项', async () => {
    respond()
    const data = await loadDashboard()
    expect(getJson).toHaveBeenCalledWith('/dashboard/summary')
    expect(data.metrics[0]?.value).toBe(3)
    expect(data.pending[0]).toMatchObject({ entityId: 'real-request', status: 'pending' })
    expect(data.funnel).toEqual([{ label: '收到申请', value: 3 }])
    expect(data.pendingFeedback[0]).toMatchObject({ candidateName: '张三', feedbackStatus: 'pending' })
    expect(data.failedTasks[0]).toMatchObject({ id: 'task-1', lastError: '解析失败' })
  })
  it('错误不回退到演示数据，并支持页面重试', async () => {
    getJson.mockRejectedValue(new Error('数据库暂不可用'))
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(DashboardPage)
    app.use(createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }] }))
    app.mount(root)
    await flush()
    expect(root.textContent).toContain('数据库暂不可用')
    expect(root.querySelector('.metric-card')).toBeNull()
    respond()
    const retry = [...root.querySelectorAll('button')].find(button => button.textContent === '重试')!
    retry.click(); await flush()
    expect(root.textContent).not.toContain('数据库暂不可用')
    expect(root.textContent).toContain('测试招聘')
    expect(root.textContent).toContain('张三')
    expect(root.querySelector('.metric-card strong')?.textContent).toBe('3')
  })
})
