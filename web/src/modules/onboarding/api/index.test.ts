// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { actionOnboarding, updateOnboarding, ONBOARDING_ACTION_LABEL, listOnboardingRows, toOnboardingRow, ONBOARDING_STATUS_LABEL } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)
const patchJson = vi.mocked(apiClient.patchJson)
const postJson = vi.mocked(apiClient.postJson)

describe('Onboarding API', () => {
  it('补齐候选人和岗位名称并格式化日期', async () => {
    getJson.mockImplementation((path: string) => {
      if (path === '/onboarding') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'onb-1', applicationId: 'app-1', offerId: 'offer-1', status: 'scheduled', plannedStartDate: '2026-09-20T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z' }] } as never)
      if (path === '/applications') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'offer' }] } as never)
      if (path === '/candidates') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'candidate-1', code: 'CAN-1', fullName: '王思远' }] } as never)
      if (path === '/jobs') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'job-1', code: 'JOB-1', title: '高级后端工程师' }] } as never)
      if (path === '/offers') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'offer-1', code: 'OFF-1', applicationId: 'app-1', status: 'accepted' }] } as never)
      throw new Error(`unexpected path ${path}`)
    })
    const rows = await listOnboardingRows()
    expect(rows[0]).toMatchObject({
      candidate: '王思远',
      job: '高级后端工程师',
      offerCode: 'OFF-1',
      plannedStartDate: '2026-09-20',
      updatedAt: '2026-09-14',
    })
  })

  it('处理缺失关联对象和未知岗位', () => {
    const row = toOnboardingRow(
      { id: 'onb-2', applicationId: 'app-missing', offerId: 'offer-missing', status: 'pending', updatedAt: '2026-09-14T00:00:00Z', createdAt: '2026-09-14T00:00:00Z' },
      undefined,
      undefined,
      undefined,
      undefined,
    )
    expect(row.candidate).toBe('未知候选人')
    expect(row.job).toBe('未知岗位')
    expect(row.offerCode).toBe('offer-missing')
    expect(ONBOARDING_STATUS_LABEL.pending).toBe('待入职')
  })

  it('调用入职排期和状态动作接口', async () => {
    patchJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'onb-3', applicationId: 'app-1', offerId: 'offer-1', status: 'scheduled', plannedStartDate: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', createdAt: '2026-10-21T00:00:00Z' } } as never)
    await updateOnboarding('onb-3', { plannedStartDate: '2026-10-21', notes: '准备资料' })
    expect(patchJson).toHaveBeenCalledWith('/onboarding/onb-3', { plannedStartDate: '2026-10-21', notes: '准备资料' })

    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'onb-3', applicationId: 'app-1', offerId: 'offer-1', status: 'completed', updatedAt: '2026-10-21T00:00:00Z', createdAt: '2026-10-21T00:00:00Z' } } as never)
    await actionOnboarding('onb-3', 'complete')
    expect(postJson).toHaveBeenCalledWith('/onboarding/onb-3/complete', { reason: undefined })
    expect(ONBOARDING_ACTION_LABEL.complete).toBe('完成归档')
  })

})
