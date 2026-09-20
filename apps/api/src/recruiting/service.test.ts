import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

const temporaryDirectories: string[] = []

async function createLocalFixture(content = 'Java Spring Boot PostgreSQL, 8 years experience') {
  process.env.NODE_ENV = 'test'
  const directory = await mkdtemp(join(tmpdir(), 'recruiting-analysis-gate-'))
  temporaryDirectories.push(directory)
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store, directory)
  const created = await service.createResume({
    candidateId: 'candidate-8821',
    applicationId: 'application-8821',
    originalFilename: 'resume.txt',
    mimeType: 'text/plain',
    content,
  })
  return { service, store, created }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('resume analysis scan gate', () => {
  it('allows historical non-infected resume statuses to be analyzed', async () => {
    const { service, store, created } = await createLocalFixture()

    await service.processAnalysisTask(created.task.id)

    const state = await store.read()
    const task = state.analysisTasks.find((item) => item.id === created.task.id)
    assert.equal(task?.status, 'completed')
    assert.equal(task?.attempts, 1)
    assert.equal(state.analysisResults.length, 1)
  })

  it('rejects a non-clean PostgreSQL resume without updating the task', async () => {
    process.env.NODE_ENV = 'test'
    const service = new RecruitingService()
    let updateCalls = 0
    ;(service as any).repository = {
      getAnalysisTask: async () => ({ id: 'task-1', resumeId: 'resume-1', applicationId: null, status: 'queued', attempts: 0, idempotencyKey: 'key-1', lastError: null, availableAt: new Date().toISOString(), startedAt: null, completedAt: null, createdAt: new Date().toISOString() }),
      getResume: async () => ({ id: 'resume-1', candidateId: 'candidate-1', applicationId: null, storageKey: 'resume.txt', originalFilename: 'resume.txt', mimeType: 'text/plain', sizeBytes: 10, scanStatus: 'infected', contentHash: 'hash', createdAt: new Date().toISOString() }),
      updateAnalysisTask: async () => { updateCalls += 1; throw new Error('must not update') },
    }

    await assert.rejects(
      service.processAnalysisTask('task-1'),
      (error: any) => error?.code === 'RESUME_SCAN_NOT_CLEAN' && error?.status === 409,
    )
    assert.equal(updateCalls, 0)
  })

  it('allows a clean local resume to complete analysis', async () => {
    const { service, store, created } = await createLocalFixture()
    await store.transaction((state) => {
      const resume = state.resumes.find((item) => item.id === created.resume.id)
      assert.ok(resume)
      resume.scanStatus = 'clean'
    })

    const task = await service.processAnalysisTask(created.task.id)
    assert.equal(task.status, 'completed')
    const state = await store.read()
    assert.equal(state.resumes.find((item) => item.id === created.resume.id)?.scanStatus, 'clean')
    assert.equal(state.analysisResults.length, 1)
  })

  it('backfills candidate profile fields from the parsed resume', async () => {
    const { service, store, created } = await createLocalFixture([
      '张伟',
      '邮箱：zhangwei@example.com',
      '电话：13800138000',
      '技能：TypeScript、PostgreSQL',
    ].join('\n'))
    await store.transaction((state) => {
      const candidate = state.candidates.find((item) => item.id === 'candidate-8821')
      assert.ok(candidate)
      candidate.fullName = '待解析候选人'
      delete candidate.email
      delete candidate.phone
    })

    await service.processAnalysisTask(created.task.id)

    const state = await store.read()
    const candidate = state.candidates.find((item) => item.id === 'candidate-8821')
    assert.equal(candidate?.fullName, '张伟')
    assert.equal(candidate?.email, 'zhangwei@example.com')
    assert.equal(candidate?.phone, '13800138000')
  })

  it('records human edits to the analysis result and score', async () => {
    const { service, store, created } = await createLocalFixture()
    await service.processAnalysisTask(created.task.id)
    const before = await store.read()
    const result = before.analysisResults.find((item) => item.analysisTaskId === created.task.id)
    assert.ok(result)
    const originalScore = (result.result.assessment as { score?: number }).score

    const updated = await service.reviewAnalysisResult(result.id, {
      status: 'accepted',
      comment: '人工调整评分依据',
      edits: {
        score: 88,
        recommendation: 'match',
        strengths: ['具备后端工程经验'],
        risks: ['需要补充系统设计面试'],
      },
    }, 'reviewer-1')

    assert.equal((updated.result.assessment as { score?: number }).score, 88)
    const history = (updated.result.humanReview as { history?: Array<{ before?: { score?: number }; after?: { score?: number }; editedBy?: string; comment?: string }> }).history
    assert.equal(history?.length, 1)
    assert.equal(history?.[0]?.before?.score, originalScore)
    assert.equal(history?.[0]?.after?.score, 88)
    assert.equal(history?.[0]?.editedBy, 'reviewer-1')
    assert.equal(history?.[0]?.comment, '人工调整评分依据')
  })
})

describe('candidate tags', () => {
  it('does not materialize a repository snapshot when tags are not persisted', async () => {
    process.env.NODE_ENV = 'test'
    const service = new RecruitingService()
    ;(service as any).repository = {}

    assert.deepEqual(await service.listCandidateTags(), [])
  })
})

describe('offer onboarding archive', () => {
  it('reuses the existing onboarding record when archive is repeated', async () => {
    process.env.NODE_ENV = 'test'
    const directory = await mkdtemp(join(tmpdir(), 'recruiting-onboarding-'))
    temporaryDirectories.push(directory)
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store, directory)
    const offer = await service.createOffer({
      applicationId: 'application-8814',
      positionTitle: '测试工程师',
      departmentId: 'dept-tech',
      employmentType: 'full_time',
      baseSalary: { amount: 20000, currency: 'CNY' },
      content: '欢迎加入',
    })

    await service.offerAction(offer.id, 'submit_approval')
    await service.offerAction(offer.id, 'approve')
    await service.offerAction(offer.id, 'send')
    await service.offerAction(offer.id, 'accept')
    const first = await service.offerAction(offer.id, 'archive_onboarding')
    const second = await service.offerAction(offer.id, 'archive_onboarding')

    assert.equal(second.id, first.id)
    const state = await store.read()
    assert.equal(state.onboarding.filter((item) => item.offerId === offer.id).length, 1)
  })
})
