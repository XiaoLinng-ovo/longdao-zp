import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { createCandidate, getCandidate, loadCandidates, reviewAnalysisResult, updateCandidate } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)
const postJson = vi.mocked(apiClient.postJson)
const patchJson = vi.mocked(apiClient.patchJson)

describe('候选人 API', () => {
  it('读取候选人并补充标签与业务编号', async () => {
    getJson.mockImplementation((path: string) => {
      if (path === '/candidates') {
        return Promise.resolve({
          ok: true, requestId: 'test',
          data: [{ id: 'uuid-candidate', code: 'CAN-1', fullName: '王思远', source: '简历导入', company: '星河科技', skills: ['Java'], tags: ['后端'], status: 'active', updatedAt: '2026-09-10T00:00:00Z', applications: [{ id: 'app-1', candidateId: 'uuid-candidate', jobId: 'job-1', status: 'new', source: 'BOSS直聘', score: 80, aiStatus: 'completed', updatedAt: '2026-09-10T00:00:00Z' }] }],
        } as never)
      }
      if (path === '/jobs') return Promise.resolve({ ok: true, requestId: 'test', data: [{ id: 'job-1', title: '后端工程师' }] } as never)
      throw new Error(`unexpected ${path}`)
    })
    const candidates = await loadCandidates()
    expect(candidates[0]).toMatchObject({ entityId: 'uuid-candidate', id: 'CAN-1', name: '王思远', tags: ['后端'] })
    expect(candidates[0].job).toBe('后端工程师')
    expect(candidates[0].source).toBe('BOSS直聘')
    expect(candidates[0]).toMatchObject({ company: '星河科技', skills: ['Java'] })
  })

  it('更新候选人与人工复核分析结果', async () => {
    patchJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'uuid-candidate', status: 'archived', tags: ['后端'] } } as never)
    await updateCandidate('uuid-candidate', { status: 'archived', tags: ['后端'] })
    expect(patchJson).toHaveBeenCalledWith('/candidates/uuid-candidate', { status: 'archived', tags: ['后端'] })

    patchJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'result-1', humanReviewStatus: 'accepted' } } as never)
    await reviewAnalysisResult('result-1', { status: 'accepted', comment: '确认通过' })
    expect(patchJson).toHaveBeenCalledWith('/analysis-results/result-1', { status: 'accepted', comment: '确认通过' })
  })

  it('创建候选人使用真实接口并保留标签', async () => {
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'uuid-candidate', fullName: '新候选人', tags: ['前端'] } } as never)
    await createCandidate({ fullName: '新候选人', tags: ['前端'] })
    expect(postJson).toHaveBeenCalledWith('/candidates', { fullName: '新候选人', tags: ['前端'] })
  })

  it('读取候选人详情包含简历与分析结果', async () => {
    getJson.mockResolvedValue({
      ok: true, requestId: 'test',
      data: { id: 'uuid-candidate', code: 'CAN-1', fullName: '王思远', status: 'active', createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z', applications: [], resumes: [], analysisTasks: [], analysisResults: [], jobs: [] },
    } as never)
    const detail = await getCandidate('uuid-candidate')
    expect(getJson).toHaveBeenCalledWith('/candidates/uuid-candidate')
    expect(detail.fullName).toBe('王思远')
    expect(detail.resumes).toEqual([])
  })
})
