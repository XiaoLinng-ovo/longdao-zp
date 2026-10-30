import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { analyzeResumeForApplication, createCandidate, deleteApplication, deleteCandidate, getCandidate, loadCandidates, reanalyzeResume, reviewAnalysisResult, updateCandidate } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn(), deleteJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)
const postJson = vi.mocked(apiClient.postJson)
const patchJson = vi.mocked(apiClient.patchJson)

describe('候选人 API', () => {
  it.each([false, true])('preserves full application timestamps for sorting (grouped=%s)', async (grouped) => {
    const application = { id: 'app-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'human_review', aiStatus: 'completed', updatedAt: '2026-10-19T09:32:41.123Z' }
    getJson.mockImplementation((path: string) => Promise.resolve({ ok: true, requestId: 'test', data: path === '/jobs'
      ? [{ id: 'job-1', title: '工程师' }]
      : [{ id: 'candidate-1', fullName: '测试', status: 'active', updatedAt: '2026-10-19T12:00:00Z', applications: [application, ...(grouped ? [{ ...application, id: 'app-2', updatedAt: '' }] : [])] }],
    } as never))
    const [candidate] = await loadCandidates()
    expect(candidate).toMatchObject({ updatedAt: '2026-10-19', updatedAtTimestamp: application.updatedAt })
    if (grouped) expect(candidate.applicationRows?.[1]).toMatchObject({ updatedAt: '2026-10-19', updatedAtTimestamp: '2026-10-19T12:00:00Z' })
  })
  it.each([false, true])('preserves application interview progress for grouped=%s', async (grouped) => {
    const progress = { id: 'interview-1', round: 1, stage: 'initial', status: 'scheduled' }
    const application = { id: 'app-1', candidateId: 'candidate-1', jobId: 'job-1', status: 'interviewing', aiStatus: 'completed', updatedAt: '2026-10-16', interviewProgress: progress }
    getJson.mockImplementation((path: string) => Promise.resolve({ ok: true, requestId: 'test', data: path === '/jobs'
      ? [{ id: 'job-1', title: '工程师' }]
      : [{ id: 'candidate-1', fullName: '测试', status: 'active', updatedAt: '2026-10-16', applications: [application, ...(grouped ? [{ ...application, id: 'app-2', interviewProgress: undefined }] : [])] }],
    } as never))
    const [candidate] = await loadCandidates()
    expect(candidate.interviewProgress).toEqual(progress)
    if (grouped) {
      expect(candidate.applicationRows?.[0].interviewProgress).toEqual(progress)
      expect(candidate.applicationRows?.[1].interviewProgress).toBeUndefined()
    }
  })
  it('deletes only the selected encoded application resource', async () => {
    vi.mocked(apiClient.deleteJson).mockResolvedValue({ ok: true, requestId: 'test', data: { deleted: true } } as never)
    await deleteApplication('application/with spaces')
    expect(apiClient.deleteJson).toHaveBeenCalledWith('/applications/application%2Fwith%20spaces')
  })

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

  it.each([90, 0, null])('列表使用最新候选人分数 %s，不使用旧申请分数', async (latestScore) => {
    getJson.mockImplementation((path: string) => Promise.resolve({ ok: true, requestId: 'test', data: path === '/jobs'
      ? [{ id: 'job-1', title: '算法工程师' }]
      : [{ id: 'candidate', code: 'CAN-1', fullName: '测试', status: 'active', updatedAt: '2026-10-08', aiStatus: 'completed', score: latestScore,
          applications: [{ id: 'app', candidateId: 'candidate', jobId: 'job-1', status: 'pending_analysis', score: 24, aiStatus: 'completed', updatedAt: '2026-10-08' }] }],
    } as never))
    const [candidate] = await loadCandidates()
    expect(candidate.scoreAvailable).toBe(latestScore !== null)
    expect(candidate.score).toBe(latestScore ?? 0)
  })

  it('更新候选人与人工复核分析结果', async () => {
    patchJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'uuid-candidate', status: 'archived', tags: ['后端'] } } as never)
    await updateCandidate('uuid-candidate', { status: 'archived', tags: ['后端'] })
    expect(patchJson).toHaveBeenCalledWith('/candidates/uuid-candidate', { status: 'archived', tags: ['后端'] })

    patchJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'result-1', humanReviewStatus: 'accepted' } } as never)
    await reviewAnalysisResult('result-1', { status: 'accepted', comment: '确认通过' })
    expect(patchJson).toHaveBeenCalledWith('/analysis-results/result-1', { status: 'accepted', comment: '确认通过' })
  })

  it('为已有简历创建重新解析任务', async () => {
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'task-2', resumeId: 'resume-1', status: 'queued', attempts: 0 } } as never)
    await reanalyzeResume('candidate-1', 'resume-1')
    expect(postJson).toHaveBeenCalledWith('/candidates/candidate-1/resumes/resume-1/reanalyze', {})
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

it('deletes candidates using an encoded ID', async () => {
  vi.mocked(apiClient.deleteJson).mockResolvedValue({ ok: true, requestId: 'test', data: { deleted: true } })
  await deleteCandidate('candidate/1')
  expect(apiClient.deleteJson).toHaveBeenCalledWith('/candidates/candidate%2F1')
})


it('keeps scores and progress independent across job applications', async () => {
  getJson.mockImplementation((path: string) => Promise.resolve({ ok: true, requestId: 'test', data: path === '/jobs'
    ? [{ id: 'job-1', title: '新岗位' }, { id: 'job-2', title: '原岗位' }]
    : [{ id: 'candidate', code: 'CAN-1', fullName: '张明', email: 'a@example.com', phone: '13800138000', status: 'active', updatedAt: '2026-10-08', aiStatus: 'completed', score: 96, analysisStatus: 'processing', applications: [
      { id: 'new-app', candidateId: 'candidate', jobId: 'job-1', status: 'pending_analysis', aiStatus: 'pending', analysisStatus: 'queued', analysisProgress: 15, updatedAt: '2026-10-08' },
      { id: 'old-app', candidateId: 'candidate', jobId: 'job-2', status: 'interviewing', score: 88, aiStatus: 'completed', analysisStatus: 'completed', analysisProgress: 100, updatedAt: '2026-10-07' },
    ] }],
  } as never))
  const [candidate] = await loadCandidates()
  expect(candidate.scoreAvailable).toBe(false)
  expect(candidate.aiStatus).toBe('pending')
  expect(candidate.score).toBe(0)
  expect(candidate.email).toBe('a@example.com')
  expect(candidate.applicationRows?.[1]).toMatchObject({ applicationId: 'old-app', score: 88, analysisStatus: 'completed', analysisProgress: 100, rawApplicationStatus: 'interviewing' })
})
it('binds reused resume analysis to the explicitly selected application', async () => {
  postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'task-new' } } as never)
  await analyzeResumeForApplication('candidate/1', 'resume/1', 'new-app')
  expect(postJson).toHaveBeenCalledWith('/candidates/candidate%2F1/resumes/resume%2F1/analyze-for-application', { applicationId: 'new-app' })
})
