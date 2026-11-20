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
    await assert.rejects(service.concludeInterview(initial.id, 'offer'), (error: any) => error.code === 'INVALID_INTERVIEW_OUTCOME')
    assert.deepEqual(await service.listApplications(undefined, undefined, undefined, true), [])
    await assert.rejects(service.createOffer(input), (error: any) => error.status === 409)
    const final = await service.createInterview({ applicationId: input.applicationId, round: 2, title: 'Final', participants: [{ userId: 'user-demo', role: 'interviewer' }] })
    await service.submitFeedback(final.id, { interviewerId: 'user-demo', overallScore: 90 })
    await service.lockFeedback(final.id, 'user-demo')
    assert.deepEqual(await service.listApplications(undefined, undefined, undefined, true), [])
    await service.concludeInterview(final.id, 'offer')
    assert.deepEqual((await service.listApplications(undefined, undefined, undefined, true)).map(item => item.id), [input.applicationId])
    assert.equal((await service.createOffer(input)).status, 'draft')
    assert.deepEqual(await service.listApplications(undefined, undefined, undefined, true), [])
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

  it('allows creating a fresh offer after cancellation and resending the cancelled offer', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    const applicationId = 'application-8814'
    const final = await service.createInterview({ applicationId, round: 2, title: 'Final', participants: [{ userId: 'user-demo', role: 'interviewer' }] })
    await service.submitFeedback(final.id, { interviewerId: 'user-demo', overallScore: 90 })
    await service.lockFeedback(final.id, 'user-demo')
    await service.concludeInterview(final.id, 'offer')

    const input = { applicationId, positionTitle: 'Test', departmentId: 'dept-success', employmentType: 'full_time', baseSalary: { amount: 10000, currency: 'CNY' }, content: 'Test', materials: ['id_card'] }
    const original = await service.createOffer(input)
    await service.offerAction(original.id, 'cancel', '候选人暂缓入职')
    assert.deepEqual((await service.listApplications(undefined, undefined, undefined, true)).map(item => item.id), [applicationId])

    await service.offerAction(original.id, 'resend_cancelled')
    const resent = (await store.read()).offers.find(item => item.id === original.id)
    assert.equal(resent?.status, 'sent')
    assert.ok(resent?.sentAt)
    await service.offerAction(original.id, 'cancel', '候选人仍需重新沟通')
    assert.deepEqual((await service.listApplications(undefined, undefined, undefined, true)).map(item => item.id), [applicationId])

    const replacement = await service.createOffer({ ...input, baseSalary: { amount: 12000, currency: 'CNY' }, materials: ['medical_report'] })
    assert.notEqual(replacement.id, original.id)
    const stateAfterCreate = await store.read()
    assert.deepEqual(stateAfterCreate.offerVersions.find(item => item.offerId === original.id)?.materials, ['id_card'])
    assert.deepEqual(stateAfterCreate.offerVersions.find(item => item.offerId === replacement.id)?.materials, ['medical_report'])
    assert.deepEqual(await service.listApplications(undefined, undefined, undefined, true), [])

    assert.equal((await service.listApplications(undefined, undefined, undefined, true)).length, 0)
  })

  it('persists selected onboarding materials across offer revisions', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    const applicationId = 'application-8814'
    const final = await service.createInterview({ applicationId, round: 2, title: 'Final', participants: [{ userId: 'user-demo', role: 'interviewer' }] })
    await service.submitFeedback(final.id, { interviewerId: 'user-demo', overallScore: 90 })
    await service.lockFeedback(final.id, 'user-demo')
    await service.concludeInterview(final.id, 'offer')
    const offer = await service.createOffer({
      applicationId,
      positionTitle: 'Test',
      departmentId: 'dept-success',
      employmentType: 'full_time',
      baseSalary: { amount: 10000, currency: 'CNY' },
      materials: ['id_card', 'bank_card:招商银行'],
      content: 'Test',
    })
    assert.deepEqual((await store.read()).offerVersions.find((item) => item.offerId === offer.id)?.materials, ['id_card', 'bank_card:招商银行'])

    await service.updateOffer(offer.id, { materials: ['medical_report'] })
    const versions = (await store.read()).offerVersions.filter((item) => item.offerId === offer.id).sort((a, b) => a.version - b.version)
    assert.deepEqual(versions.map((item) => item.materials), [['id_card', 'bank_card:招商银行'], ['medical_report']])
  })

  it('uses local insertion order for cancellation events sharing a timestamp', () => {
    const state = createSeedState()
    const application = state.applications[1]!
    application.status = 'offer_cancelled'
    const timestamp = '2026-11-10T00:00:00.000Z'
    state.offers = [{ id: 'offer-same-time', code: 'OFF-TEST', applicationId: application.id, status: 'cancelled', approval: { status: 'pending', approver: 'test' }, version: 1, createdAt: timestamp, updatedAt: timestamp }]
    state.interviews.push({ id: 'final-same-time', code: 'INT-TEST', applicationId: application.id, round: 2, type: 'other', title: 'Final', status: 'completed', participants: [], createdAt: timestamp, updatedAt: timestamp })
    state.workflowEvents.push(
      { id: 'interview-pass', subjectType: 'interview', subjectId: 'final-same-time', action: 'conclude', actorId: 'actor', createdAt: timestamp, metadata: { outcome: 'offer' } },
      { id: 'z-create', subjectType: 'offer', subjectId: 'offer-same-time', action: 'create', toStatus: 'draft', actorId: 'actor', createdAt: timestamp },
      { id: 'a-cancel', subjectType: 'offer', subjectId: 'offer-same-time', action: 'cancel', toStatus: 'cancelled', actorId: 'actor', createdAt: timestamp },
    )
    assert.equal(isLocalOfferEligible(application, state), true)
    state.workflowEvents.push({ id: '0-resend', subjectType: 'offer', subjectId: 'offer-same-time', action: 'resend_cancelled', toStatus: 'sent', actorId: 'actor', createdAt: timestamp })
    assert.equal(isLocalOfferEligible(application, state), false)
  })
})
