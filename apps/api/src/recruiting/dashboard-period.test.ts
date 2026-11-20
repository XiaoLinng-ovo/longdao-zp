import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dashboardActivity, parseDashboardPeriod, withinPeriod } from './dashboard-period.js'
import { createSeedState, LocalRecruitingStore } from './store.js'
import { RecruitingService } from './service.js'

const period = { from: '2026-10-28T16:00:00.000Z', to: '2026-10-30T16:00:00.000Z', timeZone: 'Asia/Shanghai' }
const event = (id: string, time: string, toStatus = 'interviewing') => ({ id, subjectType: 'application' as const, subjectId: 'application-8821', action: 'status_changed', fromStatus: 'human_review', toStatus, actorId: 'user-demo', createdAt: time })

test('validates complete, ordered timestamp ranges and their timezone', () => {
  assert.equal(parseDashboardPeriod({}), undefined)
  assert.deepEqual(parseDashboardPeriod({ from: '2026-10-29T00:00:00+08:00', to: '2026-10-31T00:00:00+08:00' }), period)
  for (const input of [{ from: period.from }, { from: period.from, to: period.from }, { from: period.to, to: period.from }, { from: '2026-02-30T00:00:00Z', to: period.to }, { from: '2026-10-29', to: period.to }, { ...period, timeZone: 'Invalid/Zone' }, { from: '2000-01-01T00:00:00Z', to: period.to }]) {
    assert.throws(() => parseDashboardPeriod(input), (e: any) => e.code === 'VALIDATION_ERROR' && e.status === 400)
  }
  assert.equal(withinPeriod(period.from, period), true)
  assert.equal(withinPeriod(period.to, period), false)
})

test('uses real timestamps, counts each milestone once and groups Shanghai days across UTC midnight', () => {
  const state = createSeedState()
  const app = state.applications.find(a => a.id === 'application-8821')!
  state.applications = [{ ...app, appliedAt: '2026-10-01T00:00:00Z', status: 'rejected' }]
  state.resumes = [0, 1, 2].map((i) => ({ id: 'r' + i, candidateId: app.candidateId, storageKey: 'r', originalFilename: 'r.pdf', mimeType: 'application/pdf', sizeBytes: 1, contentHash: '', scanStatus: 'clean' as const,
    createdAt: [period.from, '2026-10-29T16:00:00Z', period.to][i]! }))
  state.workflowEvents = [event('pass', period.from), event('retry-pass', '2026-10-30T00:00:00Z'), event('outside-scope', period.from)]
  state.workflowEvents[2]!.subjectId = 'another-application'
  state.interviews = [{ id: 'i', code: 'INT', applicationId: app.id, round: 1, title: '初试', type: 'technical', status: 'completed', participants: [], createdAt: '2026-10-29T00:00:00Z', updatedAt: period.to }]
  state.offers = [{ id: 'o', code: 'OFF', applicationId: app.id, status: 'declined', sentAt: '2026-10-30T02:00:00Z', approval: { status: 'approved', approver: '' }, version: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: period.to }]
  state.onboarding = []
  const result = dashboardActivity(state, period)
  assert.deepEqual(result.counts, { resumes: 2, applications: 0, screened: 1, interviews: 1, offers: 1, onboarded: 0 })
  assert.deepEqual(result.series.map(row => [row.date, row.resumes, row.screened, row.offers]), [['2026-10-29', 1, 1, 0], ['2026-10-30', 1, 0, 1]])
  assert.equal(state.applications[0]!.status, 'rejected')
})

test('does not move older passes to the current period on retries or guess missing history from updatedAt', () => {
  const state = createSeedState()
  state.applications[0]!.status = 'interviewing'; state.applications[0]!.updatedAt = period.from
  state.workflowEvents = [event('old-pass', '2026-10-28T10:00:00Z'), event('new-retry', period.from)]
  state.interviews = []; state.offers = []; state.onboarding = []
  const result = dashboardActivity(state, period)
  assert.equal(result.counts.screened, 0)
  assert.equal(result.previousCounts.screened, 1)
  assert.equal(result.previousPeriod.to, period.from)
  assert.equal(result.previousPeriod.from, '2026-10-26T16:00:00.000Z')
})

test('returns zero buckets for an empty period and monthly buckets for long ranges', () => {
  const state = createSeedState(); state.applications = []; state.resumes = []; state.workflowEvents = []; state.interviews = []; state.offers = []; state.onboarding = []
  assert.ok(dashboardActivity(state, period).series.every(point => point.resumes === 0))
  const result = dashboardActivity(state, { from: '2026-01-01T00:00:00Z', to: '2026-11-01T00:00:00Z', timeZone: 'UTC' })
  assert.equal(result.granularity, 'month')
  assert.equal(result.series.length, 10)
})

test('dashboard period keeps every outstanding todo while reporting activity within the selected period', async () => {
  process.env.NODE_ENV = 'test'
  const store = new LocalRecruitingStore(), service = new RecruitingService(store)
  await store.transaction(state => {
    state.workflowEvents.push(event('pass', period.from))
    state.jobs.find(job => job.departmentId === 'dept-tech')!.updatedAt = period.from
    state.applications.find(application => application.id === 'application-8821')!.updatedAt = '2025-01-01T00:00:00.000Z'
    state.recruitmentRequests.find(request => request.status === 'pending_approval')!.updatedAt = '2025-01-01T00:00:00.000Z'
  })
  const all = await service.getDashboardSummary()
  const filtered = await service.getDashboardSummary('dept-tech', undefined, period)
  const unscoped = await service.getDashboardSummary(undefined, undefined, period)
  assert.ok(!all.activity)
  assert.equal(filtered.activity?.counts.screened, 1)
  assert.ok(filtered.todos.some(todo => todo.id === 'review-application-8821' && !withinPeriod(todo.updatedAt, period)))
  assert.ok(unscoped.todos.some(todo => todo.id === 'request-rr-24017' && !withinPeriod(todo.updatedAt, period)))
  assert.ok(unscoped.pendingApprovals.some(request => request.id === 'rr-24017'))
  assert.equal(filtered.funnel[0]?.conversionRate, null)
  assert.equal((await service.getDashboardSummary()).metrics[0]?.value, all.metrics[0]?.value)
})
