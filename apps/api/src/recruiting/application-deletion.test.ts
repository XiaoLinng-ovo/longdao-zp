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
  const path = await mkdtemp(join(tmpdir(), 'application-deletion-test-')); directories.push(path)
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store, path)
  const uploaded = await service.createResume({ candidateId: 'candidate-8821', applicationId: 'application-8821', originalFilename: 'resume.txt', mimeType: 'text/plain', content: 'Java Spring PostgreSQL 8 years experience' })
  await service.processAnalysisTask(uploaded.task.id)
  const application = await service.createApplication({ candidateId: 'candidate-8821', jobId: 'job-107' })
  const task = await service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, application.id)
  await service.processAnalysisTask(task.id)
  return { store, service, uploaded, application, task }
}

describe('single application deletion', () => {
  it('removes only the selected application while preserving other scoring and the shared resume', async () => {
    const { store, service, uploaded, application } = await fixture()
    await store.transaction((state) => {
      const original = state.applications.find((item) => item.id === 'application-8821')!
      original.status = 'rejected'
      state.analysisResults.find((item) => item.analysisTaskId === uploaded.task.id)!.result.scoring = {
        aiScore: 84, humanScore: 72, finalScore: 76.8, decision: 'eliminated', talentPool: true, history: [],
      }
    })
    const before = await store.read()
    await service.deleteApplication(application.id, 'reviewer')
    const after = await store.read()
    assert.deepEqual(after.candidates, before.candidates)
    assert.deepEqual(after.resumes, before.resumes)
    assert.deepEqual(after.applications, before.applications.filter((item) => item.id !== application.id))
    assert.deepEqual(after.analysisTasks, before.analysisTasks.filter((item) => item.applicationId !== application.id))
    assert.deepEqual(after.analysisResults, before.analysisResults.filter((item) => item.applicationId !== application.id))
    assert.ok(after.workflowEvents.some((event) => event.action === 'delete' && event.subjectId === application.id && event.actorId === 'reviewer'))
  })
  it('detaches a deleted original application but retains the reused file and sibling results', async () => {
    const { store, service, uploaded, application, task } = await fixture()
    const before = await store.read()
    await service.deleteApplication('application-8821')
    const after = await store.read()
    assert.equal(after.resumes[0]!.id, uploaded.resume.id)
    assert.equal(after.resumes[0]!.applicationId, undefined)
    assert.equal(after.resumes[0]!.storageKey, before.resumes[0]!.storageKey)
    assert.deepEqual(after.analysisResults.find((item) => item.analysisTaskId === task.id), before.analysisResults.find((item) => item.analysisTaskId === task.id))
    assert.ok(after.applications.some((item) => item.id === application.id))
    await service.deleteApplication(application.id)
    const final = await store.read()
    assert.ok(final.candidates.some((item) => item.id === 'candidate-8821'))
    assert.ok(final.resumes.some((item) => item.id === uploaded.resume.id))
    assert.ok(!final.applications.some((item) => item.candidateId === 'candidate-8821'))
  })
  it('rejects deleting a processing target with no partial changes', async () => {
    const { store, service, application, task } = await fixture()
    await store.transaction((state) => { state.analysisTasks.find((item) => item.id === task.id)!.status = 'processing' })
    const before = await store.read()
    await assert.rejects(service.deleteApplication(application.id), (error: any) => error.code === 'APPLICATION_ANALYSIS_IN_PROGRESS')
    assert.deepEqual(await store.read(), before)
  })
  it('does not block deletion when another job is processing the same file', async () => {
    const { store, service, uploaded, application } = await fixture()
    await store.transaction((state) => { state.analysisTasks.find((item) => item.id === uploaded.task.id)!.status = 'processing' })
    await service.deleteApplication(application.id)
    assert.equal((await store.read()).analysisTasks.find((item) => item.id === uploaded.task.id)!.status, 'processing')
  })
  for (const collection of ['interviews', 'offers', 'onboarding'] as const) {
    it(`protects an application with ${collection} records`, async () => {
      const { store, service, application } = await fixture()
      await store.transaction((state) => { state[collection].push({ id: 'related', applicationId: application.id } as never) })
      const before = await store.read()
      await assert.rejects(service.deleteApplication(application.id), (error: any) => error.code === 'APPLICATION_IN_USE')
      assert.deepEqual(await store.read(), before)
    })
  }
  it('rejects a missing application without deleting any candidate data', async () => {
    const { store, service } = await fixture()
    const before = await store.read()
    await assert.rejects(service.deleteApplication('missing'), (error: any) => error.code === 'NOT_FOUND')
    assert.deepEqual(await store.read(), before)
  })
})
