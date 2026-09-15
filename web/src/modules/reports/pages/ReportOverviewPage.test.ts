// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ReportOverviewPage from '../pages/ReportOverviewPage.vue'
import { apiClient } from '../../../shared/api'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)

const report = {
  generatedAt: '2026-09-14T00:00:00.000Z',
  summary: [{ label: '收到申请', value: 3, detail: '全部申请' }],
  funnel: [{ stage: '收到申请', count: 3, conversionRate: null }],
  statusStats: [{ entity: 'application', status: 'new', count: 3 }],
  jobFilling: [{ jobId: 'job-1', code: 'JOB-1', title: '后端工程师', headcount: 2, filledCount: 1, openCount: 1, fillRate: 50 }],
  channels: [{ channel: '内推', applications: 1, screened: 1, interviewed: 1, offers: 0, hired: 0, conversionRate: 0 }],
  recruitmentCycle: { averageDaysToHire: 12, medianDaysToHire: 10, hiredCount: 1 },
  feedbackCompletion: { expected: 1, locked: 1, completionRate: 100 },
  offerAcceptance: { sent: 1, accepted: 1, acceptanceRate: 100 },
}

let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

describe('招聘报表页', () => {
  it('渲染招聘周期、面试反馈完成度与 Offer 接受率', async () => {
    getJson.mockResolvedValue({ ok: true, requestId: 'test', data: report } as never)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(ReportOverviewPage); app.mount(root)
    await flush()
    expect(getJson).toHaveBeenCalledWith('/reports')
    expect(root.textContent).toContain('招聘周期')
    expect(root.textContent).toContain('面试反馈完成度')
    expect(root.textContent).toContain('Offer 接受率')
    expect(root.textContent).toContain('已入职人数')
    expect(root.textContent).toContain('已锁定反馈')
    expect(root.textContent).toContain('已发送 Offer')
  })

  it('读取失败时显示错误并支持重试', async () => {
    getJson.mockRejectedValue(new Error('报表服务不可用'))
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(ReportOverviewPage); app.mount(root)
    await flush()
    expect(root.textContent).toContain('报表服务不可用')
    getJson.mockResolvedValue({ ok: true, requestId: 'test', data: report } as never)
    const retry = [...root.querySelectorAll('button')].find((button) => button.textContent === '重试')!
    retry.click(); await flush()
    expect(root.textContent).not.toContain('报表服务不可用')
    expect(root.textContent).toContain('招聘周期')
  })
})
