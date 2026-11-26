import type { RecruitingStoreState, InterviewRecord } from './types.js'
import type { DashboardInterviewReview } from '../interviews/question-sheet-repository.js'
import { STAGE_SHEET_TYPES, SHEET_TYPE_LABEL } from '../interviews/question-sheet-service.js'
import { latestAnalysisByKey } from './latest-analysis.js'

export interface DashboardTodo {
  id: string
  ownerUserIds?: string[]
  unassigned?: boolean
  dueAt?: string
  category: 'requisition' | 'job' | 'resume' | 'interview' | 'offer' | 'onboarding' | 'membership'
  actionKey?: 'confirm-job-spec' | 'confirm-job-jd' | 'publish-job'
  title: string
  description: string
  actionLabel: string
  path: string
  updatedAt: string
}

export function buildDashboardTodos(state: RecruitingStoreState, reviews: DashboardInterviewReview[] = [], viewer?: { userId: string; scope?: 'mine' | 'enterprise' | 'unassigned' }, ownership?: { activeUserIds: string[]; fallbackUserId?: string | undefined }): DashboardTodo[] {
  const todos: DashboardTodo[] = []
  const applications = new Map(state.applications.map(row => [row.id, row]))
  const candidates = new Map(state.candidates.map(row => [row.id, row]))
  const jobs = new Map(state.jobs.map(row => [row.id, row]))
  const terminal = new Set(['rejected', 'offer_declined', 'offer_cancelled', 'offer_expired', 'onboarding_archived'])
  const active = (id: string) => { const app = applications.get(id); return !!app && !terminal.has(app.status) }
  const context = (id: string) => {
    const app = applications.get(id)
    return `${candidates.get(app?.candidateId ?? '')?.fullName ?? '未知候选人'} · ${jobs.get(app?.jobId ?? '')?.title ?? '未知岗位'}`
  }
  const candidatePath = (id: string) => `/candidates/${applications.get(id)?.candidateId ?? ''}?applicationId=${encodeURIComponent(id)}`
  const creator = (subjectId: string) => state.workflowEvents.find(event => event.subjectId === subjectId && ['create', 'upload'].includes(event.action))?.actorId
  const businessOwner = (id: string): string[] => {
    const app = state.applications.find(row => id.endsWith(row.id))
      ?? state.applications.find(row => state.offers.some(offer => id.endsWith(offer.id) && offer.applicationId === row.id) || state.onboarding.some(item => id.endsWith(item.id) && item.applicationId === row.id))
      ?? state.applications.find(row => state.analysisTasks.some(task => id.endsWith(task.id) && task.applicationId === row.id))
    const request = state.recruitmentRequests.find(row => id.endsWith(row.id))
    const job = state.jobs.find(row => id.endsWith(row.id))
    const resourceId = request?.id ?? job?.id ?? app?.id ?? id.replace(/^[^-]+-/, '')
    const owner = request?.requesterId ?? app?.recruiterId ?? job?.hiringManagerId ?? creator(resourceId)
    return owner ? [owner] : []
  }
  const add = (id: string, category: DashboardTodo['category'], title: string, description: string, actionLabel: string, path: string, updatedAt: string, actionKey?: DashboardTodo['actionKey'], owners?: string[], dueAt?: string) => {
    const originalOwners = owners ?? businessOwner(id)
    const ownerUserIds = [...new Set(originalOwners.flatMap(owner => !ownership || ownership.activeUserIds.includes(owner) ? [owner] : ownership.fallbackUserId ? [ownership.fallbackUserId] : []))]
    if (viewer?.scope === 'unassigned' ? ownerUserIds.length > 0 : viewer && viewer.scope !== 'enterprise' && !ownerUserIds.includes(viewer.userId)) return
    todos.push({ id, category, ...(actionKey ? { actionKey } : {}), title, description, actionLabel, path, updatedAt,
      ownerUserIds, unassigned: !ownerUserIds.length, ...(dueAt ? { dueAt } : {}) })
  }

  const requestActions: Record<string, string> = { draft: '提交需求审批', pending_approval: '审批招聘需求', approved: '需求转为岗位' }
  for (const row of state.recruitmentRequests) {
    if (row.status === 'approved' && (row.convertedJobIds.length || state.jobs.some(job => job.recruitmentRequestId === row.id))) continue
    const action = requestActions[row.status]
    if (action) add(`request-${row.id}`, 'requisition', action, row.title, '去处理', `/requisitions/${row.id}`, row.updatedAt)
  }
  for (const row of state.jobs) {
    if (row.status !== 'draft' && row.status !== 'ready') continue
    const needsSpec = !row.spec?.confirmed
    const needsJd = !needsSpec && !row.jd?.confirmed
    const action = needsSpec ? '待确认岗位说明书' : needsJd ? '待确认岗位 JD' : '岗位待发布'
    const actionKey = needsSpec ? 'confirm-job-spec' : needsJd ? 'confirm-job-jd' : 'publish-job'
    add(`job-${row.id}`, 'job', action, row.title, '去处理', `/jobs/${row.id}`, row.updatedAt, actionKey)
  }

  const latestTasks = latestAnalysisByKey(state.analysisTasks, row => `${row.applicationId ?? ''}:${row.resumeId}`)
  for (const row of latestTasks.values()) {
    if (row.status !== 'failed' || (row.applicationId && !active(row.applicationId))) continue
    const resume = state.resumes.find(item => item.id === row.resumeId)
    if (!resume) continue
    add(`analysis-${row.id}`, 'resume', '简历分析失败待重试', row.applicationId ? context(row.applicationId) : resume.originalFilename,
      '查看简历', row.applicationId ? candidatePath(row.applicationId) : `/candidates/${resume.candidateId}`, row.createdAt)
  }
  for (const row of state.applications) {
    if (!active(row.id)) continue
    if (row.status === 'human_review') add(`review-${row.id}`, 'resume', '简历待人工审核', context(row.id), '去审核', candidatePath(row.id), row.updatedAt)
    if (row.status === 'pending_analysis' && ![...latestTasks.values()].some(task => task.applicationId === row.id)) {
      add(`resume-${row.id}`, 'resume', '简历待上传或分析', context(row.id), '去处理', candidatePath(row.id), row.updatedAt)
    }
    if (row.status === 'interviewing' && !state.interviews.some(item => item.applicationId === row.id && item.status !== 'cancelled')) {
      add(`schedule-${row.id}`, 'interview', '待安排初试', context(row.id), '去安排', `/interviews?applicationId=${row.id}&stage=initial`, row.updatedAt)
    }
    if (row.status === 'offer_approval' && !state.offers.some(item => item.applicationId === row.id && !['cancelled', 'expired', 'declined'].includes(item.status))) {
      add(`create-offer-${row.id}`, 'offer', '待创建 Offer', context(row.id), '去处理', '/offers', row.updatedAt)
    }
    if (row.status === 'offer_accepted' && !state.onboarding.some(item => item.applicationId === row.id && item.status !== 'cancelled')) {
      add(`create-onboarding-${row.id}`, 'onboarding', '待发起入职', context(row.id), '去处理', '/onboarding', row.updatedAt)
    }
  }

  const latestInterviews = new Map<string, InterviewRecord>()
  const reviewsByInterview = new Map(reviews.map(row => [row.interviewId, row]))
  const completedLiveStages = new Set<string>()
  for (const row of state.interviews) {
    if (row.status === 'cancelled' || !active(row.applicationId)) continue
    const stage = row.stage ?? (row.round >= 2 ? 'final' : 'initial')
    const key = `${row.applicationId}:${stage}`
    if (reviewsByInterview.get(row.id)?.hasCompletedLive) completedLiveStages.add(key)
    const previous = latestInterviews.get(key)
    if (!previous || row.round > previous.round || (row.round === previous.round && row.createdAt > previous.createdAt)) latestInterviews.set(key, row)
    if (row.status === 'scheduled' && row.scheduledStartAt) {
      add(`complete-${row.id}`, 'interview', viewer && viewer.scope !== 'enterprise' && !row.participants.some(person => person.userId === viewer.userId && person.lead) ? '待参加面试' : '面试待完成', `${context(row.applicationId)} · 第 ${row.round} 轮`, '查看安排', `/interviews/${row.id}`, row.updatedAt, undefined, row.participants.filter(person => person.role === 'interviewer').map(person => person.userId), row.scheduledStartAt)
    }
  }
  for (const row of latestInterviews.values()) {
    const review = reviewsByInterview.get(row.id)
    if (!review || (row.status !== 'completed' && !completedLiveStages.has(`${row.applicationId}:${review.stage}`) && !review.sheets.length)) continue
    if (viewer) {
      const leadIds = row.participants.filter(person => person.role === 'interviewer' && person.lead).map(person => person.userId)
      for (const type of STAGE_SHEET_TYPES[review.stage]) {
        const sheet = review.sheets.find(item => item.sheetType === type)
        if (sheet?.status === 'locked') continue
        const locking = sheet?.status === 'submitted'
        const owners = locking ? leadIds : row.participants.filter(person => person.role === 'interviewer' && person.sheetTypes?.includes(type)).map(person => person.userId)
        const action = !sheet?.totalQuestions ? '待载入' : locking ? '待锁定' : sheet.scoredQuestions < sheet.totalQuestions ? '待评分' : '待提交'
        add(`sheet-${row.id}-${type}-${locking ? 'lock' : 'score'}`, 'interview', SHEET_TYPE_LABEL[type] + action,
          context(row.applicationId), locking ? '去确认' : '去评分', `/interviews/${row.id}?openQuestionSheet=1&sheetType=${type}`, row.updatedAt, undefined, owners)
      }
      const sheetsDone = STAGE_SHEET_TYPES[review.stage].every(type => review.sheets.some(sheet => sheet.sheetType === type && sheet.status === 'locked'))
      if (sheetsDone && (!review.decision || review.decision === 'hold')) {
        add(`decision-${row.id}`, 'interview', '面试综合评估待确认', context(row.applicationId), '去确认', `/interviews/${row.id}?openQuestionSheet=1`, row.updatedAt, undefined, leadIds)
      }
      if (sheetsDone && review.stage === 'initial' && review.decision === 'advanced' && applications.get(row.applicationId)?.status === 'interviewing' && !latestInterviews.has(`${row.applicationId}:final`)) {
        const recruiter = applications.get(row.applicationId)?.recruiterId
        add(`final-${row.applicationId}`, 'interview', '待安排复试', context(row.applicationId), '去安排', `/interviews?applicationId=${row.applicationId}&stage=final`, row.updatedAt, undefined, recruiter ? [recruiter] : leadIds)
      }
      continue
    }
    const pendingSheets = STAGE_SHEET_TYPES[review.stage].flatMap(type => {
      const sheet = review.sheets.find(item => item.sheetType === type)
      const label = SHEET_TYPE_LABEL[type]
      if (!sheet || !sheet.totalQuestions) return [`${label}待生成`]
      if (sheet.scoredQuestions < sheet.totalQuestions) return [`${label}待评分 ${sheet.totalQuestions - sheet.scoredQuestions} 题`]
      if (sheet.status === 'locked') return []
      return [`${label}${sheet.status === 'submitted' ? '待锁定' : '待提交'}`]
    })
    const stageLabel = review.stage === 'initial' ? '初试' : '复试'
    if (pendingSheets.length || !review.decision || review.decision === 'hold') {
      add(`sheets-${row.applicationId}-${review.stage}`, 'interview', `${stageLabel}面试表待处理`,
        `${context(row.applicationId)} · ${pendingSheets.length ? pendingSheets.join('；') : '综合评估待决策'}`,
        '去评分', `/interviews/${row.id}?openQuestionSheet=1`, row.updatedAt)
    } else if (review.stage === 'initial' && review.decision === 'advanced' && applications.get(row.applicationId)?.status === 'interviewing' && !latestInterviews.has(`${row.applicationId}:final`)) {
      add(`final-${row.applicationId}`, 'interview', '待安排复试', context(row.applicationId), '去安排', `/interviews?applicationId=${row.applicationId}&stage=final`, row.updatedAt)
    }
  }

  // Historical approval statuses remain readable, but all unsent offers now use the direct-send flow.
  const offerActions: Record<string, string> = { draft: 'Offer 待发送', pending_approval: 'Offer 待发送', approved: 'Offer 待发送', sent: 'Offer 待确认接受结果' }
  for (const row of state.offers) {
    const action = offerActions[row.status]
    if (action && active(row.applicationId)) add(`offer-${row.id}`, 'offer', action, context(row.applicationId), '去处理', `/offers/${row.id}`, row.updatedAt)
  }
  for (const row of state.onboarding) {
    if (!active(row.applicationId) || (row.status !== 'pending' && row.status !== 'scheduled')) continue
    add(`onboarding-${row.id}`, 'onboarding', row.status === 'pending' ? '入职待安排' : '入职待确认归档', context(row.applicationId), '去处理', '/onboarding', row.updatedAt)
  }
  return todos.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
}
