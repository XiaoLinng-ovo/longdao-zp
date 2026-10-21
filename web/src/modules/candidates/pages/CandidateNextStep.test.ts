// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import CandidateListPage from './CandidateListPage.vue'
import { authSession } from '../../auth/session'
import { loadCandidateTags, loadCandidates, loadJobs, updateResumeReview } from '../api'
import type { Candidate } from '../../../shared/types/recruiting'
import { ApiResponseError } from '../../../shared/api'

vi.mock('../api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../api')>(),
  loadCandidates: vi.fn(), loadJobs: vi.fn(), loadCandidateTags: vi.fn(), updateResumeReview: vi.fn(),
}))
let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); root?.remove(); vi.resetAllMocks(); authSession.user = null })
function row(status = 'interviewing'): Candidate {
  return {
    id: 'CAN-1', entityId: 'candidate-1', name: '测试候选人', job: '算法工程师',
    score: 88, aiStatus: 'completed', applicationStatus: 'active', updatedAt: '2026-10-08',
    applicationId: 'application-1', rawApplicationStatus: status,
    resumeReview: { resultId: 'result-1', aiScore: 88, humanScore: 85, finalScore: 86.2,
      talentPool: false, history: [], evidence: [], strengths: [], risks: [] },
  }
}
async function mount(candidate: Candidate | Candidate[] = row(), role = 'recruiter') {
  authSession.user = { id: 'u1', name: '测试用户', email: 'test@example.invalid', role: role as 'recruiter', departmentId: 'd1' }
  vi.mocked(loadCandidates).mockResolvedValue(Array.isArray(candidate) ? candidate : [candidate])
  vi.mocked(loadJobs).mockResolvedValue([])
  vi.mocked(loadCandidateTags).mockResolvedValue([])
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/interviews', name: 'interviews', component: { template: '<div />' } },
    { path: '/interviews/:id', name: 'interview-detail', component: { template: '<div />' } },
  ] })
  await router.push('/')
  await router.isReady()
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(CandidateListPage); app.use(router); app.mount(root); await flush()
  return router
}
function button(text: string) { return [...root!.querySelectorAll('button')].find(item => item.textContent?.trim() === text) }

describe('candidate application ordering', () => {
  function application(id: string, status: string, timestamp: string): Candidate {
    return { ...row(status), id, entityId: id, applicationId: id, name: id,
      updatedAt: timestamp.slice(0, 10), updatedAtTimestamp: timestamp }
  }
  function names() { return [...root!.querySelectorAll('.candidate-cell strong')].map(el => el.textContent) }

  it('puts all screening states before processed applications, newest first within each group', async () => {
    const statuses = ['interviewing', 'rejected', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived', 'offer_declined', 'offer_cancelled', 'offer_expired']
    await mount([
      ...statuses.map((status, index) => application(status, status, `2026-10-19T${String(10 + index).padStart(2, '0')}:00:00Z`)),
      application('review', 'human_review', '2026-10-16T10:00:00Z'),
      application('queued', 'analysis_queued', '2026-10-17T10:00:00Z'),
      application('pending', 'pending_analysis', '2026-10-18T10:00:00Z'),
    ])
    expect(names()).toEqual(['pending', 'queued', 'review', ...statuses.reverse()])
  })

  it('uses complete timestamps, including timezone offsets, rather than the displayed date', async () => {
    await mount([
      application('morning', 'human_review', '2026-10-19T09:00:00+08:00'),
      application('afternoon', 'human_review', '2026-10-19T15:00:00+08:00'),
      application('latest', 'human_review', '2026-10-19T08:00:00Z'),
    ])
    expect(names()).toEqual(['latest', 'afternoon', 'morning'])
    expect([...root!.querySelectorAll('tbody tr')].map(el => el.children[8].textContent)).toEqual(Array(3).fill('2026-10-19'))
  })

  it('sorts grouped applications before choosing the visible one, without changing the source order', async () => {
    const passed = { ...application('group', 'interviewing', '2026-10-19T10:00:00Z'), job: 'Processed' }
    const pending = { ...application('group', 'human_review', '2026-10-18T10:00:00Z'), applicationId: 'pending', job: 'Pending' }
    const newer = { ...application('group', 'human_review', '2026-10-18T11:00:00Z'), applicationId: 'newer', job: 'Newest' }
    const children = [passed, pending, newer]
    await mount([{ ...passed, applicationRows: children }, application('other', 'rejected', '2026-10-19T12:00:00Z')])
    expect(names()).toEqual(['group', 'other'])
    expect(root!.querySelector('.job-cell')?.textContent).toBe('Newest')
    root!.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await flush()
    expect([...root!.querySelectorAll('.job-cell')].map(el => el.textContent).slice(0, 3)).toEqual(['Newest', 'Pending', 'Processed'])
    expect(children.map(item => item.job)).toEqual(['Processed', 'Pending', 'Newest'])
    const select = root!.querySelector<HTMLSelectElement>('[aria-label="岗位筛选"]')!
    select.value = 'Processed'; select.dispatchEvent(new Event('change')); await flush()
    expect(root!.querySelector('.job-cell')?.textContent).toBe('Processed')
  })

  it('keeps status priority when explicitly sorting scores, with newest first for equal scores', async () => {
    const candidates = [
      { ...application('processed', 'interviewing', '2026-10-19T12:00:00Z'), resumeReview: { ...row().resumeReview!, aiScore: 99 } },
      { ...application('low', 'human_review', '2026-10-19T12:00:00Z'), resumeReview: { ...row().resumeReview!, aiScore: 20 } },
      application('old', 'human_review', '2026-10-19T09:00:00Z'),
      application('new', 'human_review', '2026-10-19T10:00:00Z'),
    ]
    await mount(candidates)
    const select = root!.querySelector<HTMLSelectElement>('[aria-label="评分排序"]')!
    select.value = 'desc'; select.dispatchEvent(new Event('change')); await flush()
    expect(names()).toEqual(['new', 'old', 'low', 'processed'])
    select.value = 'none'; select.dispatchEvent(new Event('change')); await flush()
    expect(names()).toEqual(['low', 'new', 'old', 'processed'])
  })

  it('keeps unassociated candidates and falls back to date-only values without unstable ties', async () => {
    const unassociated = { ...application('unassociated', 'pending', '2026-10-19'), rawApplicationStatus: undefined, applicationStatus: 'pending' as const, applicationId: undefined, updatedAtTimestamp: undefined }
    const old = { ...application('old', 'human_review', '2026-10-18'), updatedAtTimestamp: undefined }
    await mount([application('processed', 'rejected', '2026-10-19T12:00:00Z'), old, unassociated, { ...old, id: 'tie', entityId: 'tie', applicationId: 'tie', name: 'tie' }])
    expect(names()).toEqual(['unassociated', 'old', 'tie', 'processed'])
  })
})

describe('resume screening next step', () => {
  it('hides repeated scheduling in both the table and score dialog for an existing interview', async () => {
    await mount({ ...row(), interviewProgress: { id: 'interview-1', round: 1, stage: 'initial', status: 'scheduled' } })
    expect(button('安排面试')).toBeUndefined()
    root!.querySelector<HTMLButtonElement>('.basis-link')!.click(); await flush()
    expect(button('下一步：初试邀约')).toBeUndefined()
  })
  it('opens the existing interview when another session scheduled after the page loaded', async () => {
    const router = await mount()
    vi.mocked(loadCandidates).mockResolvedValue([{ ...row(), interviewProgress: { id: 'interview-1', round: 1, stage: 'initial', status: 'scheduled' } }])
    button('安排面试')!.click(); await flush()
    expect(router.currentRoute.value.name).toBe('interview-detail')
    expect(router.currentRoute.value.params.id).toBe('interview-1')
    expect(router.currentRoute.value.query).toEqual({})
    expect(updateResumeReview).not.toHaveBeenCalled()
  })
  it('opens the existing interview when concurrent screening approval has already scheduled it', async () => {
    const router = await mount(row('human_review'))
    vi.mocked(loadCandidates).mockResolvedValueOnce([row('human_review')]).mockResolvedValue([{ ...row(), interviewProgress: { id: 'interview-1', round: 1, stage: 'initial', status: 'scheduled' } }])
    vi.mocked(updateResumeReview).mockRejectedValue(new ApiResponseError('已通过', { status: 409, code: 'APPLICATION_REVIEW_CLOSED' }))
    button('初试邀约')!.click(); await flush()
    expect(router.currentRoute.value.name).toBe('interview-detail')
    expect(router.currentRoute.value.params.id).toBe('interview-1')
  })
  it('navigates with the passed application id, without creating another application', async () => {
    const router = await mount()
    expect(button('安排面试')).toBeTruthy()
    button('安排面试')!.click(); await flush()
    expect(router.currentRoute.value.name).toBe('interviews')
    expect(router.currentRoute.value.query.applicationId).toBe('application-1')
  })
  it('uses the selected passed application when one candidate has multiple job applications', async () => {
    const newest = row('rejected')
    const older = { ...row(), applicationId: 'application-older', job: '后端工程师',
      resumeReview: { ...row().resumeReview!, resultId: 'result-older' } }
    newest.applicationRows = [{ ...newest }, older]
    const router = await mount(newest)
    root!.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await flush()
    button('安排面试')!.click(); await flush()
    expect(router.currentRoute.value.query.applicationId).toBe('application-older')
  })
  it.each(['rejected', 'offer'])('does not offer interview scheduling for %s', async (status) => {
    await mount(row(status))
    expect(button('安排面试')).toBeUndefined()
  })
  it('does not expose the write action to a viewer', async () => {
    await mount(row(), 'viewer')
    expect(button('安排面试')).toBeUndefined()
  })
  it.each([27, 88])('offers the next step after confirming screening with AI score %s', async (aiScore) => {
    const candidate = row('human_review')
    candidate.resumeReview = { ...candidate.resumeReview!, aiScore }
    const router = await mount(candidate)
    vi.mocked(updateResumeReview).mockImplementation(async () => {
      vi.mocked(loadCandidates).mockResolvedValue([{ ...candidate, rawApplicationStatus: 'interviewing', resumeReview: { ...candidate.resumeReview!, decision: 'passed' } }])
      return {} as never
    })
    root!.querySelector<HTMLButtonElement>('.basis-link')!.click(); await flush()
    root!.querySelector<HTMLButtonElement>('.pass-button')!.click(); await flush()
    button('确认')!.click(); await flush()
    expect(updateResumeReview).toHaveBeenCalledWith('result-1', expect.objectContaining({ decision: 'passed' }))
    expect(button('下一步：初试邀约')).toBeTruthy()
    button('下一步：初试邀约')!.click(); await flush()
    expect(router.currentRoute.value.query.applicationId).toBe('application-1')
    expect(root!.querySelector('.score-review-dialog')).toBeNull()
  })
})

describe('AI screening direct initial invitation', () => {
  it('opens scheduling without repeating approval when the list is stale but the application is already interviewing', async () => {
    const router = await mount(row('human_review'))
    vi.mocked(loadCandidates).mockResolvedValue([row()])
    button('初试邀约')!.click(); await flush()
    expect(updateResumeReview).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query).toEqual({ applicationId: 'application-1', stage: 'initial' })
  })
  it('checks the selected application within a group rather than another job for the same candidate', async () => {
    const selected = { ...row('human_review'), applicationId: 'application-older' }
    const newest = { ...row('rejected'), applicationRows: [row('rejected'), selected] }
    const router = await mount(newest)
    root!.querySelector<HTMLButtonElement>('.applications-toggle')!.click(); await flush()
    vi.mocked(loadCandidates).mockResolvedValue([{ ...newest, applicationRows: [row('rejected'), { ...selected, rawApplicationStatus: 'interviewing' }] }])
    button('初试邀约')!.click(); await flush()
    expect(updateResumeReview).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query.applicationId).toBe('application-older')
  })
  it.each(['rejected', 'offer', 'hired'])('does not approve or schedule a stale row whose current status is %s', async (status) => {
    const router = await mount(row('human_review'))
    vi.mocked(loadCandidates).mockResolvedValue([row(status)])
    button('初试邀约')!.click(); await flush()
    expect(updateResumeReview).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
    expect(root!.textContent).toContain('处于简历筛选阶段')
  })
  it('uses the latest analysis result when screening has been rerun since the list loaded', async () => {
    await mount(row('human_review'))
    const latest = row('human_review')
    latest.resumeReview = { ...latest.resumeReview!, resultId: 'result-new' }
    vi.mocked(loadCandidates).mockResolvedValue([latest])
    vi.mocked(updateResumeReview).mockResolvedValue({} as never)
    button('初试邀约')!.click(); await flush()
    expect(updateResumeReview).toHaveBeenCalledTimes(1)
    expect(updateResumeReview).toHaveBeenCalledWith('result-new', { decision: 'passed' })
  })
  it('recovers from a concurrent approval only after verifying the application is interviewing', async () => {
    const router = await mount(row('human_review'))
    vi.mocked(loadCandidates).mockResolvedValueOnce([row('human_review')]).mockResolvedValue([row()])
    vi.mocked(updateResumeReview).mockRejectedValue(new ApiResponseError('该申请已结束简历筛选，不能重复通过或淘汰', { status: 409, code: 'APPLICATION_REVIEW_CLOSED' }))
    button('初试邀约')!.click(); await flush()
    expect(updateResumeReview).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.query).toEqual({ applicationId: 'application-1', stage: 'initial' })
    expect(root!.textContent).not.toContain('不能重复通过或淘汰')
  })
  it('keeps a concurrent rejection closed rather than routing to scheduling', async () => {
    const router = await mount(row('human_review'))
    vi.mocked(loadCandidates).mockResolvedValueOnce([row('human_review')]).mockResolvedValue([row('rejected')])
    vi.mocked(updateResumeReview).mockRejectedValue(new ApiResponseError('该申请已结束简历筛选，不能重复通过或淘汰', { status: 409, code: 'APPLICATION_REVIEW_CLOSED' }))
    button('初试邀约')!.click(); await flush()
    expect(router.currentRoute.value.path).toBe('/')
    expect(root!.textContent).toContain('不能重复通过或淘汰')
  })
  it('stops before approval if refreshing the current application fails or it is no longer visible', async () => {
    const router = await mount(row('human_review'))
    vi.mocked(loadCandidates).mockRejectedValueOnce(new Error('无法读取最新状态'))
    button('初试邀约')!.click(); await flush()
    expect(root!.textContent).toContain('无法读取最新状态')
    vi.mocked(loadCandidates).mockResolvedValue([])
    button('初试邀约')!.click(); await flush()
    expect(root!.textContent).toContain('该岗位申请已不存在或无权访问')
    expect(updateResumeReview).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })
  it.each([80, 88])('allows AI score %s to enter initial scheduling without any human score', async (aiScore) => {
    const candidate = row('human_review')
    candidate.resumeReview = { ...candidate.resumeReview!, aiScore, humanScore: undefined, finalScore: undefined }
    const router = await mount(candidate)
    vi.mocked(updateResumeReview).mockResolvedValue({} as never)
    expect(button('人工评分')).toBeUndefined()
    expect(button('初试邀约')).toBeTruthy()
    expect(button('淘汰')?.disabled).toBe(false)
    button('初试邀约')!.click(); await flush()
    expect(updateResumeReview).toHaveBeenCalledWith('result-1', { decision: 'passed' })
    expect(router.currentRoute.value.query).toEqual({ applicationId: 'application-1', stage: 'initial' })
  })
  it.each([0, 79.99])('score %s keeps AI advice while allowing manual pass and initial invitation', async (aiScore) => {
    const candidate = row('human_review')
    candidate.resumeReview = { ...candidate.resumeReview!, aiScore, humanScore: 100, finalScore: 99 }
    const router = await mount(candidate)
    vi.mocked(updateResumeReview).mockResolvedValue({} as never)
    expect(root!.textContent).toContain('建议淘汰')
    expect(button('初试邀约')).toBeTruthy()
    expect(button('通过')?.disabled).toBe(false)
    expect(button('淘汰')?.disabled).toBe(false)
    button('初试邀约')!.click(); await flush()
    expect(updateResumeReview).toHaveBeenCalledWith('result-1', { decision: 'passed' })
    expect(router.currentRoute.value.query).toEqual({ applicationId: 'application-1', stage: 'initial' })
  })
  it('does not route to scheduling if the server rejects screening', async () => {
    const router = await mount(row('human_review'))
    vi.mocked(updateResumeReview).mockRejectedValue(new Error('AI 分数已失效'))
    button('初试邀约')!.click(); await flush()
    expect(router.currentRoute.value.path).toBe('/')
    expect(root!.textContent).toContain('AI 分数已失效')
  })
})
