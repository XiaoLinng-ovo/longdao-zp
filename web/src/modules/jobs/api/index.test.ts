import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { createJd, createSpec, jobAction, listJobDescriptionVersions, listJobSpecVersions, loadJobs } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)
const postJson = vi.mocked(apiClient.postJson)

describe('岗位 API', () => {
  it('读取岗位并映射业务编号与主键', async () => {
    getJson.mockResolvedValue({
      ok: true,
      requestId: 'test',
      data: [{ id: 'uuid-job', code: 'JOB-1', title: '后端工程师', department: '技术', status: 'draft', channels: [], headcount: 2, filledCount: 0, updatedAt: '2026-09-10T00:00:00Z' }],
    } as never)
    const jobs = await loadJobs()
    expect(getJson).toHaveBeenCalledWith('/jobs')
    expect(jobs[0]).toMatchObject({ entityId: 'uuid-job', id: 'JOB-1', title: '后端工程师' })
  })

  it('创建岗位说明书与 JD 走真实接口', async () => {
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'uuid-job', version: 1 } } as never)
    await createSpec('uuid-job', { title: '说明书', summary: '摘要', responsibilities: ['职责'], requirements: [{ label: '经验', required: true }], skills: ['Node'] })
    expect(postJson).toHaveBeenCalledWith('/jobs/uuid-job/spec', expect.objectContaining({ title: '说明书', skills: ['Node'] }))
    await createJd('uuid-job', { language: 'zh-CN', content: '岗位描述', generatedBy: 'human' })
    expect(postJson).toHaveBeenCalledWith('/jobs/uuid-job/jd', { language: 'zh-CN', content: '岗位描述', generatedBy: 'human' })
  })

  it('读取岗位说明书与 JD 版本历史', async () => {
    getJson.mockImplementation((path: string) => {
      if (path === '/jobs/uuid-job/spec-versions') return Promise.resolve({ ok: true, requestId: 'test', data: [{ jobId: 'uuid-job', version: 1, createdAt: '2026-09-10T00:00:00Z' }] } as never)
      if (path === '/jobs/uuid-job/jd-versions') return Promise.resolve({ ok: true, requestId: 'test', data: [{ jobId: 'uuid-job', version: 1, createdAt: '2026-09-10T00:00:00Z' }] } as never)
      throw new Error(`unexpected ${path}`)
    })
    await expect(listJobSpecVersions('uuid-job')).resolves.toHaveLength(1)
    await expect(listJobDescriptionVersions('uuid-job')).resolves.toHaveLength(1)
  })

  it('岗位动作携带原因并使用主键', async () => {
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'uuid-job', status: 'published' } } as never)
    await jobAction('uuid-job', 'publish', '需求已通过')
    expect(postJson).toHaveBeenCalledWith('/jobs/uuid-job/publish', { reason: '需求已通过' })
  })
})
