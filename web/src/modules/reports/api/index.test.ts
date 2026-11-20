import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { loadReports } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)

const report = {
  generatedAt: '2026-09-21T00:00:00.000Z',
  summary: [{ label: '收到申请', value: 3, detail: '全部申请记录' }],
  funnel: [{ stage: '收到申请', count: 3, conversionRate: null }],
  statusStats: [],
  jobFilling: [],
  channels: [{ channel: 'BOSS直聘', applications: 3, screened: 2, interviewed: 1, offers: 0, hired: 0, conversionRate: 0 }],
  recruitmentCycle: { averageDaysToHire: null, medianDaysToHire: null, hiredCount: 0 },
  feedbackCompletion: { expected: 0, locked: 0, completionRate: null },
  offerAcceptance: { sent: 0, accepted: 0, acceptanceRate: null },
}

describe('招聘数据看板 API', () => {
  it('读取真实报表数据', async () => {
    getJson.mockResolvedValue({ ok: true, requestId: 'test', data: report } as never)
    await expect(loadReports()).resolves.toMatchObject({ summary: report.summary, channels: report.channels })
    expect(getJson).toHaveBeenCalledWith('/reports')
  })

  it('读取失败时不回退到演示数据', async () => {
    getJson.mockRejectedValue(new Error('报表服务不可用'))
    await expect(loadReports()).rejects.toThrow('报表服务不可用')
  })
})
