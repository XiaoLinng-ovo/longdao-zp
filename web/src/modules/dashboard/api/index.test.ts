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
const dialogMethods = ['showModal', 'close'] as const
const originalDialogMethods = dialogMethods.map(name => Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name))
function respond() {
  getJson.mockImplementation(async (path) => ({ ok: true, data: summary, requestId: 'test' }) as never)
}
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => {
  app?.unmount(); app = undefined; root?.remove(); vi.restoreAllMocks(); vi.resetAllMocks()
  dialogMethods.forEach((name, index) => {
    const descriptor = originalDialogMethods[index]
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name)
  })
})
describe('真实招聘首页', () => {
  it('后端明确返回空待办时不恢复旧待办', async () => {
    getJson.mockResolvedValue({ ok: true, data: { ...summary, todos: [] }, requestId: 'test' } as never)
    expect((await loadDashboard()).todos).toEqual([])
  })
  it('全部查看展示完整列表，支持搜索分类并跳转到线上面试评分', async () => {
    const todos = Array.from({ length: 9 }, (_, index) => ({
      id: `todo-${index}`, category: index === 8 ? 'interview' : 'job',
      title: index === 8 ? '初试面试表待处理' : '待确认岗位说明书',
      description: index === 8 ? '张三 · 前端工程师 · 待评分 4 题' : `岗位 ${index}`,
      actionLabel: '去处理', path: index === 8 ? '/interviews/online-1?openQuestionSheet=1' : `/jobs/job-${index}`,
      updatedAt: summary.generatedAt,
    }))
    getJson.mockResolvedValue({ ok: true, data: { ...summary, todos }, requestId: 'test' } as never)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false } })
    root = document.createElement('div'); document.body.appendChild(root)
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/interviews/:id', component: { template: '<div />' } },
    ] })
    await router.push('/')
    app = createApp(DashboardPage); app.use(router); app.mount(root); await flush()
    for (const removedCopy of ['系统任务', '面试协作', '数据洞察', '招聘主线', '智能协作', 'HR 全程按提示点击即可完成闭环，无需培训。点击任意模块体验完整流程。', '需要你关注', '掌握团队招聘进展与待办事项']) {
      expect(root.textContent).not.toContain(removedCopy)
    }
    expect(root.querySelectorAll('.todo-card .todo-item')).toHaveLength(6)
    expect(root.querySelector('.card-heading h3 em')?.textContent).toBe('9')
    root.querySelector<HTMLButtonElement>('.heading-link')!.click(); await flush()
    expect(root.querySelector<HTMLDialogElement>('dialog')!.open).toBe(true)
    expect(root.querySelectorAll('.todos-scroll .todo-item')).toHaveLength(9)
    const search = root.querySelector<HTMLInputElement>('[aria-label="搜索待办"]')!
    search.value = '张三'; search.dispatchEvent(new Event('input')); await flush()
    expect(root.querySelectorAll('.todos-scroll .todo-item')).toHaveLength(1)
    const category = root.querySelector<HTMLSelectElement>('[aria-label="待办分类"]')!
    category.value = 'job'; category.dispatchEvent(new Event('change')); await flush()
    expect(root.textContent).toContain('没有匹配的待办事项')
    category.value = 'interview'; category.dispatchEvent(new Event('change')); await flush()
    root.querySelector<HTMLButtonElement>('.todos-scroll .todo-item')!.click(); await flush()
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/interviews/online-1'))
    expect(router.currentRoute.value.query).toEqual({ openQuestionSheet: '1' })
    expect(root.querySelector<HTMLDialogElement>('dialog')!.open).toBe(false)
    getJson.mockRejectedValueOnce(new Error('同步中断'))
    window.dispatchEvent(new Event('focus')); await flush()
    expect(root.textContent).toContain('同步中断')
    expect(root.querySelector('.card-heading h3 em')?.textContent).toBe('9')
    getJson.mockResolvedValue({ ok: true, data: { ...summary, todos: [] }, requestId: 'test' } as never)
    window.dispatchEvent(new Event('focus')); await flush()
    expect(root.textContent).not.toContain('同步中断')
    expect(root.querySelector('.card-heading h3 em')?.textContent).toBe('0')
  })
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
  it('招聘阶段进度与漏斗使用相同阶段人数，并在同步后一起更新', async () => {
    const updatedSummary = {
      ...summary,
      funnel: [
        { stage: '收到申请', count: 14, conversionRate: null },
        { stage: '通过筛选', count: 9, conversionRate: 64.29 },
        { stage: '进入面试', count: 8, conversionRate: 88.89 },
        { stage: '发出 Offer', count: 2, conversionRate: 25 },
        { stage: '已入职', count: 1, conversionRate: 50 },
      ],
    }
    getJson
      .mockResolvedValueOnce({ ok: true, data: summary, requestId: 'first' } as never)
      .mockResolvedValueOnce({ ok: true, data: updatedSummary, requestId: 'second' } as never)
    root = document.createElement('div'); document.body.appendChild(root)
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] })
    await router.push('/')
    app = createApp(DashboardPage); app.use(router); app.mount(root); await flush()

    const progressRows = () => [...root!.querySelectorAll<HTMLElement>('.progress-node')].map(node => ({
      label: node.querySelector('small')?.textContent,
      count: node.querySelector('b')?.textContent,
    }))
    const funnelRows = () => [...root!.querySelectorAll<HTMLTableRowElement>('.funnel-table tbody tr')].map(row => ({
      label: row.cells[0]?.textContent,
      count: row.cells[1]?.textContent,
    }))
    expect(progressRows()).toEqual(funnelRows())
    expect(progressRows()).toEqual([
      { label: '收到申请', count: '13' },
      { label: '通过筛选', count: '8' },
      { label: '进入面试', count: '7' },
      { label: '发出 Offer', count: '5' },
      { label: '已入职', count: '5' },
    ])

    window.dispatchEvent(new Event('focus')); await flush()
    expect(progressRows()).toEqual(funnelRows())
    expect(progressRows()).toEqual([
      { label: '收到申请', count: '14' },
      { label: '通过筛选', count: '9' },
      { label: '进入面试', count: '8' },
      { label: '发出 Offer', count: '2' },
      { label: '已入职', count: '1' },
    ])
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
