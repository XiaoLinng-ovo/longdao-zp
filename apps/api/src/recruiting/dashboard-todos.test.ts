import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDashboardTodos } from './dashboard-todos.js'
import { createSeedState } from './store.js'
import type { InterviewRecord } from './types.js'
import type { DashboardInterviewReview } from '../interviews/question-sheet-repository.js'

const time = '2026-10-01T00:00:00Z'
function fixture() {
  const state = createSeedState()
  const interview: InterviewRecord = { id: 'interview-1', code: 'IV-1', applicationId: 'application-8814', round: 1,
    stage: 'initial', type: 'technical', title: '初试', status: 'completed', participants: [], createdAt: time, updatedAt: time }
  state.interviews.push(interview)
  const review: DashboardInterviewReview = { interviewId: interview.id, stage: 'initial', hasCompletedLive: true, decision: null, sheets: [] }
  return { state, interview, review }
}
function lockedSheets(stage: 'initial' | 'final'): DashboardInterviewReview['sheets'] {
  const types = stage === 'initial' ? ['hr_screen', 'hiring_department'] as const : ['business', 'hr', 'boss'] as const
  return types.map(sheetType => ({ sheetType, status: 'locked', totalQuestions: 2, scoredQuestions: 2 }))
}
const sheetTodos = (state: ReturnType<typeof createSeedState>, reviews: DashboardInterviewReview[]) => buildDashboardTodos(state, reviews).filter(row => row.id.startsWith('sheets-'))

describe('dashboard personal todo ownership', () => {
  it('routes disabled and departed assignees to an active enterprise administrator', () => {
    const {state,interview,review}=fixture()
    interview.participants=[{userId:'departed',role:'interviewer',required:true,lead:true,sheetTypes:['hr_screen','hiring_department']}]
    const ownership={activeUserIds:['admin','other'],fallbackUserId:'admin'}
    const mine=(userId:string)=>buildDashboardTodos(state,[review],{userId},ownership).filter(row=>row.id.startsWith('sheet-'))
    assert.equal(mine('admin').length,2)
    assert.equal(mine('other').length,0)
    assert.equal(mine('departed').length,0)
  })
  it('shows each scorer only their sheet and never broadcasts to unrelated members', () => {
    const {state,interview,review} = fixture()
    interview.participants = [{userId:'a',role:'interviewer',required:true,lead:true,sheetTypes:['hr_screen']},{userId:'b',role:'interviewer',required:true,lead:false,sheetTypes:['hiring_department']}]
    const mine = (userId: string) => buildDashboardTodos(state,[review],{userId}).filter(row => row.id.startsWith('sheet-'))
    assert.deepEqual(mine('a').map(row => row.id),['sheet-interview-1-hr_screen-score'])
    assert.deepEqual(mine('b').map(row => row.id),['sheet-interview-1-hiring_department-score'])
    assert.deepEqual(mine('c'),[])
    review.sheets = [{sheetType:'hiring_department',status:'submitted',totalQuestions:2,scoredQuestions:2}]
    assert.deepEqual(mine('b'),[])
    assert.ok(mine('a').some(row => row.id === 'sheet-interview-1-hiring_department-lock'))
    review.sheets = lockedSheets('initial')
    assert.ok(buildDashboardTodos(state,[review],{userId:'a'}).some(row => row.id === 'decision-interview-1'))
    assert.ok(!buildDashboardTodos(state,[review],{userId:'b'}).some(row => row.id === 'decision-interview-1'))
    review.decision = 'rejected'; assert.equal(mine('a').length,0)
  })
  it('includes assigned offline completed interview scoring even without live recordings', () => {
    const {state,interview,review} = fixture(); review.hasCompletedLive=false
    interview.participants=[{userId:'a',role:'interviewer',required:true,lead:true,sheetTypes:['hr_screen','hiring_department']}]
    assert.equal(buildDashboardTodos(state,[review],{userId:'a'}).filter(row=>row.id.startsWith('sheet-')).length,2)
  })
  it('keeps historical unassigned work separate from personal work', () => {
    const {state,review} = fixture()
    const relevant = (scope: 'mine'|'enterprise'|'unassigned') => buildDashboardTodos(state,[review],{userId:'admin',scope}).filter(row => row.id.startsWith('sheet-'))
    assert.equal(relevant('mine').length,0); assert.equal(relevant('enterprise').length,2)
    assert.equal(relevant('unassigned').length,2); assert.ok(relevant('unassigned').every(row => row.unassigned))
  })
  it('removes cancelled interviews from all scopes', () => {
    const {state,interview,review} = fixture(); interview.status = 'cancelled'
    assert.equal(buildDashboardTodos(state,[review],{userId:'a',scope:'enterprise'}).filter(row => row.id.startsWith('sheet-')).length,0)
  })
})

describe('dashboard actionable todos', () => {
  it('includes completed online interviews even before question sheets exist', () => {
    const { state, review } = fixture()
    const todos = sheetTodos(state, [review])
    assert.equal(todos.length, 1)
    assert.match(todos[0]!.description, /人事面试表待生成.*用人部门面试表待生成/)
    assert.equal(todos[0]!.path, '/interviews/interview-1?openQuestionSheet=1')
  })
  it('keeps missing human scores visible independently of locked interview feedback', () => {
    const { state, review } = fixture()
    state.interviewFeedback.push({ id: 'f', interviewId: 'interview-1', interviewerId: 'hr', status: 'locked', ratings: {}, strengths: [], concerns: [] })
    review.sheets = lockedSheets('initial')
    review.sheets[0] = { sheetType: 'hr_screen', status: 'scoring', totalQuestions: 5, scoredQuestions: 1 }
    const todos = buildDashboardTodos(state, [review])
    assert.ok(!todos.some(row => row.id === 'feedback-interview-1'))
    assert.match(todos.find(row => row.id.startsWith('sheets-'))!.description, /待评分 4 题/)
  })
  it('tracks submission, locking and decisions until fully handled', () => {
    const { state, review } = fixture()
    review.sheets = lockedSheets('initial')
    review.sheets[0]!.status = 'scoring'
    assert.match(sheetTodos(state, [review])[0]!.description, /待提交/)
    review.sheets[0]!.status = 'submitted'
    assert.match(sheetTodos(state, [review])[0]!.description, /待锁定/)
    review.sheets[0]!.status = 'locked'
    assert.match(sheetTodos(state, [review])[0]!.description, /综合评估待决策/)
    review.decision = 'hold'
    assert.equal(sheetTodos(state, [review]).length, 1)
    review.decision = 'advanced'
    assert.equal(sheetTodos(state, [review]).length, 0)
    assert.ok(buildDashboardTodos(state, [review]).some(row => row.id === 'final-application-8814'))
  })
  it('uses all three final review sheets and removes handled or cancelled applications', () => {
    const { state, interview, review } = fixture()
    interview.stage = 'final'; review.stage = 'final'
    assert.match(sheetTodos(state, [review])[0]!.description, /业务面试表待生成.*HR 面试表待生成.*BOSS 面试表待生成/)
    review.sheets = lockedSheets('final'); review.decision = 'hired'
    assert.equal(sheetTodos(state, [review]).length, 0)
    review.decision = null; interview.status = 'cancelled'
    assert.equal(sheetTodos(state, [review]).length, 0)
    interview.status = 'completed'; state.applications.find(row => row.id === interview.applicationId)!.status = 'rejected'
    assert.equal(buildDashboardTodos(state, [review]).filter(row => row.category === 'interview').length, 0)
  })
  it('does not duplicate stage sheets for repeated interviews or misclassify repeated initial rounds', () => {
    const { state, interview, review } = fixture()
    state.interviews.push({ ...interview, id: 'newer', round: 2 })
    const todos = sheetTodos(state, [review, { ...review, interviewId: 'newer' }])
    assert.equal(todos.length, 1)
    assert.equal(todos[0]!.path, '/interviews/newer?openQuestionSheet=1')
    assert.equal(todos[0]!.title, '初试面试表待处理')
  })
  it('keeps outstanding online scoring when a newer interview is scheduled in the same stage', () => {
    const { state, interview, review } = fixture()
    state.interviews.push({ ...interview, id: 'newer', round: 2, status: 'scheduled' })
    const newerReview = { ...review, interviewId: 'newer', hasCompletedLive: false }
    const todos = sheetTodos(state, [review, newerReview])
    assert.equal(todos.length, 1)
    assert.match(todos[0]!.description, /人事面试表待生成/)
    assert.equal(todos[0]!.path, '/interviews/newer?openQuestionSheet=1')
    interview.status = 'cancelled'
    assert.equal(sheetTodos(state, [review, newerReview]).length, 0)
  })
  it('creates one completion todo only for scheduled interviews with a start time', () => {
    const { state, interview } = fixture()
    interview.status = 'scheduled'
    interview.scheduledStartAt = '2026-10-02T00:00:00Z'
    let todos = buildDashboardTodos(state)
    const completion = todos.filter(row => row.id.startsWith('complete-'))
    assert.deepEqual(completion.map(row => row.id), ['complete-interview-1'])
    assert.equal(completion[0]!.title, '面试待完成')
    assert.equal(completion[0]!.actionLabel, '查看安排')
    assert.equal(completion[0]!.path, '/interviews/interview-1')
    assert.ok(!todos.some(row => row.id.startsWith('feedback-') || row.id.startsWith('conclude-')))

    interview.status = 'completed'
    todos = buildDashboardTodos(state)
    assert.ok(!todos.some(row => row.id === 'complete-interview-1'))

    const withoutStart = { ...interview, status: 'scheduled' as const }
    delete withoutStart.scheduledStartAt
    state.interviews = state.interviews.map(row => row.id === interview.id ? withoutStart : row)
    todos = buildDashboardTodos(state)
    assert.ok(!todos.some(row => row.id === 'complete-interview-1'))

    const cancelled = { ...interview, status: 'cancelled' as const, scheduledStartAt: '2026-10-02T00:00:00Z' }
    state.interviews = state.interviews.map(row => row.id === interview.id ? cancelled : row)
    todos = buildDashboardTodos(state)
    assert.ok(!todos.some(row => row.id === 'complete-interview-1'))
  })
  it('excludes converted requests using either stored conversion IDs or linked jobs', () => {
    const state = createSeedState()
    assert.ok(!buildDashboardTodos(state).some(row => row.id === 'request-rr-24018'))
    state.recruitmentRequests[0]!.convertedJobIds = []
    assert.ok(!buildDashboardTodos(state).some(row => row.id === 'request-rr-24018'))
    state.jobs[0]!.recruitmentRequestId = ''
    assert.ok(buildDashboardTodos(state).some(row => row.id === 'request-rr-24018'))
  })
  it('covers outstanding jobs, resumes, scheduling, offers and onboarding', () => {
    const state = createSeedState()
    state.applications[0]!.status = 'offer_accepted'
    state.offers.push({ id: 'offer', code: 'OFF-1', applicationId: 'application-8814', status: 'pending_approval', approval: { status: 'pending', approver: '' }, version: 1, createdAt: time, updatedAt: time })
    state.onboarding.push({ id: 'onboard', applicationId: 'application-8821', offerId: 'accepted-offer', status: 'scheduled', createdAt: time, updatedAt: time })
    assert.deepEqual([...new Set(buildDashboardTodos(state).map(row => row.category))].sort(), ['interview', 'job', 'offer', 'onboarding', 'requisition', 'resume'])
    assert.equal(buildDashboardTodos(state).find(row => row.id === 'offer-offer')?.title, 'Offer 待发送')
    assert.ok(buildDashboardTodos(state).some(row => row.id === 'schedule-application-8814'))
    state.applications[1]!.status = 'offer_approval'; state.offers = []
    assert.ok(buildDashboardTodos(state).some(row => row.id === 'create-offer-application-8814'))
    state.onboarding = []
    assert.ok(buildDashboardTodos(state).some(row => row.id === 'create-onboarding-application-8821'))
  })
  it('omits obsolete failed analyses after a successful retry', () => {
    const state = createSeedState()
    state.resumes.push({ id: 'r', candidateId: 'candidate-8802', applicationId: 'application-8802', storageKey: 'r', originalFilename: 'r.txt', mimeType: 'text/plain', sizeBytes: 1, contentHash: 'hash', scanStatus: 'clean', createdAt: time })
    state.analysisTasks.push({ id: 'failed', resumeId: 'r', applicationId: 'application-8802', status: 'failed', attempts: 1, idempotencyKey: 'old', availableAt: time, createdAt: time })
    assert.ok(buildDashboardTodos(state).some(row => row.id === 'analysis-failed'))
    state.analysisTasks.push({ ...state.analysisTasks[0]!, id: 'success', status: 'completed', createdAt: '2026-10-02T00:00:00Z' })
    assert.ok(!buildDashboardTodos(state).some(row => row.id === 'analysis-failed'))
  })
})
