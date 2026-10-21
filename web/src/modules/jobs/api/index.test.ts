import { describe, expect, it, vi } from 'vitest'
import { apiClient } from '../../../shared/api'
import { createJd, createJob, deleteJob, createSpec, generateJobDescription, generateJobSpec, jobAction, listJobDescriptionVersions, listJobSpecVersions, loadJobs } from './index'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn(), deleteJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)
const postJson = vi.mocked(apiClient.postJson)

describe('岗位 API', () => {
  it('删除岗位使用 DELETE 接口与实际岗位主键', async () => {
    vi.mocked(apiClient.deleteJson).mockResolvedValue({ ok: true, requestId: 'test', data: { deleted: true } } as never)
    await deleteJob('uuid-job')
    expect(apiClient.deleteJson).toHaveBeenCalledWith('/jobs/uuid-job')
  })
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

  it('按岗位名称请求 AI 生成说明书', async () => {
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'uuid-job', spec: { title: '后端工程师' } } } as never)
    await generateJobSpec('uuid-job')
    expect(postJson).toHaveBeenCalledWith('/jobs/uuid-job/spec/generate', {}, {headers:{'Idempotency-Key':expect.stringMatching(/^[a-f0-9-]{36}$/)}})
  })

  it('按岗位请求 AI 生成 JD', async () => {
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'uuid-job', jd: { content: 'JD' } } } as never)
    await generateJobDescription('uuid-job')
    expect(postJson).toHaveBeenCalledWith('/jobs/uuid-job/jd/generate', {}, {headers:{'Idempotency-Key':expect.stringMatching(/^[a-f0-9-]{36}$/)}})
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


describe('岗位创建与招聘需求解耦', () => {
  const input = { title: ' 人事专员 ', departmentId: ' HR ', headcount: 1, employmentType: 'full_time', workMode: 'onsite' }
  it('无需求关联或空白需求关联时不发送关联字段', async () => {
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'job-new', title: '人事专员' } } as never)
    for (const recruitmentRequestId of [undefined, '', '   ']) {
      postJson.mockClear()
      await createJob({ ...input, recruitmentRequestId })
      const payload = postJson.mock.calls[0]![1]
      expect(payload).toMatchObject({ title: '人事专员', departmentId: 'HR', headcount: 1 })
      expect(payload).not.toHaveProperty('recruitmentRequestId')
    }
  })
  it('兼容显式传入历史需求关联', async () => {
    postJson.mockResolvedValue({ ok: true, requestId: 'test', data: { id: 'job-new' } } as never)
    postJson.mockClear()
    await createJob({ ...input, recruitmentRequestId: ' request-approved ' })
    expect(postJson).toHaveBeenCalledWith('/jobs', expect.objectContaining({ recruitmentRequestId: 'request-approved' }))
  })
  it('仍要求岗位名称及部门，不以取消需求关联放宽基本校验', async () => {
    postJson.mockClear()
    await expect(createJob({ ...input, title: ' ' })).rejects.toThrow('必填字段')
    await expect(createJob({ ...input, departmentId: ' ' })).rejects.toThrow('必填字段')
    expect(postJson).not.toHaveBeenCalled()
  })
})

it('generation API preserves an explicit task key for caller-controlled replay',async()=>{
 postJson.mockResolvedValue({ok:true,requestId:'test',data:{id:'uuid-job'}} as never)
 await generateJobSpec('uuid-job',{prompt:'测试'},'task-replay-key');await generateJobDescription('uuid-job',{},'jd-replay-key')
 expect(postJson).toHaveBeenCalledWith('/jobs/uuid-job/spec/generate',{prompt:'测试'},{headers:{'Idempotency-Key':'task-replay-key'}})
 expect(postJson).toHaveBeenCalledWith('/jobs/uuid-job/jd/generate',{},{headers:{'Idempotency-Key':'jd-replay-key'}})
})
