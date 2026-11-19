import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { interviewProgressByApplication } from './interview-progress.js'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'
import type { NormalizedRecruitingRepository } from './repositories/index.js'

const initial = { id: 'initial-1', applicationId: 'app-1', round: 1, status: 'scheduled', createdAt: '2026-10-16T01:00:00Z', scheduledStartAt: '2026-10-16T02:00:00Z' }

describe('application interview progress', () => {
  it('summarizes the actual interview and derives the initial stage for historical records', () => {
    assert.deepEqual(interviewProgressByApplication([initial]).get('app-1'), {
      id: 'initial-1', round: 1, stage: 'initial', status: 'scheduled', scheduledStartAt: initial.scheduledStartAt,
    })
  })
  it('uses the latest round, then the newest record in that round, without changing the input', () => {
    const interviews = [
      { ...initial, id: 'newer-initial', createdAt: '2026-10-16T04:00:00Z' },
      { ...initial, id: 'final-older', round: 2 },
      { ...initial, id: 'final-newer', round: 2, status: 'completed', createdAt: '2026-10-16T03:00:00Z' },
    ]
    const before = structuredClone(interviews)
    assert.deepEqual(interviewProgressByApplication(interviews).get('app-1'), {
      id: 'final-newer', round: 2, stage: 'final', status: 'completed', scheduledStartAt: initial.scheduledStartAt,
    })
    assert.deepEqual(interviews, before)
  })
  it('ignores cancelled records while preserving the last completed round and other applications', () => {
    const progress = interviewProgressByApplication([
      { ...initial, status: 'completed' },
      { ...initial, id: 'cancelled-final', round: 2, status: 'cancelled' },
      { ...initial, id: 'other-initial', applicationId: 'app-2' },
      { ...initial, id: 'cancelled-only', applicationId: 'app-3', status: 'cancelled' },
    ])
    assert.equal(progress.get('app-1')?.id, 'initial-1')
    assert.equal(progress.get('app-1')?.status, 'completed')
    assert.equal(progress.get('app-2')?.id, 'other-initial')
    assert.equal(progress.has('app-3'), false)
  })
  it('returns progress from stored interviews and removes it after cancellation or deletion', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    await store.transaction((state) => { state.interviews = state.interviews.filter((item) => item.applicationId !== 'application-8821') })
    const application = async () => (await service.listCandidates()).flatMap((row) => row.applications).find((row) => row.id === 'application-8821')!
    assert.equal((await application()).interviewProgress, undefined)
    const interview = await service.createInterview({ applicationId: 'application-8821', round: 1, title: '初试', participants: [{ userId: 'interviewer-1', role: 'interviewer' }] })
    assert.deepEqual((await application()).interviewProgress, { id: interview.id, round: 1, stage: 'initial', status: 'scheduled' })
    await store.transaction((state) => { state.interviews.find((item) => item.id === interview.id)!.status = 'completed' })
    assert.equal((await application()).interviewProgress?.status, 'completed')
    const final = await service.createInterview({ applicationId: 'application-8821', round: 2, title: '复试', participants: [{ userId: 'interviewer-1', role: 'interviewer' }] })
    assert.equal((await application()).interviewProgress?.stage, 'final')
    await store.transaction((state) => { state.interviews.find((item) => item.id === final.id)!.status = 'cancelled' })
    assert.equal((await application()).interviewProgress?.id, interview.id)
    await service.deleteInterview(interview.id)
    assert.equal((await application()).interviewProgress, undefined)
  })
  it('includes repository interview progress separately for each application in the list response', async () => {
    const repository = {
      listCandidates: async () => [{ id: 'candidate-1', name: '测试', businessId: 'CAN-1', createdAt: initial.createdAt, updatedAt: initial.createdAt }],
      listApplications: async () => ['app-1', 'app-2'].map((id) => ({ id, businessId: id, candidateId: 'candidate-1', jobId: id, status: 'interviewing', appliedAt: initial.createdAt, updatedAt: initial.createdAt })),
      listAnalysisResults: async () => [], listResumes: async () => [], listAnalysisTasks: async () => [],
      listInterviews: async () => [initial],
    } as unknown as NormalizedRecruitingRepository
    const service = new RecruitingService(undefined, undefined, undefined, repository)
    const [candidate] = await service.listCandidates()
    assert.equal(candidate!.applications[0]!.interviewProgress?.id, initial.id)
    assert.equal(candidate!.applications[1]!.interviewProgress, undefined)
  })
})
