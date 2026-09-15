import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRequisitions, actionRequisition } from './index'
import { apiClient } from '../../../shared/api'
vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), postJson: vi.fn() } }))
afterEach(() => vi.resetAllMocks())
describe('招聘需求真实接口', () => {
  it('读取失败向上传递，不回退到演示记录', async () => {
    vi.mocked(apiClient.getJson).mockRejectedValue(new Error('连接失败'))
    await expect(loadRequisitions()).rejects.toThrow('连接失败')
  })
  it('正确映射业务编号与真实主键', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue({ ok: true, data: [{ id: 'uuid-1', code: 'REQ-1', title: '工程师', department: '技术', headcount: 2, status: 'pending_approval', updatedAt: '2026-09-10T00:00:00Z' }], requestId: 'test' })
    expect(await loadRequisitions()).toEqual([expect.objectContaining({ entityId: 'uuid-1', id: 'REQ-1', status: 'pending' })])
  })
  it('审批命令保留原因并使用真实ID', async () => {
    vi.mocked(apiClient.postJson).mockResolvedValue({ ok: true, data: { id: 'uuid-1', code: 'REQ-1', status: 'rejected', updatedAt: '2026-09-10' }, requestId: 'test' })
    await actionRequisition('uuid-1', 'reject', '调整编制')
    expect(apiClient.postJson).toHaveBeenCalledWith('/recruitment-requests/uuid-1/reject', { reason: '调整编制' })
  })
})
