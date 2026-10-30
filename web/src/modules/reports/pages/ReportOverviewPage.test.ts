// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ReportOverviewPage from './ReportOverviewPage.vue'
import { apiClient } from '../../../shared/api'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)

const report = {
  generatedAt: '2026-09-21T00:00:00.000Z',
  summary: [{ label: '收到申请', value: 8, detail: '全部申请记录' }],
  funnel: [{ stage: '收到申请', count: 8, conversionRate: null }, { stage: '进入面试', count: 4, conversionRate: 50 }],
  statusStats: [],
  jobFilling: [],
  channels: [{ channel: 'BOSS直聘', applications: 4, screened: 3, interviewed: 2, offers: 0, hired: 0, conversionRate: 0 }],
  recruitmentCycle: { averageDaysToHire: null, medianDaysToHire: null, hiredCount: 0 },
  feedbackCompletion: { expected: 0, locked: 0, completionRate: null },
  offerAcceptance: { sent: 0, accepted: 0, acceptanceRate: null },
}

let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let index = 0; index < 8; index += 1) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

describe('招聘数据看板', () => {
  it('展示指标、招聘漏斗和渠道效果', async () => {
    getJson.mockResolvedValue({ ok: true, requestId: 'test', data: report } as never)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(ReportOverviewPage); app.mount(root)
    await flush()
    expect(root.textContent).toContain('招聘数据看板')
    expect(root.textContent).toContain('收到申请')
    expect(root.textContent).toContain('招聘漏斗')
    expect(root.textContent).toContain('渠道效果对比')
    expect(root.textContent).toContain('BOSS直聘')
  })
})
