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
  metrics: [
    { label: '简历数量', value: 17, detail: '已上传的简历总数' },
    { label: '通过筛选', value: 8, detail: '61.54% 转化率' },
    { label: '进入面试', value: 7, detail: '87.5% 转化率' },
    { label: '发出 Offer', value: 5, detail: '71.43% 转化率' },
  ],
  funnel: [
    { stage: '收到申请', count: 13, conversionRate: null },
    { stage: '通过筛选', count: 8, conversionRate: 61.54 },
    { stage: '进入面试', count: 7, conversionRate: 87.5 },
    { stage: '发出 Offer', count: 5, conversionRate: 71.43 },
    { stage: '已入职', count: 5, conversionRate: 100 },
  ],
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
    expect(data.metrics[0]).toMatchObject({ label: '简历数量', value: 17, trend: '已上传的简历总数' })
    expect(data.funnel[0]?.value).toBe(13)
    expect(data.metrics[2]?.trend).toBe('53.85% 转化率')
    expect(data.metrics[3]?.trend).toBe('38.46% 转化率')
    expect(data.pending[0]).toMatchObject({ entityId: 'real-request', status: 'pending' })
    expect(data.funnel[2]).toEqual({ label: '进入面试', value: 7, conversionRate: 87.5 })
    expect(data.pendingFeedback[0]).toMatchObject({ candidateName: '张三', feedbackStatus: 'pending' })
    expect(data.failedTasks[0]).toMatchObject({ id: 'task-1', lastError: '解析失败' })
  })
  it('错误不回退到演示数据，并支持页面重试', async () => {
    getJson.mockRejectedValue(new Error('数据库暂不可用'))
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(DashboardPage)
    const router = createRouter({ history: createMemoryHistory('/'), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/jobs', component: { template: '<div />' } }] })
    await router.push('/')
    app.use(router)
    app.mount(root)
    await flush()
    expect(root.textContent).toContain('数据库暂不可用')
    expect(root.querySelector('.metric-card')).toBeNull()
    respond()
    const retry = [...root.querySelectorAll('button')].find(button => button.textContent === '重试')!
    retry.click(); await flush()
    expect(root.textContent).not.toContain('数据库暂不可用')
    expect(root.textContent).not.toContain('测试招聘')
    expect(root.textContent).not.toContain('待审批需求')
    expect(root.textContent).not.toContain('新建需求')
    expect(root.textContent).not.toContain('一键导入需求')
    expect(root.textContent).toContain('1. 新建岗位')
    expect(root.querySelector('.card-heading h3 em')?.textContent).toBe('2')
    expect(root.textContent).toContain('张三')
    expect(root.querySelector('.metric-card strong')?.textContent).toBe('17')
    expect(root.querySelector('.metric-card')?.textContent).toContain('简历数量')
    expect(root.querySelector('.metric-card')?.textContent).toContain('已上传的简历总数')
    root.querySelector<HTMLButtonElement>('.quickflow-step')!.click()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/jobs'))
    await flush()
    expect(router.currentRoute.value.path).toBe('/jobs')
    expect(router.currentRoute.value.query).toEqual({ create: '1' })
  })
})
