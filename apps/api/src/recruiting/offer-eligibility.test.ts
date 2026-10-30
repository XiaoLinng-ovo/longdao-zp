import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LocalRecruitingStore, createSeedState } from './store.js'
import { RecruitingService } from './service.js'
import { isLocalOfferEligible } from './offer-eligibility.js'

describe('Offer final interview eligibility', () => {
  it('does not infer a pass from status, completed feedback or an initial interview', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    const input = { applicationId: 'application-8814', positionTitle: 'Test', departmentId: 'dept-success', employmentType: 'full_time', baseSalary: { amount: 10000, currency: 'CNY' }, content: 'Test' }
    await assert.rejects(service.createOffer(input), (error: any) => error.code === 'OFFER_APPLICATION_INVALID')
    const initial = await service.createInterview({ applicationId: input.applicationId, round: 1, title: 'Initial', participants: [{ userId: 'user-demo', role: 'interviewer' }] })
    await service.submitFeedback(initial.id, { interviewerId: 'user-demo', overallScore: 90 })
    await service.lockFeedback(initial.id, 'user-demo')
    await service.concludeInterview(initial.id, 'offer')
    assert.deepEqual(await service.listApplications(undefined, undefined, undefined, true), [])
    await assert.rejects(service.createOffer(input), (error: any) => error.status === 409)
    const final = await service.createInterview({ applicationId: input.applicationId, round: 2, title: 'Final', participants: [{ userId: 'user-demo', role: 'interviewer' }] })
    await service.submitFeedback(final.id, { interviewerId: 'user-demo', overallScore: 90 })
    await service.lockFeedback(final.id, 'user-demo')
    assert.deepEqual(await service.listApplications(undefined, undefined, undefined, true), [])
    await service.concludeInterview(final.id, 'offer')
    assert.deepEqual((await service.listApplications(undefined, undefined, undefined, true)).map(item => item.id), [input.applicationId])
    assert.equal((await service.createOffer(input)).status, 'draft')
    await store.transaction(state => { state.interviews.find(item => item.id === final.id)!.status = 'cancelled' })
    await assert.rejects(service.createOffer(input), (error: any) => error.code === 'OFFER_APPLICATION_INVALID')
  })

  it('does not accept rejected, hired or completed-without-decision records', () => {
    const state = createSeedState()
    const application = state.applications[1]!
    state.interviews.push({ id: 'final', code: 'INT-2', applicationId: application.id, round: 2, type: 'other', title: 'Final', status: 'completed', participants: [], createdAt: application.appliedAt, updatedAt: application.updatedAt })
    assert.equal(isLocalOfferEligible(application, state), false)
    state.workflowEvents.push({ id: 'event', subjectType: 'interview', subjectId: 'final', action: 'conclude', actorId: 'actor', createdAt: application.appliedAt, metadata: { outcome: 'offer' } })
    assert.equal(isLocalOfferEligible(application, state), true)
    for (const status of ['rejected', 'offer_accepted', 'onboarding_archived'] as const) { application.status = status; assert.equal(isLocalOfferEligible(application, state), false) }
  })
})
