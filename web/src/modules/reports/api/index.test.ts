import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { loadReports } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)

describe('报表 API', () => {
  it('读取招聘报表并返回核心聚合指标', async () => {
    getJson.mockResolvedValue({
      ok: true,
      requestId: 'test',
      data: {
        generatedAt: '2026-09-14T00:00:00.000Z',
        summary: [{ label: '收到申请', value: 3, detail: '全部申请' }],
        funnel: [{ stage: '收到申请', count: 3, conversionRate: null }],
        statusStats: [{ entity: 'application', status: 'new', count: 3 }],
        jobFilling: [{ jobId: 'job-1', code: 'JOB-1', title: '后端工程师', headcount: 2, filledCount: 1, openCount: 1, fillRate: 50 }],
        channels: [{ channel: '内推', applications: 1, screened: 1, interviewed: 1, offers: 0, hired: 0, conversionRate: 0 }],
        recruitmentCycle: { averageDaysToHire: 12, medianDaysToHire: 10, hiredCount: 1 },
        feedbackCompletion: { expected: 1, locked: 1, completionRate: 100 },
        offerAcceptance: { sent: 1, accepted: 1, acceptanceRate: 100 },
      },
    } as never)

    const report = await loadReports()
    expect(getJson).toHaveBeenCalledWith('/reports')
    expect(report.recruitmentCycle).toMatchObject({ averageDaysToHire: 12, medianDaysToHire: 10, hiredCount: 1 })
    expect(report.feedbackCompletion).toMatchObject({ expected: 1, locked: 1, completionRate: 100 })
    expect(report.offerAcceptance).toMatchObject({ sent: 1, accepted: 1, acceptanceRate: 100 })
  })

  it('报表读取失败时不回退到演示数据', async () => {
    getJson.mockRejectedValue(new Error('报表服务不可用'))
    await expect(loadReports()).rejects.toThrow('报表服务不可用')
  })
})
