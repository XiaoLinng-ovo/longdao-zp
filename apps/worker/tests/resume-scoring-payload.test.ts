import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createResumePayloadResolver } from '../src/db/payload.js'
import type { AnalysisTaskRecord, PostgresAnalysisTaskStore } from '../src/db/analysis-task-store.js'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'

const task: AnalysisTaskRecord = { id: 'task-1', resumeId: 'resume-1', applicationId: 'application-1', status: 'queued', attempts: 0, idempotencyKey: 'fixture', availableAt: '2026-10-08', createdAt: '2026-10-08' }
test('payload selects rules from the application job rather than resume text or name', async () => {
  const calls: string[] = []
  const scoringSkill = { id: 'skill-1', name: '专属规则', content: '项目 100 分', updatedAt: '2026-10-08T00:00:00.000Z' }
  const store = {
    async getResumeAnalysisSource() { return { resumeId: 'resume-1', candidateId: 'candidate-1', storageKey: 'fixture', originalFilename: 'resume.txt', mimeType: 'text/plain' } },
    async getApplicationJob(id: string) { calls.push(id); return 'job-1' },
    async getJobAnalysisContext(id: string) { calls.push(id); return { title: '后端', requirements: ['经验：3年'], skills: ['Python'], requirementRequired: [true] } },
    async getJobScoringSkill(id: string) { calls.push(id); return scoringSkill },
  } as unknown as PostgresAnalysisTaskStore
  const storage: ObjectStorage = { kind: 'local', async put() {}, async delete() {}, async health() { return true }, async get() { return Buffer.from('简历里提到销售经理，但申请的是后端岗位。') } }
  const resolve = createResumePayloadResolver(store, { storage })
  const result = await resolve(task)
  assert.equal(result.jobId, 'job-1')
  assert.deepEqual(result.jobRequirements, ['经验：3年'])
  assert.deepEqual(result.jobSkills, ['Python'])
  assert.deepEqual(result.jobRequirementRequired, [true])
  assert.deepEqual(result.scoringSkill, scoringSkill)
  assert.deepEqual(calls, ['application-1', 'job-1', 'job-1'])
  calls.length = 0
  const { applicationId: _applicationId, ...resumeOnly } = task
  assert.equal((await resolve(resumeOnly)).scoringSkill, undefined)
  assert.deepEqual(calls, [])
})


test('invalid job scope is checked before reading or extracting the resume file', async () => {
  let fileReads = 0
  const expected = new Error('JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH')
  const store = {
    async getResumeAnalysisSource() { return { resumeId: 'resume-1', storageKey: 'fixture' } },
    async getApplicationJob() { return 'job-1' },
    async getJobAnalysisContext() { throw expected },
    async getJobScoringSkill() { throw new Error('must not load scoring skill') },
  } as unknown as PostgresAnalysisTaskStore
  const storage = { async get() { fileReads++; throw new Error('must not read file') } } as unknown as ObjectStorage
  await assert.rejects(createResumePayloadResolver(store, { storage })(task), (error) => error === expected)
  assert.equal(fileReads, 0)
})
