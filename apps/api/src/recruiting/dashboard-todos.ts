import type { RecruitingStoreState, InterviewRecord } from './types.js'
import type { DashboardInterviewReview } from '../interviews/question-sheet-repository.js'
import { STAGE_SHEET_TYPES, SHEET_TYPE_LABEL } from '../interviews/question-sheet-service.js'
import { latestAnalysisByKey } from './latest-analysis.js'

export interface DashboardTodo {
  id: string
  category: 'requisition' | 'job' | 'resume' | 'interview' | 'offer' | 'onboarding'
  title: string
  description: string
  actionLabel: string
  path: string
  updatedAt: string
}

export function buildDashboardTodos(state: RecruitingStoreState, reviews: DashboardInterviewReview[] = []): DashboardTodo[] {
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
  const add = (id: string, category: DashboardTodo['category'], title: string, description: string, actionLabel: string, path: string, updatedAt: string) => {
    todos.push({ id, category, title, description, actionLabel, path, updatedAt })
  }

  const requestActions: Record<string, string> = { draft: '提交需求审批', pending_approval: '审批招聘需求', approved: '需求转为岗位' }
  for (const row of state.recruitmentRequests) {
    if (row.status === 'approved' && (row.convertedJobIds.length || state.jobs.some(job => job.recruitmentRequestId === row.id))) continue
    const action = requestActions[row.status]
    if (action) add(`request-${row.id}`, 'requisition', action, row.title, '去处理', `/requisitions/${row.id}`, row.updatedAt)
  }
  for (const row of state.jobs) {
    if (row.status !== 'draft' && row.status !== 'ready') continue
    const action = !row.spec?.confirmed ? '待确认岗位说明书' : !row.jd?.confirmed ? '待确认岗位 JD' : '岗位待发布'
    add(`job-${row.id}`, 'job', action, row.title, '去处理', `/jobs/${row.id}`, row.updatedAt)
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
    const feedback = state.interviewFeedback.filter(item => item.interviewId === row.id)
    const missingRequired = row.participants.some(person => person.required && person.role === 'interviewer' && !feedback.some(item => item.interviewerId === person.userId && item.status === 'locked'))
    if (!feedback.length || feedback.some(item => item.status !== 'locked') || missingRequired) {
      add(`feedback-${row.id}`, 'interview', '面试反馈待完成', `${context(row.applicationId)} · 第 ${row.round} 轮`, '去反馈', `/interviews/${row.id}`, row.updatedAt)
    } else if (row.status === 'scheduled') {
      add(`conclude-${row.id}`, 'interview', '面试待确认完成', context(row.applicationId), '去确认', `/interviews/${row.id}`, row.updatedAt)
    }
  }
  for (const row of latestInterviews.values()) {
    const review = reviewsByInterview.get(row.id)
    if (!review || (!completedLiveStages.has(`${row.applicationId}:${review.stage}`) && !review.sheets.length)) continue
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

  const offerActions: Record<string, string> = { draft: 'Offer 待提交', pending_approval: 'Offer 待审批', approved: 'Offer 待发送', sent: 'Offer 待确认接受结果' }
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
