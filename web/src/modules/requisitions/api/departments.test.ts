import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { loadDepartments } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
afterEach(() => vi.resetAllMocks())

describe('招聘需求部门接口', () => {
  it('读取启用部门供下拉框使用', async () => {
    vi.mocked(apiClient.getJson).mockResolvedValue({ ok: true, data: [{ id: 'd1', code: 'dept-tech', name: '技术部', isActive: true }], requestId: 'test' })
    await expect(loadDepartments()).resolves.toEqual([{ id: 'd1', code: 'dept-tech', name: '技术部', isActive: true }])
    expect(apiClient.getJson).toHaveBeenCalledWith('/departments')
  })
})
