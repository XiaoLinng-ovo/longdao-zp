import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summaryScore } from './interview-result.js'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

test('only a ready whole-interview AI report supplies a valid score, including zero', () => {
  for (const score of [0, 83.5, 100]) assert.equal(summaryScore('ready', { version: 'whole-dialogue-v2', overallScore: score }), score)
  for (const score of [null, undefined, '85', -1, 101, NaN]) assert.equal(summaryScore('ready', { version: 'whole-dialogue-v2', overallScore: score }), null)
  assert.equal(summaryScore('generating', { version: 'whole-dialogue-v2', overallScore: 90 }), null)
  assert.equal(summaryScore('ready', { version: 'actual-dialogue-v1', overallScore: 90 }), null)
})

test('direct completion advances, records separate round outcomes and enters Offer without fabricated feedback', async () => {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store)
  const initial = await service.createInterview({ applicationId: 'application-8821', round: 1, title: '初试', participants: [] })
  await assert.rejects(service.completeInterview(initial.id, 'offer'), (e: any) => e.code === 'INVALID_INTERVIEW_OUTCOME')
  await Promise.all([service.completeInterview(initial.id, 'continue'), service.completeInterview(initial.id, 'continue')])
  const state = await store.read()
  const final = state.interviews.find(i => i.applicationId === initial.applicationId && i.round === 2)!
  assert.ok(final)
  assert.equal(state.workflowEvents.filter(e => e.subjectId === initial.id && e.action === 'conclude').length, 1)
  assert.equal(state.interviewFeedback.filter(f => f.interviewId === initial.id).length, 0)
  await assert.rejects(service.completeInterview(final.id, 'continue'), (e: any) => e.code === 'INVALID_INTERVIEW_OUTCOME')
  await service.completeInterview(final.id, 'offer')
  const rows = await service.listInterviews(initial.applicationId)
  assert.equal(rows.find(i => i.id === initial.id)?.outcome, 'continue')
  assert.equal(rows.find(i => i.id === final.id)?.outcome, 'offer')
  assert.equal(rows.find(i => i.id === final.id)?.application.status, 'offer_approval')
  await assert.rejects(service.completeInterview(initial.id, 'reject'), (e: any) => e.code === 'INTERVIEW_ALREADY_CONCLUDED')
  assert.equal(rows.find(i => i.id === initial.id)?.aiScore, null)
})

test('feedback lock alone is not a result; rejection persists only to its own interview', async () => {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store)
  const initial = await service.createInterview({ applicationId: 'application-8821', round: 1, title: '初试', participants: [{ userId: 'user-demo' }] })
  await service.submitFeedback(initial.id, { interviewerId: 'user-demo', overallScore: 99 })
  await service.lockFeedback(initial.id, 'user-demo')
  assert.equal((await service.listInterviews(initial.applicationId)).find(i => i.id === initial.id)?.outcome, null)
  await service.completeInterview(initial.id, 'reject')
  const result = (await service.listInterviews(initial.applicationId)).find(i => i.id === initial.id)!
  assert.equal(result.outcome, 'reject')
  assert.equal(result.aiScore, null)
  assert.equal(result.application.status, 'rejected')
})

test('cancellation keeps both initial and final interview records without rejecting the application', async () => {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore()
  const service = new RecruitingService(store)
  const initial = await service.createInterview({ applicationId: 'application-8821', round: 1, title: '初试', participants: [] })

  await service.completeInterview(initial.id, 'cancelled')
  await service.completeInterview(initial.id, 'cancelled')
  let rows = await service.listInterviews(initial.applicationId)
  const cancelledInitial = rows.find(item => item.id === initial.id)!
  assert.equal(cancelledInitial.status, 'cancelled')
  assert.equal(cancelledInitial.outcome, 'cancelled')
  assert.equal(cancelledInitial.application.status, 'interviewing')
  assert.equal((await store.read()).workflowEvents.filter(event => event.subjectId === initial.id && event.action === 'conclude').length, 1)
  await assert.rejects(service.completeInterview(initial.id, 'reject'), (error: any) => error.code === 'INTERVIEW_CANCELLED')

  const final = await service.createInterview({ applicationId: initial.applicationId, round: 2, title: '复试', participants: [{ userId: 'interviewer-1', role: 'interviewer', required: true }] })
  await service.completeInterview(final.id, 'cancelled')
  rows = await service.listInterviews(initial.applicationId)
  const cancelledFinal = rows.find(item => item.id === final.id)!
  assert.equal(cancelledFinal.status, 'cancelled')
  assert.equal(cancelledFinal.outcome, 'cancelled')
  assert.equal(cancelledFinal.application.status, 'interviewing')
})
