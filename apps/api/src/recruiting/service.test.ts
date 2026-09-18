import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

const temporaryDirectories: string[] = []

async function createLocalFixture() {
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
    content: 'Java Spring Boot PostgreSQL, 8 years experience',
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
})
