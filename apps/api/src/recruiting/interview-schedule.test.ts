import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { prepareInterviewScheduleUpdate } from './interview-schedule.js'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'

const current = { status: 'scheduled', scheduledStartAt: '2026-10-16T02:00:00.000Z', scheduledEndAt: '2026-10-16T03:00:00.000Z', location: 'A会议室', meetingUrl: 'https://meeting.example/old' }

describe('interview schedule validation', () => {
  it('normalizes dates, trims text, clears optional values and omits unchanged fields', () => {
    assert.deepEqual(prepareInterviewScheduleUpdate(current, { scheduledStartAt: '2026-10-16T10:00:00+08:00', location: ' B会议室 ', meetingUrl: '', scheduledEndAt: null }), {
      location: 'B会议室', meetingUrl: null, scheduledEndAt: null,
    })
  })

  for (const input of [null, [], 123, { status: 'completed' }, { applicationId: 'other' }, { participants: [] }, { location: 1 }, { scheduledStartAt: null }, { scheduledStartAt: '' }, { scheduledStartAt: 'invalid' }, { scheduledStartAt: '2026-10-16T10:00' }, { scheduledStartAt: '2026-02-30T10:00:00Z' }, { scheduledStartAt: '2026-10-17T00:00:00Z' }, { scheduledEndAt: '2026-10-16T02:00:00Z' }, { meetingUrl: 'ftp://meeting.example' }, { meetingUrl: 'not a url' }, { location: 'x'.repeat(1001) }]) {
    it(`rejects invalid schedule ${JSON.stringify(input).slice(0, 100)}`, () => {
      assert.throws(() => prepareInterviewScheduleUpdate(current, input), (error: any) => error.code === 'VALIDATION_ERROR' && error.status === 400)
    })
  }

  for (const status of ['completed', 'cancelled']) {
    it(`does not change ${status} interview history`, () => {
      assert.throws(() => prepareInterviewScheduleUpdate({ ...current, status }, { location: 'B' }), (error: any) => error.code === 'INTERVIEW_NOT_EDITABLE' && error.status === 409)
    })
  }
})

describe('interview rescheduling persistence', () => {
  it('updates the original interview by code without losing feedback, participants or application state', async () => {
    process.env.NODE_ENV = 'test'
    const store = new LocalRecruitingStore()
    const service = new RecruitingService(store)
    const interview = await service.createInterview({ applicationId: 'application-8821', title: '初试', ...current,
      participants: [{ userId: 'user-demo', name: '面试官甲', role: 'interviewer' }] })
    await service.submitFeedback(interview.id, { interviewerId: 'user-demo', overallScore: 85 })
    const before = await store.read()
    const changed = await service.updateInterviewSchedule(interview.code, { scheduledStartAt: '2026-10-17T06:00:00Z', scheduledEndAt: null, location: ' B会议室 ', meetingUrl: null }, 'editor')
    const after = await store.read()
    assert.equal(changed.id, interview.id)
    assert.equal(changed.code, interview.code)
    assert.equal(changed.scheduledStartAt, '2026-10-17T06:00:00.000Z')
    assert.equal(changed.scheduledEndAt, undefined)
    assert.equal(changed.meetingUrl, undefined)
    assert.equal(changed.location, 'B会议室')
    assert.deepEqual(changed.participants, interview.participants)
    assert.deepEqual(after.applications, before.applications)
    assert.deepEqual(after.interviewFeedback, before.interviewFeedback)
    assert.equal(after.interviews.length, before.interviews.length)
    assert.equal((await service.getInterview(interview.id)).location, 'B会议室')
    const audit = after.workflowEvents.find((event) => event.subjectId === interview.id && event.action === 'update')!
    assert.equal(audit.actorId, 'editor')
    assert.deepEqual(audit.metadata?.before, { scheduledStartAt: current.scheduledStartAt, scheduledEndAt: current.scheduledEndAt, location: current.location, meetingUrl: current.meetingUrl })
    assert.equal((audit.metadata?.after as any).location, 'B会议室')
    const count = after.workflowEvents.length
    await service.updateInterviewSchedule(interview.id, { location: 'B会议室' })
    assert.equal((await store.read()).workflowEvents.length, count)
    await assert.rejects(service.updateInterviewSchedule(interview.id, { scheduledEndAt: '2026-10-16T00:00:00Z' }), /结束时间必须晚于/)
    assert.equal((await service.getInterview(interview.id)).scheduledEndAt, undefined)
    await assert.rejects(service.updateInterviewSchedule('missing', { location: 'B' }), (error: any) => error.code === 'NOT_FOUND')
  })
})
