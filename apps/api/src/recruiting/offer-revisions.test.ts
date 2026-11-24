import assert from 'node:assert/strict'
import { it } from 'node:test'
import { LocalRecruitingStore } from './store.js'
import { RecruitingService } from './service.js'

it('preserves accepted state, old acceptance and onboarding while revising and resending', async () => {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store)
  const applicationId = 'application-8814'
  const final = await service.createInterview({ applicationId, round: 2, title: 'Final', participants: [{ userId: 'user-demo', role: 'interviewer' }] })
  await service.submitFeedback(final.id, { interviewerId: 'user-demo', overallScore: 90 })
  await service.lockFeedback(final.id, 'user-demo')
  await service.concludeInterview(final.id, 'offer')
  const original = await service.createOffer({ applicationId, positionTitle: '工程师', departmentId: 'dept-success', employmentType: 'full_time', baseSalary: { amount: 10000, currency: 'CNY' }, content: '<p>原正文</p>', reportingLocation: '旧地址' })
  await service.offerAction(original.id, 'send')
  await service.offerAction(original.id, 'accept')
  const accepted = await service.getOffer(original.id)
  assert.equal(accepted.confirmation.currentVersionStatus, 'confirmed')
  const onboarding = await service.offerAction(original.id, 'archive_onboarding')
  const before = await store.read()
  const applicationStatus = before.applications.find(item => item.id === applicationId)!.status
  await service.updateOffer(original.id, { reportingLocation: '新地址', baseSalary: { amount: 12000, currency: 'CNY' }, content: '<p>新正文</p>' })
  const revised = await service.getOffer(original.id)
  assert.equal(revised.status, 'accepted')
  assert.equal(revised.respondedAt, accepted.respondedAt)
  assert.equal(revised.confirmation.currentVersionStatus, 'pending')
  assert.equal(revised.confirmation.confirmations[0]!.versionId, accepted.currentVersionId)
  assert.equal(revised.versions.length, 2)
  assert.equal(revised.versions[1]!.content, '<p>原正文</p>')
  await assert.rejects(service.offerAction(original.id, 'resend', undefined, 'user-demo', undefined, accepted.currentVersionId), (error: any) => error.code === 'OFFER_VERSION_CONFLICT')
  await service.offerAction(original.id, 'resend', undefined, 'user-demo', undefined, revised.currentVersionId, { recipient: 'saved@example.test', subject: '补发' })
  const resent = await service.getOffer(original.id)
  assert.equal(resent.status, 'accepted')
  assert.equal(resent.respondedAt, accepted.respondedAt)
  assert.equal(resent.confirmation.currentVersionStatus, 'pending')
  assert.equal(resent.confirmation.lastSentVersionId, revised.currentVersionId)
  assert.deepEqual(resent.lastEmail, { to: 'saved@example.test', subject: '补发' })
  assert.deepEqual((await new RecruitingService(store).getOffer(original.id)).lastEmail, resent.lastEmail)
  assert.equal((await store.read()).applications.find(item => item.id === applicationId)!.status, applicationStatus)
  assert.deepEqual((await store.read()).onboarding.find(item => item.id === onboarding.id), before.onboarding.find(item => item.id === onboarding.id))
  assert.deepEqual(await service.listApplications(undefined, undefined, undefined, true), [])
  await assert.rejects(service.offerAction(original.id, 'confirm_revision', '', 'user-demo', undefined, revised.currentVersionId))
  await assert.rejects(service.offerAction(original.id, 'confirm_revision', '邮件确认'))
  await service.offerAction(original.id, 'confirm_revision', '候选人邮件确认新条款', 'user-demo', undefined, revised.currentVersionId)
  const confirmed = await service.getOffer(original.id)
  assert.equal(confirmed.confirmation.currentVersionStatus, 'confirmed')
  assert.equal(confirmed.confirmation.confirmations.length, 2)
  assert.equal(confirmed.respondedAt, accepted.respondedAt)
})

