import assert from 'node:assert/strict'
import { after, afterEach, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

const previousNodeEnv = process.env.NODE_ENV
before(() => { process.env.NODE_ENV = 'test' })
after(() => { if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv })
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'application-resume-test-')); directories.push(path)
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store, path)
  const uploaded = await service.createResume({ candidateId: 'candidate-8821', applicationId: 'application-8821', originalFilename: 'resume.txt', mimeType: 'text/plain', content: 'Java Spring Boot PostgreSQL, 8 years experience' })
  const application = await service.createApplication({ candidateId: 'candidate-8821', jobId: 'job-107', source: '人才库激活' })
  return { store, service, uploaded, application }
}

describe('resume reuse for a new application', () => {
  it('keeps old results, manual scores and the resume association unchanged', async () => {
    const { store, service, uploaded, application } = await fixture()
    await service.processAnalysisTask(uploaded.task.id)
    await store.transaction((state) => {
      const original = state.applications.find((item) => item.id === 'application-8821')!
      original.status = 'rejected'
      const result = state.analysisResults[0]!
      result.result.scoring = { aiScore: 84, humanScore: 72, finalScore: 76.8, decision: 'eliminated', talentPool: true, history: [] }
    })
    const before = await store.read()
    const oldApplication = structuredClone(before.applications.find((item) => item.id === 'application-8821'))
    const oldResult = structuredClone(before.analysisResults[0])
    const task = await service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, application.id, 'reviewer')
    assert.equal(task.applicationId, application.id)
    assert.notEqual(task.id, uploaded.task.id)
    assert.equal((await service.processAnalysisTask(task.id)).status, 'completed')
    const after = await store.read()
    assert.equal(after.resumes.length, 1)
    assert.equal(after.resumes[0]!.applicationId, 'application-8821')
    assert.deepEqual(after.applications.find((item) => item.id === 'application-8821'), oldApplication)
    assert.deepEqual(after.analysisResults.find((item) => item.id === oldResult!.id), oldResult)
    assert.equal(after.analysisResults.find((item) => item.analysisTaskId === task.id)?.applicationId, application.id)
    assert.ok(after.workflowEvents.some((event) => event.subjectId === application.id && event.action === 'resume_analysis_requested'))
  })
  it('does not confuse an old application task with the new application task', async () => {
    const { service, uploaded, application } = await fixture()
    const task = await service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, application.id)
    assert.notEqual(task.id, uploaded.task.id)
    assert.equal((await service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, application.id)).id, task.id)
    const [candidate] = (await service.listCandidates()).filter((item) => item.id === 'candidate-8821')
    assert.equal(candidate!.applications.find((item) => item.id === application.id)?.analysisStatus, 'queued')
  })
  it('rejects a resume or application belonging to another candidate', async () => {
    const { service, uploaded } = await fixture()
    await assert.rejects(service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, 'application-8814'), (error: any) => error.code === 'RESUME_CANDIDATE_MISMATCH')
    await assert.rejects(service.analyzeResumeForApplication('candidate-8814', uploaded.resume.id, 'application-8814'), (error: any) => error.code === 'RESUME_CANDIDATE_MISMATCH')
  })
  it('rejects infected files and applications already in the interview stage', async () => {
    const { service, store, uploaded, application } = await fixture()
    await store.transaction((state) => { state.resumes[0]!.scanStatus = 'infected' })
    await assert.rejects(service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, application.id), (error: any) => error.code === 'RESUME_SCAN_NOT_CLEAN')
    await store.transaction((state) => { state.resumes[0]!.scanStatus = 'clean'; state.applications.find((item) => item.id === application.id)!.status = 'interviewing' })
    await assert.rejects(service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, application.id), (error: any) => error.code === 'APPLICATION_ANALYSIS_INVALID')
  })
  it('does not replace another active resume for the same application', async () => {
    const { service, uploaded, application } = await fixture()
    await service.createResume({ candidateId: 'candidate-8821', applicationId: application.id, originalFilename: 'new.txt', mimeType: 'text/plain', content: 'new resume' })
    await assert.rejects(service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, application.id), (error: any) => error.code === 'ANALYSIS_TASK_BUSY')
  })
  it('queues repository tasks for the new application without updating the original resume', async () => {
    const service = new RecruitingService(new LocalRecruitingStore())
    let input: unknown
    ;(service as any).repository = {
      getResume: async () => ({ id: 'resume', candidateId: 'candidate', applicationId: 'old-app', scanStatus: 'clean' }),
      getApplication: async () => ({ id: 'new-app', candidateId: 'candidate', jobId: 'new-job', status: 'pending_analysis' }),
      assertJobAnalysisContextScope: async (jobId: string) => { assert.equal(jobId, 'new-job') },
      listAnalysisTasks: async () => [{ id: 'old-task', resumeId: 'resume', applicationId: 'old-app', status: 'processing' }],
      createAnalysisTask: async (body: unknown) => { input = body; return { id: 'new-task', resumeId: 'resume', applicationId: 'new-app', status: 'queued', attempts: 0, idempotencyKey: 'key', availableAt: '2026-10-08', createdAt: '2026-10-08' } },
      appendWorkflowEvent: async () => {},
    }
    const task = await service.analyzeResumeForApplication('candidate', 'resume', 'new-app')
    assert.equal(task.id, 'new-task')
    assert.equal((input as { applicationId: string }).applicationId, 'new-app')
  })
})


describe('repository reanalysis job scope preflight', () => {
  for (const reused of [false, true]) {
    it(`rejects invalid job ownership before queueing (reused=${reused}) without altering historical results`, async () => {
      let writes = 0
      const expected = Object.assign(new Error('岗位评分配置异常'), { code: 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH', status: 409 })
      const repository = {
        getResume: async () => ({ id: 'resume', candidateId: 'candidate', applicationId: 'app', scanStatus: 'clean' }),
        getApplication: async (id: string) => ({ id, candidateId: 'candidate', jobId: 'job', status: 'human_review' }),
        listAnalysisTasks: async () => [{ id: 'old-task', resumeId: 'resume', applicationId: 'app', status: 'completed' }],
        assertJobAnalysisContextScope: async (jobId: string) => { assert.equal(jobId, 'job'); throw expected },
        createAnalysisTask: async () => { writes++; throw new Error('must not enqueue') },
        appendWorkflowEvent: async () => { writes++ },
        updateAnalysisResult: async () => { writes++ },
      }
      const service = new RecruitingService(undefined, undefined, undefined, repository as any)
      await assert.rejects(reused
        ? service.analyzeResumeForApplication('candidate', 'resume', 'new-app')
        : service.reanalyzeResume('candidate', 'resume'), (error) => error === expected)
      assert.equal(writes, 0)
    })
  }
  it('allows parsing resumes without an application; does not invent a job', async () => {
    const repository = {
      getResume: async () => ({ id: 'resume', candidateId: 'candidate', scanStatus: 'clean' }),
      listAnalysisTasks: async () => [],
      assertJobAnalysisContextScope: async () => { throw new Error('must not look up a job') },
      createAnalysisTask: async () => ({ id: 'task', resumeId: 'resume', status: 'queued', attempts: 0 }),
      appendWorkflowEvent: async () => {},
    }
    const service = new RecruitingService(undefined, undefined, undefined, repository as any)
    assert.equal((await service.reanalyzeResume('candidate', 'resume')).status, 'queued')
  })
})


describe('original resume reanalysis application isolation', () => {
  it('does not reuse a task for the same file on a different application', async () => {
    let scopedJob: string | undefined
    const repository = {
      getResume: async () => ({ id: 'resume', candidateId: 'candidate', applicationId: 'original-app', scanStatus: 'clean' }),
      getApplication: async () => ({ id: 'original-app', candidateId: 'candidate', jobId: 'original-job', status: 'rejected' }),
      listAnalysisTasks: async () => [{ id: 'other-task', resumeId: 'resume', applicationId: 'other-app', status: 'processing' }],
      assertJobAnalysisContextScope: async (jobId: string) => { scopedJob = jobId },
      createAnalysisTask: async (input: { applicationId: string }) => ({ id: 'new-task', resumeId: 'resume', applicationId: input.applicationId, status: 'queued', attempts: 0 }),
      appendWorkflowEvent: async () => {},
    }
    const service = new RecruitingService(undefined, undefined, undefined, repository as any)
    const task = await service.reanalyzeResume('candidate', 'resume')
    assert.equal(task.id, 'new-task')
    assert.equal(task.applicationId, 'original-app')
    assert.equal(scopedJob, 'original-job')
  })
  it('refuses a corrupted resume/application candidate association before enqueueing', async () => {
    const repository = {
      getResume: async () => ({ id: 'resume', candidateId: 'candidate', applicationId: 'app', scanStatus: 'clean' }),
      getApplication: async () => ({ id: 'app', candidateId: 'other-candidate', jobId: 'job' }),
      listAnalysisTasks: async () => [],
      assertJobAnalysisContextScope: async () => { throw new Error('must not look up job') },
      createAnalysisTask: async () => { throw new Error('must not enqueue') },
    }
    const service = new RecruitingService(undefined, undefined, undefined, repository as any)
    await assert.rejects(service.reanalyzeResume('candidate', 'resume'), (error: any) => error.code === 'RESUME_CANDIDATE_MISMATCH')
  })
})
