import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { getOffer, listOfferContextRows, listOffers, offerAction, offerStatusCode, updateOffer } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), patchJson: vi.fn(), postJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)
const patchJson = vi.mocked(apiClient.patchJson)
const postJson = vi.mocked(apiClient.postJson)

describe('Offer API', () => {
  it('映射列表行并提取审批状态', async () => {
    getJson.mockResolvedValue({ ok: true, requestId: 'test', data: [{ id: 'offer-1', code: 'OFF-1', applicationId: 'app-1', status: 'draft', approval: { status: 'pending', approver: '待审批' }, version: 1, updatedAt: '2026-09-11T00:00:00Z' }] } as never)
    const rows = await listOffers()
    expect(getJson).toHaveBeenCalledWith('/offers')
    expect(rows[0]).toMatchObject({ entityId: 'offer-1', status: 'draft', approvalStatus: 'pending', approver: '待审批' })
  })

  it('上下文列表补齐候选人和岗位名称', async () => {
    getJson.mockImplementation((path: string) => {
      if (path === '/offers') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'offer-1', code: 'OFF-1', applicationId: 'app-1', status: 'draft', approval: { status: 'pending' }, version: 1, updatedAt: '2026-09-11T00:00:00Z' }] } as never)
      if (path === '/applications') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'app-1', code: 'APP-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'offer' }] } as never)
      if (path === '/candidates') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'candidate-1', code: 'CAN-1', fullName: '王思远' }] } as never)
      if (path === '/jobs') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'job-1', code: 'JOB-1', title: '高级后端工程师' }] } as never)
      throw new Error(`unexpected path ${path}`)
    })
    const rows = await listOfferContextRows()
    expect(rows[0].candidate).toContain('王思远')
    expect(rows[0].job).toContain('高级后端工程师')
  })

  it('详情取当前版本或最后一个版本', async () => {
    const v1 = { id: 'v1', version: 1, positionTitle: '初版', departmentId: '技术', employmentType: 'full_time', compensation: { baseSalary: { amount: 10000, currency: 'CNY' } }, benefits: [], content: 'v1', createdAt: '2026-09-10T00:00:00Z' }
    const v2 = { ...v1, id: 'v2', version: 2, positionTitle: '修订版', content: 'v2' }
    getJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'offer-1', code: 'OFF-1', applicationId: 'app-1', status: 'draft', approval: { status: 'pending' }, version: 2, currentVersionId: 'v2', versions: [v1, v2] } } as never)
    const detail = await getOffer('offer-1')
    expect(detail.version?.version).toBe(2)
    expect(detail.version?.positionTitle).toBe('修订版')
  })

  it('收紧后端状态字符串并调用操作/修订 API', async () => {
    expect(offerStatusCode({ status: 'expired' })).toBe('expired')
    expect(offerStatusCode(null)).toBeUndefined()
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { status: 'expired' } } as never)
    await offerAction('offer-1', 'expire')
    expect(postJson).toHaveBeenCalledWith('/offers/offer-1/expire', {})
    patchJson.mockResolvedValue({ ok: true, requestId: 'test', data: { status: 'draft', version: 2 } } as never)
    await updateOffer('offer-1', { content: '新版' })
    expect(patchJson).toHaveBeenCalledWith('/offers/offer-1', { content: '新版' })
  })
})

