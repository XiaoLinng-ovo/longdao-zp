import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

async function fixture() {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store)
  const initial = await service.createInterview({
    applicationId: 'application-8814', round: 1, title: 'Initial',
    participants: [{ userId: 'interviewer-1', role: 'interviewer', required: true }],
  })
  await service.submitFeedback(initial.id, { interviewerId: 'interviewer-1', overallScore: 90 })
  await service.lockFeedback(initial.id, 'interviewer-1')
  return { store, service, initial }
}

describe('initial interview advancement', () => {
  it('creates one independent unscheduled final round and keeps confirmation idempotent', async () => {
    const { store, service, initial } = await fixture()
    await service.concludeInterview(initial.code, 'continue')
    const before = await store.read()
    const final = before.interviews.find(item => item.applicationId === initial.applicationId && item.stage === 'final')!
    assert.ok(final)
    assert.notEqual(final.id, initial.id)
    assert.equal(final.round, 2)
    assert.equal(final.status, 'scheduled')
    assert.equal(final.scheduledStartAt, undefined)
    assert.deepEqual(final.participants, initial.participants)
    assert.equal(before.interviews.find(item => item.id === initial.id)?.status, 'completed')
    await service.concludeInterview(initial.id, 'continue')
    assert.deepEqual(await store.read(), before)
  })

  it('rejects unlocked feedback and missing required interviewers without partial writes', async () => {
    const { store, service, initial } = await fixture()
    await store.transaction(state => { state.interviewFeedback.find(item => item.interviewId === initial.id)!.status = 'submitted' })
    let before = await store.read()
    await assert.rejects(service.concludeInterview(initial.id, 'continue'), (error: any) => error.code === 'INTERVIEW_FEEDBACK_INCOMPLETE')
    assert.deepEqual(await store.read(), before)
    await service.lockFeedback(initial.id, 'interviewer-1')
    await store.transaction(state => { state.interviews.find(item => item.id === initial.id)!.participants.push({ userId: 'interviewer-2', role: 'interviewer', required: true }) })
    before = await store.read()
    await assert.rejects(service.concludeInterview(initial.id, 'continue'), (error: any) => error.code === 'INTERVIEW_FEEDBACK_INCOMPLETE')
    assert.deepEqual(await store.read(), before)
  })

  it('repairs an old continue conclusion without duplicating its audit event', async () => {
    const { store, service, initial } = await fixture()
    await store.transaction(state => {
      state.interviews.find(item => item.id === initial.id)!.status = 'completed'
      state.workflowEvents.push({ id: 'legacy-conclusion', subjectType: 'interview', subjectId: initial.id, action: 'conclude', actorId: 'user-demo', createdAt: initial.createdAt, metadata: { outcome: 'continue' } })
    })
    await service.concludeInterview(initial.id, 'continue')
    const state = await store.read()
    assert.equal(state.interviews.filter(item => item.applicationId === initial.applicationId && item.stage === 'final').length, 1)
    assert.equal(state.workflowEvents.filter(item => item.subjectId === initial.id && item.action === 'conclude').length, 1)
  })

  it('does not resurrect a cancelled final or roll back an Offer on replay', async () => {
    const { store, service, initial } = await fixture()
    await service.concludeInterview(initial.id, 'continue')
    await store.transaction(state => {
      state.interviews.find(item => item.applicationId === initial.applicationId && item.stage === 'final')!.status = 'cancelled'
      state.applications.find(item => item.id === initial.applicationId)!.status = 'offer_approval'
    })
    const before = await store.read()
    await service.concludeInterview(initial.id, 'continue')
    assert.deepEqual(await store.read(), before)
    await assert.rejects(service.concludeInterview(initial.id, 'reject'), (error: any) => error.code === 'INTERVIEW_ALREADY_CONCLUDED')
    assert.deepEqual(await store.read(), before)
  })

  it('never concludes a cancelled initial or an application that has left interviewing', async () => {
    const { store, service, initial } = await fixture()
    await store.transaction(state => { state.interviews.find(item => item.id === initial.id)!.status = 'cancelled' })
    let before = await store.read()
    await assert.rejects(service.concludeInterview(initial.id, 'continue'), (error: any) => error.code === 'INTERVIEW_CANCELLED')
    assert.deepEqual(await store.read(), before)
    await store.transaction(state => {
      state.interviews.find(item => item.id === initial.id)!.status = 'completed'
      state.applications.find(item => item.id === initial.applicationId)!.status = 'rejected'
    })
    before = await store.read()
    await assert.rejects(service.concludeInterview(initial.id, 'continue'), (error: any) => error.code === 'APPLICATION_NOT_INTERVIEWABLE')
    assert.deepEqual(await store.read(), before)
  })
})
