import assert from 'node:assert/strict'
import test from 'node:test'
import { RecruitingService } from './service.js'
import type { NormalizedRecruitingRepository } from './repositories/postgres-repository.js'

function fixture(input: { skill?: boolean; status?: string; infected?: boolean; confirmed?: boolean; scopeMismatch?: boolean } = {}) {
  const task = { id: 'task', resumeId: 'resume', applicationId: 'app', status: input.status ?? 'queued', attempts: 0, idempotencyKey: 'key', availableAt: '2026-10-09', createdAt: '2026-10-09' }
  let writes = 0
  const repository = {
    getAnalysisTask: async () => task,
    getResume: async () => ({ id: 'resume', scanStatus: input.infected ? 'infected' : 'clean' }),
    getApplication: async () => ({ id: 'app', jobId: 'job' }),
    hasActiveResumeScoringSkill: async () => input.skill ?? false,
    assertJobAnalysisContextScope: async () => { if (input.scopeMismatch) throw Object.assign(new Error('岗位要求企业归属异常'), { code: 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH' }) },
    getJob: async () => ({ id: 'job', title: '人事', status: 'published' }),
    listJobSpecVersions: async () => [{ version: 1, confirmedAt: input.confirmed === false ? null : '2026-10-09', content: { requirements: [{ label: '入离职管理', required: true }] } }],
    listJobDescriptionVersions: async () => [],
    updateAnalysisTask: async () => { writes++; throw new Error('must not run keyword analysis') },
  } as unknown as NormalizedRecruitingRepository
  return { service: new RecruitingService(undefined, undefined, undefined, repository), task, writes: () => writes }
}
test('岗位评分保持排队交给 AI Worker，不写关键词分、不增加尝试次数', async () => {
  const f = fixture(); const result = await f.service.processAnalysisTask('task')
  assert.equal(result.status, 'queued'); assert.equal(result.attempts, 0); assert.equal(f.writes(), 0)
})
test('保留评分 Skill 专属 Worker 路由及已完成幂等性', async () => {
  const skill = fixture({ skill: true })
  await assert.rejects(skill.service.processAnalysisTask('task'), (e: unknown) => (e as { code: string }).code === 'SCORING_SKILL_WORKER_REQUIRED')
  const completed = fixture({ status: 'completed' }); assert.equal((await completed.service.processAnalysisTask('task')).status, 'completed')
  assert.equal(completed.writes(), 0)
})
test('排队前仍检查文件扫描与运行中任务，不能绕过安全校验', async () => {
  await assert.rejects(fixture({ infected: true }).service.processAnalysisTask('task'), (e: unknown) => (e as { code: string }).code === 'RESUME_SCAN_NOT_CLEAN')
  await assert.rejects(fixture({ status: 'processing' }).service.processAnalysisTask('task'), (e: unknown) => (e as { code: string }).code === 'ANALYSIS_TASK_BUSY')
})

test('岗位版本企业归属异常不进入同步解析、不生成无分成功报告', async () => {
  const f = fixture({ scopeMismatch: true })
  await assert.rejects(f.service.processAnalysisTask('task'), (e: unknown) => (e as { code: string }).code === 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH')
  assert.equal(f.writes(), 0)
})
