import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import type { AnalysisResultRecord } from './types.js'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

const previousNodeEnv = process.env.NODE_ENV
before(() => { process.env.NODE_ENV = 'test' })
after(() => { if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv })

function fixture() {
  const store = new LocalRecruitingStore()
  const files = new Map<string, Buffer>()
  const storage: ObjectStorage = {
    kind: 'local',
    async put(key, bytes) { files.set(key, Buffer.from(bytes)) },
    async get(key) { const value = files.get(key); if (!value) throw new Error('missing'); return value },
    async delete(key) { files.delete(key) },
    async health() { return true },
  }
  return { store, files, service: new RecruitingService(store, undefined, storage) }
}

async function upload(service: RecruitingService, applicationId?: string, content = 'Java PostgreSQL platform engineering experience') {
  return service.createResume({ candidateId: 'candidate-8821', ...(applicationId ? { applicationId } : {}), originalFilename: 'resume.txt', mimeType: 'text/plain', content })
}

async function interview(service: RecruitingService, applicationId = 'application-8821', round = 1) {
  return service.createInterview({ applicationId, round, title: 'Resume context regression', participants: [{ userId: 'user-demo' }] })
}

function analysis(resumeId: string, taskId: string, applicationId?: string, summary = 'Current application experience', createdAt = '2026-10-23T08:00:00.000Z'): AnalysisResultRecord {
  return { id: `result-${taskId}`, resumeId, analysisTaskId: taskId, ...(applicationId ? { applicationId } : {}),
    result: { analysis: { report: { extraction: { profile: { summary } }, assessment: { strengths: ['Current strength'] } } } },
    analyzerVersion: 'test', inputHash: 'test', humanReviewStatus: 'pending', createdAt }
}

describe('application resume continuity', () => {
  it('keeps the application resume through multiple rounds and workflow status changes without leaking storage keys', async () => {
    const { service, store } = fixture()
    const uploaded = await upload(service, 'application-8821')
    const first = await interview(service)
    const final = await interview(service, 'application-8821', 2)
    for (const status of ['interviewing', 'offer_accepted', 'onboarding_archived'] as const) {
      await store.transaction(state => { state.applications.find(item => item.id === 'application-8821')!.status = status })
      const metadata = await service.getApplicationResume('application-8821')
      assert.equal(metadata?.id, uploaded.resume.id)
      assert.equal('storageKey' in metadata!, false)
      assert.match((await service.getInterviewQuestionContext(first.id)).anonymizedResume, /PostgreSQL/)
      assert.match((await service.getInterviewQuestionContext(final.id)).anonymizedResume, /PostgreSQL/)
    }
  })

  it('does not substitute a newer resume or analysis from another job', async () => {
    const { service, store } = fixture()
    const current = await upload(service, 'application-8821')
    const other = await service.createApplication({ candidateId: 'candidate-8821', jobId: 'job-107', source: 'test' })
    const foreign = await upload(service, other.id, 'Unrelated marketing resume')
    await store.transaction(state => {
      state.resumes.find(item => item.id === foreign.resume.id)!.createdAt = '2099-01-01T00:00:00.000Z'
      state.analysisResults.push(analysis(current.resume.id, current.task.id, 'application-8821', 'Current engineering experience'))
      state.analysisResults.push(analysis(foreign.resume.id, foreign.task.id, other.id, 'Unrelated marketing experience', '2099-01-01T00:00:00.000Z'))
    })
    const meeting = await interview(service)
    assert.equal((await service.getApplicationResume('application-8821'))?.id, current.resume.id)
    const context = await service.getInterviewQuestionContext(meeting.id)
    assert.match(context.anonymizedResume, /Current engineering experience/)
    assert.doesNotMatch(context.anonymizedResume, /marketing/)
    assert.deepEqual(context.analysisSummary, ['Current strength'])
  })

  it('follows reused files through new tasks and ignores the original application analysis', async () => {
    const { service, store } = fixture()
    const uploaded = await upload(service, 'application-8821')
    const next = await service.createApplication({ candidateId: 'candidate-8821', jobId: 'job-107', source: 'test' })
    const task = await service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, next.id)
    await store.transaction(state => {
      state.analysisResults.push(analysis(uploaded.resume.id, uploaded.task.id, undefined, 'Wrong legacy job assessment'))
      state.analysisResults.push(analysis(uploaded.resume.id, task.id, undefined, 'Reused current job assessment'))
    })
    const meeting = await interview(service, next.id, 2)
    assert.equal((await service.getApplicationResume(next.id))?.id, uploaded.resume.id)
    assert.equal((await store.read()).resumes[0]!.applicationId, 'application-8821')
    assert.match((await service.getInterviewQuestionContext(meeting.id)).anonymizedResume, /Reused current job assessment/)
  })

  it('uses original text rather than another job assessment when reuse analysis is pending', async () => {
    const { service, store } = fixture()
    const uploaded = await upload(service, 'application-8821')
    const next = await service.createApplication({ candidateId: 'candidate-8821', jobId: 'job-107', source: 'test' })
    await service.analyzeResumeForApplication('candidate-8821', uploaded.resume.id, next.id)
    await store.transaction(state => { state.analysisResults.push(analysis(uploaded.resume.id, uploaded.task.id, undefined, 'Wrong legacy job assessment')) })
    const meeting = await interview(service, next.id)
    const context = await service.getInterviewQuestionContext(meeting.id)
    assert.match(context.anonymizedResume, /PostgreSQL/)
    assert.doesNotMatch(context.anonymizedResume, /Wrong legacy/)
    assert.deepEqual(context.analysisSummary, [])
  })

  it('does not let late analysis completion replace a newer uploaded resume', async () => {
    const { service, store } = fixture()
    const older = await upload(service, 'application-8821', 'Old experience')
    const newer = await upload(service, 'application-8821', 'New Kubernetes experience')
    await store.transaction(state => {
      state.resumes.find(item => item.id === older.resume.id)!.createdAt = '2026-01-01T00:00:00.000Z'
      state.analysisTasks.find(item => item.id === older.task.id)!.createdAt = '2026-01-01T00:00:00.000Z'
      state.resumes.find(item => item.id === newer.resume.id)!.createdAt = '2026-02-01T00:00:00.000Z'
      state.analysisTasks.find(item => item.id === newer.task.id)!.createdAt = '2026-02-01T00:00:00.000Z'
      state.analysisResults.push(analysis(older.resume.id, older.task.id, 'application-8821', 'Old experience', '2026-03-01T00:00:00.000Z'))
    })
    assert.equal((await service.getApplicationResume('application-8821'))?.id, newer.resume.id)
  })

  it('only falls back to truly unbound legacy files', async () => {
    const { service } = fixture()
    const other = await service.createApplication({ candidateId: 'candidate-8821', jobId: 'job-107', source: 'test' })
    await upload(service, other.id)
    assert.equal(await service.getApplicationResume('application-8821'), null)
    const legacy = await upload(service, undefined, 'Legacy unbound experience')
    assert.equal((await service.getApplicationResume('application-8821'))?.id, legacy.resume.id)
    const meeting = await interview(service)
    assert.match((await service.getInterviewQuestionContext(meeting.id)).anonymizedResume, /Legacy unbound/)
  })

  it('does not accept another candidate resume through an invalid analysis association', async () => {
    const { service, store } = fixture()
    const foreign = await service.createResume({ candidateId: 'candidate-8814', applicationId: 'application-8814', originalFilename: 'foreign.txt', mimeType: 'text/plain', content: 'Foreign candidate' })
    await store.transaction(state => {
      state.analysisTasks.find(item => item.id === foreign.task.id)!.applicationId = 'application-8821'
      state.analysisResults.push(analysis(foreign.resume.id, foreign.task.id, 'application-8821'))
    })
    assert.equal(await service.getApplicationResume('application-8821'), null)
    const meeting = await interview(service)
    assert.equal((await service.getInterviewQuestionContext(meeting.id)).anonymizedResume, '')
  })

  it('blocks infected context and reports missing originals instead of inventing resume text', async () => {
    const { service, store, files } = fixture()
    const uploaded = await upload(service, 'application-8821')
    const meeting = await interview(service)
    await store.transaction(state => { state.resumes[0]!.scanStatus = 'infected' })
    await assert.rejects(service.getInterviewQuestionContext(meeting.id), (error: any) => error.code === 'RESUME_SCAN_NOT_CLEAN')
    await store.transaction(state => { state.resumes[0]!.scanStatus = 'clean' })
    files.clear()
    await assert.rejects(service.getInterviewQuestionContext(meeting.id), (error: any) => error.code === 'OBJECT_STORAGE_UNAVAILABLE')
    await assert.rejects(service.getApplicationResume('missing'), (error: any) => error.status === 404)
  })
})
