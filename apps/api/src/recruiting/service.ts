import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalRecruitingStore } from './store.js'
import { createRecruitingStore } from './postgres-store.js'
import { createNormalizedRecruitingRepository, type NormalizedRecruitingRepository } from './repositories/postgres-repository.js'
import type { AnalysisTaskRecord as RepositoryAnalysisTask, AnalysisResultRecord as RepositoryAnalysisResult, JobRecord as RepositoryJob, InterviewDbRecord as RepositoryInterview, InterviewFeedbackDbRecord as RepositoryInterviewFeedback, OfferDbRecord as RepositoryOffer, OnboardingDbRecord as RepositoryOnboarding } from './repositories/types.js'
import type { AnalysisResultRecord, AnalysisTaskRecord, ApplicationRecord, ApprovalAuditRecord, ApprovalInstanceRecord, ApprovalRecord, ApprovalStepRecord, CandidateRecord, JobDescriptionRecord, JobDescriptionVersionRecord, JobRecord, JobSpecRecord, JobSpecVersionRecord, RecruitingStoreState, RecruitmentRequestRecord, ResumeRecord, WorkflowEventRecord, InterviewRecord, InterviewFeedbackRecord, InterviewType, OfferRecord, OfferVersionRecord, OnboardingRecord, InterviewParticipant } from './types.js'
import { RecruitingWorkflowError, transitionJob, transitionRequest } from './workflow.js'

const resumeIntelligenceDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/resume-intelligence/dist/index.js')
const { buildRuleBasedReport } = createRequire(import.meta.url)(resumeIntelligenceDist) as { buildRuleBasedReport: typeof import('../../../../packages/resume-intelligence/dist/index.js').buildRuleBasedReport }

type RuleReportBuilder = (input: { resume: { documentId: string; fileName: string; mimeType: string; text: string; source: 'upload' }; job: ReturnType<typeof buildJobRequirements>; subject: { resumeId: string; applicationId?: string; jobId?: string } }) => Record<string, unknown>

type CreateRecruitmentRequestInput = {
  title: string; departmentId: string; hiringManagerId?: string; headcount: number; employmentType: string; workMode: string; location?: string;
  salaryRange?: { min?: { amount: number; currency: string }; max?: { amount: number; currency: string } }; justification: string
}
type UpdateRecruitmentRequestInput = Partial<CreateRecruitmentRequestInput>
type CreateJobInput = { title: string; departmentId: string; hiringManagerId?: string; recruitmentRequestId: string; headcount: number; employmentType: string; workMode: string; location?: string }
type UpdateJobInput = Partial<Omit<CreateJobInput, 'recruitmentRequestId'>>
type CreateJobSpecInput = { title: string; summary: string; responsibilities: string[]; requirements: Array<{ label: string; description: string; required: boolean; weight?: number }>; skills: string[] }
type CreateCandidateInput = { fullName: string; email?: string; phone?: string; source?: string; tags?: string[] }
type UpdateCandidateInput = Partial<Omit<CreateCandidateInput, 'fullName'>> & { fullName?: string; status?: CandidateRecord['status']; reason?: string }
type CreateApplicationInput = { candidateId: string; jobId: string; source?: string }
type CreateResumeInput = { candidateId: string; applicationId?: string; originalFilename: string; mimeType?: string; content: string; encoding?: 'utf8' | 'base64' }
type CreateInterviewInput = { applicationId: string; round?: number; type?: InterviewType; title: string; scheduledStartAt?: string; scheduledEndAt?: string; timezone?: string; location?: string; meetingUrl?: string; participants: Array<{ userId: string; name?: string; role?: 'interviewer' | 'coordinator' | 'observer'; required?: boolean }> }
type FeedbackInput = { interviewerId: string; overallScore?: number; recommendation?: InterviewFeedbackRecord['recommendation']; ratings?: Record<string, number>; strengths?: string[]; concerns?: string[]; notes?: string }
type CreateOfferInput = { applicationId: string; positionTitle: string; departmentId: string; employmentType: string; startDate?: string; baseSalary: { amount: number; currency: string }; bonus?: { amount: number; currency: string }; equity?: string; benefits?: string[]; content: string; expiresAt?: string }
export interface RecruitingReport { generatedAt: string; summary: Array<{ label: string; value: number; detail: string }>; funnel: Array<{ stage: string; count: number; conversionRate: number | null }>; statusStats: Array<{ entity: string; status: string; count: number }>; jobFilling: Array<{ jobId: string; code: string; title: string; headcount: number; filledCount: number; openCount: number; fillRate: number }>; channels: Array<{ channel: string; applications: number; screened: number; interviewed: number; offers: number; hired: number; conversionRate: number }>; recruitmentCycle: { averageDaysToHire: number | null; medianDaysToHire: number | null; hiredCount: number }; feedbackCompletion: { expected: number; locked: number; completionRate: number | null }; offerAcceptance: { sent: number; accepted: number; acceptanceRate: number | null } }
export interface DashboardSummary {
  generatedAt: string
  metrics: Array<{ label: string; value: number; detail: string }>
  funnel: Array<{ stage: string; count: number; conversionRate: number | null }>
  pendingApprovals: RecruitmentRequestRecord[]
  pendingFeedback: Array<InterviewRecord & { feedbackStatus: InterviewFeedbackRecord['status'] | 'pending'; application: ApplicationRecord; candidateName: string; jobTitle: string }>
  failedTasks: AnalysisTaskRecord[]
}

export class RecruitingNotFoundError extends RecruitingWorkflowError {
  constructor(message: string) { super('NOT_FOUND', message, 404) }
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function required(value: unknown, field: string): string {
  const result = clean(value)
  if (!result) throw new RecruitingWorkflowError('VALIDATION_ERROR', `${field} 不能为空`, 400)
  return result
}
function normalizeTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '候选人标签必须是字符串数组', 400)
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const tag = clean(item)
    if (!tag) continue
    if (seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result.length ? result : undefined
}


function positiveInteger(value: unknown, field: string): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1) throw new RecruitingWorkflowError('VALIDATION_ERROR', `${field} 必须是大于 0 的整数`, 400)
  return result
}

function addEvent(state: RecruitingStoreState, event: Omit<WorkflowEventRecord, 'id' | 'createdAt'>): void {
  state.workflowEvents.push({ ...event, id: randomUUID(), createdAt: LocalRecruitingStore.timestamp() })
}

function approvalInstanceOrThrow(state: RecruitingStoreState, id: string): ApprovalInstanceRecord {
  const instance = state.approvalInstances.find((item) => item.id === id)
  if (!instance) throw new RecruitingNotFoundError(`未找到审批实例：${id}`)
  return instance
}

function createApprovalInstance(state: RecruitingStoreState, entityId: string, actorId: string): ApprovalInstanceRecord {
  const timestamp = LocalRecruitingStore.timestamp()
  const version = state.approvalInstances.filter((item) => item.entityType === 'recruitment_request' && item.entityId === entityId).reduce((max, item) => Math.max(max, item.version), 0) + 1
  const instance: ApprovalInstanceRecord = { id: randomUUID(), entityType: 'recruitment_request', entityId, version, status: 'pending', createdAt: timestamp, updatedAt: timestamp }
  state.approvalInstances.push(instance)
  const steps: ApprovalStepRecord[] = [
    { id: randomUUID(), instanceId: instance.id, order: 1, name: '招聘需求审批', approverRole: 'approver', status: 'pending' }
  ]
  state.approvalSteps.push(...steps)
  addEvent(state, { subjectType: 'recruitment_request', subjectId: entityId, action: 'approval_instance_created', actorId })
  return instance
}

function currentPendingStep(state: RecruitingStoreState, instanceId: string): ApprovalStepRecord | undefined {
  return state.approvalSteps.find((item) => item.instanceId === instanceId && item.status === 'pending')
}

function recordApproval(state: RecruitingStoreState, instance: ApprovalInstanceRecord, step: ApprovalStepRecord, action: 'approve' | 'reject', actorId: string, reason?: string): ApprovalRecord {
  const timestamp = LocalRecruitingStore.timestamp()
  step.status = action === 'approve' ? 'approved' : 'rejected'
  step.actedAt = timestamp
  const record: ApprovalRecord = { status: action === 'approve' ? 'approved' : 'rejected', approver: actorId, ...(reason ? { comment: reason } : {}), actedAt: timestamp }
  const audit: ApprovalAuditRecord = { id: randomUUID(), instanceId: instance.id, stepId: step.id, actorId, action, ...(reason ? { comment: reason } : {}), createdAt: timestamp }
  state.approvalRecords.push(audit)
  instance.updatedAt = timestamp
  return record
}

function requestOrThrow(state: RecruitingStoreState, id: string): RecruitmentRequestRecord {
  const request = state.recruitmentRequests.find((item) => item.id === id)
  if (!request) throw new RecruitingNotFoundError(`未找到招聘需求：${id}`)
  return request
}

function jobOrThrow(state: RecruitingStoreState, id: string): JobRecord {
  const job = state.jobs.find((item) => item.id === id)
  if (!job) throw new RecruitingNotFoundError(`未找到岗位：${id}`)
  return job
}

function candidateOrThrow(state: RecruitingStoreState, id: string): CandidateRecord {
  const candidate = state.candidates.find((item) => item.id === id)
  if (!candidate) throw new RecruitingNotFoundError(`未找到候选人：${id}`)
  return candidate
}

function applicationOrThrow(state: RecruitingStoreState, id: string): ApplicationRecord {
  const application = state.applications.find((item) => item.id === id)
  if (!application) throw new RecruitingNotFoundError(`未找到申请：${id}`)
  return application
}

function resumeOrThrow(state: RecruitingStoreState, id: string): ResumeRecord {
  const resume = state.resumes.find((item) => item.id === id)
  if (!resume) throw new RecruitingNotFoundError(`未找到简历：${id}`)
  return resume
}

function taskOrThrow(state: RecruitingStoreState, id: string): AnalysisTaskRecord {
  const task = state.analysisTasks.find((item) => item.id === id)
  if (!task) throw new RecruitingNotFoundError(`未找到分析任务：${id}`)
  return task
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function contentHashBuffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function resumeExtension(filename: string, mimeType: string): string {
  const fromName = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : ''
  const safe = /^[a-z0-9]{1,8}$/.test(fromName) ? fromName : ''
  if (safe) return safe
  const map: Record<string, string> = { 'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html' }
  return map[mimeType] || 'bin'
}

function buildJobRequirements(job: JobRecord | undefined, jobId?: string) {
  const spec = job?.spec
  const jobKey = jobId ?? job?.id
  const prefix = jobKey ?? 'job'
  const summary = spec?.summary ?? job?.jd?.content
  const requirements = (spec?.requirements ?? []).map((item, index) => ({ id: `${prefix}-requirement-${index + 1}`, label: item.label, kind: /经验|年限|experience/i.test(item.label) ? 'experience' as const : /学历|education|本科|硕士|博士/i.test(item.label) ? 'education' as const : 'other' as const, keywords: [item.label, item.description].filter(Boolean), hard: item.required, ...(item.weight === undefined ? {} : { weight: item.weight }) }))
  const skills = (spec?.skills ?? []).map((skill, index) => ({ id: `${prefix}-skill-${index + 1}`, label: skill, kind: 'skill' as const, keywords: [skill], hard: false }))
  return { ...(jobKey ? { jobId: jobKey } : {}), title: spec?.title ?? job?.title ?? '未命名岗位', ...(summary ? { summary } : {}), requirements: [...requirements, ...skills] }
}

function mapRepositoryAnalysisTask(item: RepositoryAnalysisTask): AnalysisTaskRecord {
  return { id: item.id, resumeId: item.resumeId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), status: item.status as AnalysisTaskRecord['status'], attempts: item.attempts, idempotencyKey: item.idempotencyKey, ...(item.lastError ? { lastError: item.lastError } : {}), availableAt: item.availableAt, ...(item.startedAt ? { startedAt: item.startedAt } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}), createdAt: item.createdAt }
}

function mapRepositoryAnalysisResult(item: RepositoryAnalysisResult): AnalysisResultRecord {
  return { id: item.id, analysisTaskId: item.analysisTaskId, resumeId: item.resumeId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), result: item.result, analyzerVersion: item.analyzerVersion ?? 'unknown', inputHash: item.inputHash ?? '', humanReviewStatus: item.humanReviewStatus as AnalysisResultRecord['humanReviewStatus'], createdAt: item.createdAt }
}

function mapRepositoryJobForAnalysis(item: RepositoryJob): JobRecord {
  return { id: item.id, code: item.businessId, title: item.title, departmentId: item.departmentId, department: item.departmentName ?? item.departmentId, recruitmentRequestId: item.recruitmentRequestId ?? '', headcount: item.headcount, filledCount: 0, employmentType: 'full_time', workMode: 'onsite', status: item.status as JobRecord['status'], channels: [], version: 1, createdAt: item.createdAt, updatedAt: item.updatedAt }
}

function requestInput(input: CreateRecruitmentRequestInput): RecruitmentRequestRecord {
  const timestamp = LocalRecruitingStore.timestamp()
  return {
    id: randomUUID(), code: '', title: required(input.title, '岗位名称'), departmentId: required(input.departmentId, '部门'), department: clean(input.departmentId),
    requesterId: 'user-demo', ...(input.hiringManagerId ? { hiringManagerId: clean(input.hiringManagerId) } : {}), headcount: positiveInteger(input.headcount, '招聘人数'),
    employmentType: required(input.employmentType, '用工类型'), workMode: required(input.workMode, '工作模式'), ...(input.location ? { location: clean(input.location) } : {}),
    ...(input.salaryRange ? { salaryRange: input.salaryRange } : {}), justification: required(input.justification, '招聘理由'), status: 'draft',
    approval: { status: 'pending', approver: '待指定' }, convertedJobIds: [], version: 1, createdAt: timestamp, updatedAt: timestamp
  }

}

function jobInput(input: CreateJobInput, request: RecruitmentRequestRecord): JobRecord {
  const timestamp = LocalRecruitingStore.timestamp()
  return {
    id: randomUUID(), code: '', title: required(input.title, '岗位名称'), departmentId: required(input.departmentId, '部门'), department: request.department,
    ...(input.hiringManagerId ? { hiringManagerId: clean(input.hiringManagerId) } : {}), recruitmentRequestId: request.id, headcount: positiveInteger(input.headcount, '岗位人数'),
    filledCount: 0, employmentType: required(input.employmentType, '用工类型'), workMode: required(input.workMode, '工作模式'), ...(input.location ? { location: clean(input.location) } : {}),
    status: 'draft', channels: [], version: 1, createdAt: timestamp, updatedAt: timestamp
  }
}

/* ------------------------------------------------------------------ *
 * 部门数据范围（DataScope）
 *
 * 只有「需求 / 岗位」自带 departmentId，候选人主档、申请、面试、Offer、
 * 入职归档都没有部门字段，其归属一律沿「岗位 → 申请 → 下游对象」推断：
 *   岗位(job.departmentId) → 申请(application.jobId) → 候选人/面试/Offer/入职
 * 因此这里集中做一次视图收敛，列表、报表、看板共用同一口径。
 * ------------------------------------------------------------------ */

export function filterStateByDepartment(state: RecruitingStoreState, departmentId: string): RecruitingStoreState {
  const recruitmentRequests = state.recruitmentRequests.filter((request) => request.departmentId === departmentId)
  const jobs = state.jobs.filter((job) => job.departmentId === departmentId)
  const jobIds = new Set(jobs.map((job) => job.id))
  const applications = state.applications.filter((application) => jobIds.has(application.jobId))
  const applicationIds = new Set(applications.map((application) => application.id))
  const candidateIds = new Set(applications.map((application) => application.candidateId))
  const interviews = state.interviews.filter((interview) => applicationIds.has(interview.applicationId))
  const interviewIds = new Set(interviews.map((interview) => interview.id))
  const offers = state.offers.filter((offer) => applicationIds.has(offer.applicationId))
  const offerIds = new Set(offers.map((offer) => offer.id))
  const onboarding = state.onboarding.filter((record) => applicationIds.has(record.applicationId) || offerIds.has(record.offerId))
  const onboardingIds = new Set(onboarding.map((record) => record.id))
  const resumes = state.resumes.filter((resume) => candidateIds.has(resume.candidateId) || (resume.applicationId ? applicationIds.has(resume.applicationId) : false))
  const resumeIds = new Set(resumes.map((resume) => resume.id))
  const requestIds = new Set(recruitmentRequests.map((request) => request.id))
  const approvalInstances = state.approvalInstances.filter((instance) => instance.entityType === 'recruitment_request' && requestIds.has(instance.entityId))
  const instanceIds = new Set(approvalInstances.map((instance) => instance.id))
  const subjectIds: Record<WorkflowEventRecord['subjectType'], Set<string>> = {
    recruitment_request: requestIds,
    job: jobIds,
    candidate: candidateIds,
    application: applicationIds,
    interview: interviewIds,
    offer: offerIds,
    onboarding: onboardingIds,
  }

  return {
    ...state,
    recruitmentRequests,
    jobs,
    candidates: state.candidates.filter((candidate) => candidateIds.has(candidate.id)),
    applications,
    resumes,
    analysisTasks: state.analysisTasks.filter((task) => (task.applicationId ? applicationIds.has(task.applicationId) : resumeIds.has(task.resumeId))),
    analysisResults: state.analysisResults.filter((result) => (result.applicationId ? applicationIds.has(result.applicationId) : resumeIds.has(result.resumeId))),
    interviews,
    interviewFeedback: state.interviewFeedback.filter((feedback) => interviewIds.has(feedback.interviewId)),
    offers,
    offerVersions: state.offerVersions.filter((version) => offerIds.has(version.offerId)),
    onboarding,
    approvalInstances,
    approvalSteps: state.approvalSteps.filter((step) => instanceIds.has(step.instanceId)),
    approvalRecords: state.approvalRecords.filter((record) => instanceIds.has(record.instanceId)),
    workflowEvents: state.workflowEvents.filter((event) => subjectIds[event.subjectType]?.has(event.subjectId) ?? false),
  }
}

export class RecruitingService {
  private readonly repository: NormalizedRecruitingRepository | undefined
  private readonly store!: ReturnType<typeof createRecruitingStore>
  constructor(store?: ReturnType<typeof createRecruitingStore>, private readonly quarantineRoot = process.env.RECRUITING_QUARANTINE_ROOT || resolve(process.cwd(), '../../data/resumes/quarantine')) {
    if (process.env.NODE_ENV === 'test') {
      this.store = store ?? createRecruitingStore()
      this.repository = undefined
    } else {
      this.repository = createNormalizedRecruitingRepository()
    }
  }

  /**
   * 仓储模式的只读快照：把仓储记录装配成与本地状态同构的对象，
   * 让面试/Offer/入职/报表/看板这些读接口只维护一份口径，并复用 filterStateByDepartment 的部门范围推导。
   */
  private async repositoryStateView(departmentId?: string): Promise<RecruitingStoreState> {
    const repository = this.repository
    if (!repository) throw new Error('repositoryStateView 需要仓储实例')
    const [requests, jobs, candidates, applications, resumes, tasks, results, interviews, feedback, offers, offerVersions, onboarding, specRows, jdRows, events] = await Promise.all([
      repository.listRecruitmentRequests(),
      repository.listJobs(),
      repository.listCandidates(),
      repository.listApplications(),
      repository.listResumes(),
      repository.listAnalysisTasks(),
      repository.listAnalysisResults(),
      repository.listInterviews(),
      repository.listInterviewFeedback(),
      repository.listOffers(),
      repository.listOfferVersions(),
      repository.listOnboarding(),
      repository.listJobSpecVersions(),
      repository.listJobDescriptionVersions(),
      repository.listWorkflowEvents({ limit: 500 }),
    ])

    const mappedJobs: JobRecord[] = jobs.map((item) => this.mapRepositoryJob(item))
    const jobById = new Map(mappedJobs.map((job) => [job.id, job]))
    const specVersions: JobSpecVersionRecord[] = specRows.map((row) => ({ ...(row.content as unknown as JobSpecRecord), version: row.version, confirmed: Boolean(row.confirmedAt), ...(row.confirmedAt ? { confirmedAt: row.confirmedAt } : {}), jobId: row.jobId, createdAt: row.createdAt, ...(row.createdById ? { actorId: row.createdById } : {}) }))
    const jdVersions: JobDescriptionVersionRecord[] = jdRows.map((row) => ({ version: row.version, language: 'zh-CN', title: row.title, content: row.content, generatedBy: row.status === 'ai_assisted' ? 'ai_assisted' : 'human', confirmed: Boolean(row.confirmedAt), ...(row.confirmedAt ? { confirmedAt: row.confirmedAt } : {}), jobId: row.jobId, createdAt: row.createdAt, ...(row.createdById ? { actorId: row.createdById } : {}) }) as JobDescriptionVersionRecord & { title: string })
    for (const version of specVersions) {
      const job = jobById.get(version.jobId)
      if (job && (!job.spec || job.spec.version < version.version)) job.spec = { version: version.version, title: version.title, summary: version.summary, responsibilities: version.responsibilities, requirements: version.requirements, skills: version.skills, confirmed: version.confirmed, ...(version.confirmedAt ? { confirmedAt: version.confirmedAt } : {}) }
    }
    for (const version of jdVersions) {
      const job = jobById.get(version.jobId)
      if (job && (!job.jd || job.jd.version < version.version)) job.jd = { version: version.version, language: version.language, content: version.content, generatedBy: version.generatedBy, confirmed: version.confirmed, ...(version.confirmedAt ? { confirmedAt: version.confirmedAt } : {}) }
    }

    const state: RecruitingStoreState = {
      recruitmentRequests: requests.map((item) => this.mapRepositoryRequest(item)),
      jobs: mappedJobs,
      candidates: candidates.map((item) => ({ id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), status: item.consentStatus === 'do_not_contact' ? 'do_not_contact' : 'active', createdAt: item.createdAt, updatedAt: item.updatedAt })),
      applications: applications.map((item) => ({ id: item.id, code: item.businessId, candidateId: item.candidateId, jobId: item.jobId, status: item.status as ApplicationRecord['status'], ...(item.source ? { source: item.source } : {}), aiStatus: 'pending', appliedAt: item.appliedAt, ...(item.rejectedReason ? { rejectionReason: item.rejectedReason } : {}), updatedAt: item.updatedAt })),
      resumes: resumes.map((item) => ({ id: item.id, candidateId: item.candidateId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), storageKey: item.storageKey, originalFilename: item.originalFilename, mimeType: item.mimeType, sizeBytes: item.sizeBytes, contentHash: item.contentHash ?? '', scanStatus: item.scanStatus as ResumeRecord['scanStatus'], createdAt: item.createdAt })),
      analysisTasks: tasks.map((item) => ({ id: item.id, resumeId: item.resumeId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), status: item.status as AnalysisTaskRecord['status'], attempts: item.attempts, idempotencyKey: item.idempotencyKey, ...(item.lastError ? { lastError: item.lastError } : {}), availableAt: item.availableAt, ...(item.startedAt ? { startedAt: item.startedAt } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}), createdAt: item.createdAt })),
      analysisResults: results.map((item) => ({ id: item.id, analysisTaskId: item.analysisTaskId, resumeId: item.resumeId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), result: item.result, analyzerVersion: item.analyzerVersion ?? '', inputHash: item.inputHash ?? '', humanReviewStatus: item.humanReviewStatus as AnalysisResultRecord['humanReviewStatus'], createdAt: item.createdAt })),
      interviews: interviews.map((item) => this.mapRepositoryInterview(item)),
      interviewFeedback: feedback.map((item) => this.mapRepositoryFeedback(item)),
      offers: offers.map((item) => this.mapRepositoryOffer(item)),
      offerVersions: offerVersions.map((item) => ({ id: item.id, offerId: item.offerId, version: item.version, positionTitle: item.positionTitle, departmentId: item.departmentId, employmentType: item.employmentType, ...(item.startDate ? { startDate: item.startDate } : {}), compensation: item.compensation as unknown as OfferVersionRecord['compensation'], benefits: item.benefits, content: item.content, createdAt: item.createdAt })),
      onboarding: onboarding.map((item) => this.mapRepositoryOnboarding(item)),
      jobSpecVersions: specVersions,
      jobDescriptionVersions: jdVersions,
      approvalInstances: [],
      approvalSteps: [],
      approvalRecords: [],
      workflowEvents: events.map((item) => ({ id: item.id, subjectType: item.subjectType as WorkflowEventRecord['subjectType'], subjectId: item.subjectId, action: item.action, ...(item.fromStatus ? { fromStatus: item.fromStatus } : {}), ...(item.toStatus ? { toStatus: item.toStatus } : {}), actorId: item.actorId ?? '', ...(item.reason ? { reason: item.reason } : {}), createdAt: item.createdAt })),
      candidateTags: [],
      nextRequestNumber: requests.length + 1,
      nextJobNumber: jobs.length + 1,
      nextCandidateNumber: candidates.length + 1,
      nextApplicationNumber: applications.length + 1,
      nextInterviewNumber: interviews.length + 1,
      nextOfferNumber: offers.length + 1,
    }
    return departmentId ? filterStateByDepartment(state, departmentId) : state
  }

  /** 统一读视图入口：仓储模式走 PG 装配，测试/本地模式走 JSON 状态，部门范围口径一致。 */
  private async stateView(departmentId?: string): Promise<RecruitingStoreState> {
    if (this.repository) return this.repositoryStateView(departmentId)
    const state = await this.store.read()
    return departmentId ? filterStateByDepartment(state, departmentId) : state
  }

  private mapRepositoryInterview(item: RepositoryInterview): InterviewRecord {
    return { id: item.id, code: item.businessId, applicationId: item.applicationId, round: item.round, type: item.type as InterviewType, title: item.title, status: item.status as InterviewRecord['status'], ...(item.scheduledStartAt ? { scheduledStartAt: item.scheduledStartAt } : {}), ...(item.scheduledEndAt ? { scheduledEndAt: item.scheduledEndAt } : {}), ...(item.timezone ? { timezone: item.timezone } : {}), ...(item.location ? { location: item.location } : {}), ...(item.meetingUrl ? { meetingUrl: item.meetingUrl } : {}), participants: item.participants.map((participant) => ({ userId: participant.userId, ...(participant.name ? { name: participant.name } : {}), role: (participant.role || 'interviewer') as InterviewParticipant['role'], required: participant.required ?? true })), createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryFeedback(item: RepositoryInterviewFeedback): InterviewFeedbackRecord {
    const feedback: InterviewFeedbackRecord = { id: item.id, interviewId: item.interviewId, interviewerId: item.interviewerId, status: item.status as InterviewFeedbackRecord['status'], ratings: item.ratings, strengths: item.strengths, concerns: item.concerns }
    if (item.overallScore !== null) feedback.overallScore = item.overallScore
    if (item.recommendation) feedback.recommendation = item.recommendation as NonNullable<InterviewFeedbackRecord['recommendation']>
    if (item.notes) feedback.notes = item.notes
    if (item.submittedAt) feedback.submittedAt = item.submittedAt
    if (item.lockedAt) feedback.lockedAt = item.lockedAt
    return feedback
  }

  private mapRepositoryOffer(item: RepositoryOffer): OfferRecord {
    return { id: item.id, code: item.businessId, applicationId: item.applicationId, status: item.status as OfferRecord['status'], ...(item.currentVersionId ? { currentVersionId: item.currentVersionId } : {}), approval: { status: item.approvalStatus as OfferRecord['approval']['status'], approver: '' }, ...(item.sentAt ? { sentAt: item.sentAt } : {}), ...(item.respondedAt ? { respondedAt: item.respondedAt } : {}), ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}), version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryOnboarding(item: RepositoryOnboarding): OnboardingRecord {
    return { id: item.id, applicationId: item.applicationId, offerId: item.offerId, ...(item.plannedStartDate ? { plannedStartDate: item.plannedStartDate } : {}), status: item.status as OnboardingRecord['status'], ...(item.notes ? { notes: item.notes } : {}), ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryRequest(item: import('./repositories/types.js').RecruitmentRequestRecord): RecruitmentRequestRecord {
    return { id: item.id, code: item.businessId, title: item.title, departmentId: item.departmentId ?? '', department: item.departmentName ?? item.departmentId ?? '', requesterId: item.requestedById ?? '', headcount: item.headcount, employmentType: 'full_time', workMode: 'onsite', ...(item.budgetMin === null && item.budgetMax === null ? {} : { salaryRange: { ...(item.budgetMin === null ? {} : { min: { amount: item.budgetMin, currency: 'CNY' } }), ...(item.budgetMax === null ? {} : { max: { amount: item.budgetMax, currency: 'CNY' } }) } }), justification: item.reason, status: item.status as RecruitmentRequestRecord['status'], approval: { status: item.status === 'approved' ? 'approved' : item.status === 'rejected' ? 'rejected' : 'pending', approver: '' }, convertedJobIds: [], version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryJob(item: import('./repositories/types.js').JobRecord): JobRecord {
    return { id: item.id, code: item.businessId, title: item.title, departmentId: item.departmentId, department: item.departmentName ?? item.departmentId, recruitmentRequestId: item.recruitmentRequestId ?? '', headcount: item.headcount, filledCount: 0, employmentType: 'full_time', workMode: 'onsite', status: item.status as JobRecord['status'], channels: [], version: 1, createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  /** 目标部门下的岗位 id 集合：候选人/申请/面试/Offer 的部门归属都由此推出。 */
  private async jobIdsInDepartment(departmentId: string): Promise<Set<string>> {
    return new Set((await this.listJobs(undefined, undefined, departmentId)).map((job) => job.id))
  }

  /** 部门范围下的岗位/申请/候选人 id 集合（仓储路径与本地状态路径共用同一口径）。 */
  private async scopedIds(departmentId: string): Promise<{ jobIds: Set<string>; applicationIds: Set<string>; candidateIds: Set<string> }> {
    const jobIds = await this.jobIdsInDepartment(departmentId)
    const applications = await this.listApplications()
    const scoped = applications.filter((application) => jobIds.has(application.jobId))
    return { jobIds, applicationIds: new Set(scoped.map((application) => application.id)), candidateIds: new Set(scoped.map((application) => application.candidateId)) }
  }

  /** 申请归属越权时抛 403 FORBIDDEN。 */
  async assertApplicationInScope(applicationId: string, departmentId?: string): Promise<void> {
    if (!departmentId) return
    const application = this.repository ? await this.repository.getApplication(applicationId) : applicationOrThrow(await this.store.read(), applicationId)
    const job = await this.getJob(application.jobId)
    if (job.departmentId !== departmentId) throw new RecruitingWorkflowError('FORBIDDEN', '当前账号无权访问其他部门数据', 403)
  }

  /** 候选人主档没有部门字段，按其在目标部门岗位上的申请归属判定。 */
  async assertCandidateInScope(candidateId: string, departmentId?: string): Promise<void> {
    if (!departmentId) return
    const jobIds = await this.jobIdsInDepartment(departmentId)
    const applications = await this.listApplications()
    if (!applications.some((application) => application.candidateId === candidateId && jobIds.has(application.jobId))) {
      throw new RecruitingWorkflowError('FORBIDDEN', '当前账号无权访问其他部门数据', 403)
    }
  }

  async assertInterviewInScope(interviewId: string, departmentId?: string): Promise<void> {
    if (!departmentId) return
    const interview = await this.getInterview(interviewId)
    await this.assertApplicationInScope(interview.applicationId, departmentId)
  }

  async assertOfferInScope(offerId: string, departmentId?: string): Promise<void> {
    if (!departmentId) return
    const offer = await this.getOffer(offerId)
    await this.assertApplicationInScope(offer.applicationId, departmentId)
  }

  async assertOnboardingInScope(onboardingId: string, departmentId?: string): Promise<void> {
    if (!departmentId) return
    const record = await this.getOnboarding(onboardingId)
    await this.assertApplicationInScope(record.applicationId, departmentId)
  }

  async listRequests(status?: string, departmentId?: string): Promise<RecruitmentRequestRecord[]> {
    if (this.repository) {
      const rows = await this.repository.listRecruitmentRequests(status)
      return rows.filter((item) => !departmentId || item.departmentId === departmentId).map((item) => this.mapRepositoryRequest(item))
    }
    const state = await this.store.read()
    return state.recruitmentRequests.filter((item) => (!status || item.status === status) && (!departmentId || item.departmentId === departmentId))
  }

  async getRequest(id: string): Promise<RecruitmentRequestRecord> {
    if (this.repository) return this.mapRepositoryRequest(await this.repository.getRecruitmentRequest(id))
    const state = await this.store.read()
    return requestOrThrow(state, id)
  }

  async createRequest(input: CreateRecruitmentRequestInput, actorId = 'user-demo'): Promise<RecruitmentRequestRecord> {
    if (this.repository) {
      const row = await this.repository.createRecruitmentRequest({ title: required(input.title, '岗位名称'), departmentId: input.departmentId, requestedById: actorId, headcount: positiveInteger(input.headcount, '招聘人数'), budgetMin: input.salaryRange?.min?.amount ?? null, budgetMax: input.salaryRange?.max?.amount ?? null, reason: input.justification, status: 'draft' })
      return this.mapRepositoryRequest(row)
    }
    return this.store.transaction((state) => {
      const request = requestInput(input)
      request.requesterId = actorId
      request.code = `REQ-${state.nextRequestNumber++}`
      state.recruitmentRequests.push(request)
      addEvent(state, { subjectType: 'recruitment_request', subjectId: request.id, action: 'create', toStatus: request.status, actorId })
      return request
    })
  }

  async updateRequest(id: string, input: UpdateRecruitmentRequestInput, actorId = 'user-demo'): Promise<RecruitmentRequestRecord> {
    if (this.repository) {
      const current = await this.repository.getRecruitmentRequest(id)
      if (current.status !== 'draft' && current.status !== 'rejected') throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_NOT_EDITABLE', '只有草稿或已驳回需求可以编辑')
      const row = await this.repository.updateRecruitmentRequest(id, { ...(input.title === undefined ? {} : { title: input.title }), ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }), ...(input.headcount === undefined ? {} : { headcount: positiveInteger(input.headcount, '招聘人数') }), ...(input.justification === undefined ? {} : { reason: input.justification }), ...(input.salaryRange?.min ? { budgetMin: input.salaryRange.min.amount } : {}), ...(input.salaryRange?.max ? { budgetMax: input.salaryRange.max.amount } : {}), version: current.version + 1 })
      return this.mapRepositoryRequest(row)
    }
    return this.store.transaction((state) => {
      const request = requestOrThrow(state, id)
      if (request.status !== 'draft' && request.status !== 'rejected') throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_NOT_EDITABLE', '只有草稿或已驳回需求可以编辑')
      for (const field of ['title', 'departmentId', 'hiringManagerId', 'employmentType', 'workMode', 'location', 'justification', 'salaryRange'] as const) {
        if (input[field] !== undefined) (request as unknown as Record<string, unknown>)[field] = input[field]
      }
      if (input.headcount !== undefined) request.headcount = positiveInteger(input.headcount, '招聘人数')
      request.version += 1; request.updatedAt = LocalRecruitingStore.timestamp(); addEvent(state, { subjectType: 'recruitment_request', subjectId: request.id, action: 'update', actorId })
      return request
    })
  }

  async requestAction(id: string, action: string, reason?: unknown, actorId = 'user-demo'): Promise<RecruitmentRequestRecord> {
    if (this.repository && ['submit', 'resubmit', 'approve', 'reject'].includes(action)) {
      const row = await this.repository.requestApprovalAction(id, action as 'submit' | 'resubmit' | 'approve' | 'reject', actorId, reason === undefined ? undefined : clean(reason))
      return this.mapRepositoryRequest(row)
    }
    return this.store.transaction((state) => {
      const request = requestOrThrow(state, id)
      const fromStatus = request.status
      const normalizedReason = reason === undefined ? '' : clean(reason)

      if (action === 'submit' || action === 'resubmit') {
        transitionRequest(request, action, reason)
        createApprovalInstance(state, id, actorId)
      } else if (action === 'approve' || action === 'reject') {
        const instance = state.approvalInstances
          .filter((item) => item.entityType === 'recruitment_request' && item.entityId === id)
          .sort((a, b) => b.version - a.version)[0]
        if (!instance || instance.status !== 'pending') throw new RecruitingWorkflowError('APPROVAL_INSTANCE_REQUIRED', '当前需求无可审批实例')
        const step = currentPendingStep(state, instance.id)
        if (!step) throw new RecruitingWorkflowError('APPROVAL_STEP_REQUIRED', '当前审批实例已结束')
        const approvalResult = recordApproval(state, instance, step, action, actorId, normalizedReason || undefined)
        const allSteps = state.approvalSteps.filter((item) => item.instanceId === instance.id)
        const completed = allSteps.every((item) => item.status !== 'pending')
        if (action === 'reject') instance.status = 'rejected'
        else if (completed) instance.status = 'approved'
        transitionRequest(request, action, reason)
        request.approval = approvalResult
        request.approval.approver = actorId === 'user-demo' ? '当前审批人' : actorId
      } else {
        transitionRequest(request, action, reason)
      }

      addEvent(state, { subjectType: 'recruitment_request', subjectId: request.id, action, fromStatus, toStatus: request.status, actorId, ...(reason ? { reason: clean(reason) } : {}) })
      return request
    })
  }

  async getRequestApproval(id: string): Promise<{ current: ApprovalInstanceRecord | null; steps: ApprovalStepRecord[]; records: ApprovalAuditRecord[] }> {
    if (this.repository) {
      await this.repository.getRecruitmentRequest(id)
      const approval = await this.repository.getRecruitmentRequestApproval(id)
      return {
        current: approval.current ? { id: approval.current.id, entityType: 'recruitment_request', entityId: approval.current.entityId, version: approval.current.version, status: approval.current.status, createdAt: approval.current.createdAt, updatedAt: approval.current.updatedAt } : null,
        steps: approval.steps.map((item) => ({ id: item.id, instanceId: item.instanceId, order: item.order, name: item.name, approverRole: item.approverRole, status: item.status, ...(item.actedAt ? { actedAt: item.actedAt } : {}) })),
        records: approval.records.map((item) => ({ id: item.id, instanceId: item.instanceId, stepId: item.stepId, actorId: item.actorId, action: item.action, ...(item.comment ? { comment: item.comment } : {}), createdAt: item.createdAt })),
      }
    }
    const state = await this.store.read()
    requestOrThrow(state, id)
    const instances = state.approvalInstances.filter((item) => item.entityType === 'recruitment_request' && item.entityId === id).sort((a, b) => b.version - a.version)
    const current = instances[0] ?? null
    const instanceIds = new Set(instances.map((item) => item.id))
    const steps = instanceIds.size ? state.approvalSteps.filter((item) => instanceIds.has(item.instanceId)) : []
    const records = instanceIds.size ? state.approvalRecords.filter((item) => instanceIds.has(item.instanceId)) : []
    return { current, steps, records }
  }

  async listJobs(status?: string, recruitmentRequestId?: string, departmentId?: string): Promise<JobRecord[]> {
    if (this.repository) {
      const rows = await this.repository.listJobs(status, recruitmentRequestId)
      return rows.filter((item) => !departmentId || item.departmentId === departmentId).map((item) => this.mapRepositoryJob(item))
    }
    const state = await this.store.read()
    return state.jobs.filter((item) => (!status || item.status === status) && (!recruitmentRequestId || item.recruitmentRequestId === recruitmentRequestId) && (!departmentId || item.departmentId === departmentId))
  }

  async getJob(id: string): Promise<JobRecord> {
    if (this.repository) return this.mapRepositoryJob(await this.repository.getJob(id))
    const state = await this.store.read()
    return jobOrThrow(state, id)
  }

  async createJob(input: CreateJobInput, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const row = await this.repository.createJob({ title: required(input.title, '岗位名称'), departmentId: input.departmentId, recruitmentRequestId: input.recruitmentRequestId, headcount: positiveInteger(input.headcount, '岗位人数'), status: 'draft', createdById: actorId })
      return this.mapRepositoryJob(row)
    }
    return this.store.transaction((state) => {
      const request = requestOrThrow(state, required(input.recruitmentRequestId, '招聘需求'))
      if (request.status !== 'approved' && request.status !== 'converted') throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_NOT_APPROVED', '只有审批通过的招聘需求才能创建岗位')
      const job = jobInput(input, request)
      job.code = `JOB-${state.nextJobNumber++}`
      state.jobs.push(job)
      request.convertedJobIds.push(job.id)
      request.updatedAt = LocalRecruitingStore.timestamp()
      addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'create_job', toStatus: job.status, actorId })
      return job
    })
  }

  async updateJob(id: string, input: UpdateJobInput, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const row = await this.repository.updateJob(id, { ...(input.title === undefined ? {} : { title: input.title }), ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }), ...(input.headcount === undefined ? {} : { headcount: positiveInteger(input.headcount, '岗位人数') }) })
      return this.mapRepositoryJob(row)
    }
    return this.store.transaction((state) => {
      const job = jobOrThrow(state, id)
      if (job.status === 'closed') throw new RecruitingWorkflowError('JOB_NOT_EDITABLE', '已关闭岗位不能编辑')
      const hasPublishedFieldChange = ['title', 'departmentId', 'hiringManagerId', 'employmentType', 'workMode', 'location', 'headcount'].some((field) => input[field as never] !== undefined)
      if ((job.status === 'published' || job.status === 'paused') && hasPublishedFieldChange) {
        const timestamp = LocalRecruitingStore.timestamp()
        const previousStatus = job.status
        if (job.spec) {
          state.jobSpecVersions.push({ ...job.spec, jobId: job.id, createdAt: timestamp, actorId })
          job.spec = { ...job.spec, version: job.spec.version + 1, confirmed: false, confirmedAt: undefined as any }
        }
        if (job.jd) {
          state.jobDescriptionVersions.push({ ...job.jd, jobId: job.id, createdAt: timestamp, actorId })
          job.jd = { ...job.jd, version: job.jd.version + 1, confirmed: false, confirmedAt: undefined as any }
        }
        job.status = 'draft'
        addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'published_job_requires_reconfirmation', fromStatus: previousStatus, toStatus: job.status, actorId })
      }
      for (const field of ['title', 'departmentId', 'hiringManagerId', 'employmentType', 'workMode', 'location'] as const) {
        if (input[field] !== undefined) (job as unknown as Record<string, unknown>)[field] = input[field]
      }
      if (input.headcount !== undefined) job.headcount = positiveInteger(input.headcount, '岗位人数')
      job.version += 1; job.updatedAt = LocalRecruitingStore.timestamp(); addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'update_job', actorId })
      return job
    })
  }

  async createSpec(id: string, input: CreateJobSpecInput, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const jobRow = await this.repository.getJob(id)
      const versions = await this.repository.listJobSpecVersions(jobRow.id)
      const version = (versions[0]?.version ?? 0) + 1
      const spec: JobSpecRecord = { version, title: required(input.title, '说明书标题'), summary: required(input.summary, '岗位摘要'), responsibilities: input.responsibilities ?? [], requirements: input.requirements ?? [], skills: input.skills ?? [], confirmed: false }
      await this.repository.createJobSpecVersion({ jobId: jobRow.id, version, content: spec as unknown as Record<string, unknown>, createdById: actorId })
      await this.repository.appendWorkflowEvent({ subjectType: 'job', subjectId: jobRow.id, action: 'spec_created', actorId })
      return { ...this.mapRepositoryJob(jobRow), spec }
    }
    return this.store.transaction((state) => {
      const job = jobOrThrow(state, id)
      const createdAt = LocalRecruitingStore.timestamp()
      if (job.spec) state.jobSpecVersions.push({ ...job.spec, jobId: job.id, createdAt, actorId })
      job.spec = { version: (job.spec?.version ?? 0) + 1, title: required(input.title, '说明书标题'), summary: required(input.summary, '岗位摘要'), responsibilities: input.responsibilities ?? [], requirements: input.requirements ?? [], skills: input.skills ?? [], confirmed: false }
      state.jobSpecVersions.push({ ...job.spec, jobId: job.id, createdAt, actorId })
      job.version += 1; job.updatedAt = createdAt
      addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'spec_created', actorId })
      return job
    })
  }

  async createJd(id: string, input: { language: string; content: string; generatedBy?: 'human' | 'ai_assisted' }, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const jobRow = await this.repository.getJob(id)
      const versions = await this.repository.listJobDescriptionVersions(jobRow.id)
      const version = (versions[0]?.version ?? 0) + 1
      const created = await this.repository.createJobDescriptionVersion({ jobId: jobRow.id, version, title: jobRow.title, content: required(input.content, 'JD 内容'), status: input.generatedBy === 'ai_assisted' ? 'ai_assisted' : 'draft', createdById: actorId })
      await this.repository.appendWorkflowEvent({ subjectType: 'job', subjectId: jobRow.id, action: 'jd_created', actorId })
      const jd: JobDescriptionRecord = { version: created.version, language: required(input.language, '语言'), content: created.content, generatedBy: input.generatedBy ?? 'human', confirmed: false }
      return { ...this.mapRepositoryJob(jobRow), jd }
    }
    return this.store.transaction((state) => {
      const job = jobOrThrow(state, id)
      const createdAt = LocalRecruitingStore.timestamp()
      if (job.jd) state.jobDescriptionVersions.push({ ...job.jd, jobId: job.id, createdAt, actorId })
      const jd: JobDescriptionRecord = { version: (job.jd?.version ?? 0) + 1, language: required(input.language, '语言'), content: required(input.content, 'JD 内容'), generatedBy: input.generatedBy ?? 'human', confirmed: false }
      job.jd = jd; state.jobDescriptionVersions.push({ ...jd, jobId: job.id, createdAt, actorId }); job.version += 1; job.updatedAt = createdAt
      addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'jd_created', actorId })
      return job
    })
  }

  async listJobSpecVersions(id: string): Promise<JobSpecVersionRecord[]> {
    const state = await this.stateView()
    jobOrThrow(state, id)
    return state.jobSpecVersions.filter((version) => version.jobId === id).sort((a, b) => b.version - a.version)
  }

  async listJobDescriptionVersions(id: string): Promise<JobDescriptionVersionRecord[]> {
    const state = await this.stateView()
    jobOrThrow(state, id)
    return state.jobDescriptionVersions.filter((version) => version.jobId === id).sort((a, b) => b.version - a.version)
  }

  async jobAction(id: string, action: string, reason?: unknown, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const state = await this.stateView()
      const job = { ...jobOrThrow(state, id) }
      const request = job.recruitmentRequestId ? state.recruitmentRequests.find((item) => item.id === job.recruitmentRequestId) : undefined
      if (!request) throw new RecruitingNotFoundError(`未找到招聘需求：${job.recruitmentRequestId}`)
      const fromStatus = job.status
      transitionJob(job, action, request, reason)
      if (job.status !== fromStatus) await this.repository.updateJob(job.id, { status: job.status })
      if (action === 'confirm_spec') await this.repository.confirmJobSpecVersion(job.id)
      if (action === 'confirm_jd') await this.repository.confirmJobDescriptionVersion(job.id)
      await this.repository.appendWorkflowEvent({ subjectType: 'job', subjectId: job.id, action, fromStatus, toStatus: job.status, actorId, ...(reason ? { reason: clean(reason) } : {}) })
      return job
    }
    return this.store.transaction((state) => {
      const job = jobOrThrow(state, id)
      const request = requestOrThrow(state, job.recruitmentRequestId)
      const fromStatus = job.status
      transitionJob(job, action, request, reason)
      addEvent(state, { subjectType: 'job', subjectId: job.id, action, fromStatus, toStatus: job.status, actorId, ...(reason ? { reason: clean(reason) } : {}) })
      return job
    })
  }

  async listCandidates(departmentId?: string): Promise<Array<CandidateRecord & { applications: ApplicationRecord[] }>> {
    const jobIds = departmentId ? await this.jobIdsInDepartment(departmentId) : undefined
    if (this.repository) {
      const candidates = await this.repository.listCandidates()
      const applications = await this.repository.listApplications()
      const rows: Array<CandidateRecord & { applications: ApplicationRecord[] }> = candidates.map((item) => ({ id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), status: item.consentStatus === 'do_not_contact' ? 'do_not_contact' : 'active', createdAt: item.createdAt, updatedAt: item.updatedAt, applications: applications.filter((app) => app.candidateId === item.id).map((app) => ({ id: app.id, code: app.businessId, candidateId: app.candidateId, jobId: app.jobId, status: app.status as ApplicationRecord['status'], ...(app.source ? { source: app.source } : {}), aiStatus: 'pending', appliedAt: app.appliedAt, updatedAt: app.updatedAt })) }))
      return jobIds ? rows.filter((row) => row.applications.some((application) => jobIds.has(application.jobId))) : rows
    }

    const state = await this.store.read()
    const scoped = departmentId ? filterStateByDepartment(state, departmentId) : state
    const rows = scoped.candidates.map((candidate) => ({ ...candidate, applications: scoped.applications.filter((application) => application.candidateId === candidate.id) }))
    return jobIds ? rows.filter((row) => row.applications.some((application) => jobIds.has(application.jobId))) : rows
  }

  async listCandidateTags(): Promise<string[]> {
    const state = await this.stateView()
    return [...(state.candidateTags ?? [])]
  }

  async getCandidate(id: string): Promise<CandidateRecord & { applications: ApplicationRecord[]; resumes: ResumeRecord[]; analysisTasks: AnalysisTaskRecord[]; analysisResults: AnalysisResultRecord[]; jobs: Array<{ id: string; code: string; title: string }> }> {
    if (this.repository) {
      const item = await this.repository.getCandidate(id)
      const applications = await this.repository.listApplications(item.id)
      return { id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), status: item.consentStatus === 'do_not_contact' ? 'do_not_contact' : 'active', createdAt: item.createdAt, updatedAt: item.updatedAt, applications: applications.map((app) => ({ id: app.id, code: app.businessId, candidateId: app.candidateId, jobId: app.jobId, status: app.status as ApplicationRecord['status'], aiStatus: 'pending', appliedAt: app.appliedAt, updatedAt: app.updatedAt })), resumes: [], analysisTasks: [], analysisResults: [], jobs: [] }
    }
    const state = await this.store.read()
    const candidate = candidateOrThrow(state, id)
    const applications = state.applications.filter((application) => application.candidateId === id)
    const resumes = state.resumes.filter((resume) => resume.candidateId === id)
    const resumeIds = new Set(resumes.map((resume) => resume.id))
    const applicationIds = new Set(applications.map((application) => application.id))
    const analysisTasks = state.analysisTasks.filter((task) => resumeIds.has(task.resumeId) || (task.applicationId ? applicationIds.has(task.applicationId) : false))
    const analysisResults = state.analysisResults.filter((result) => resumeIds.has(result.resumeId) || (result.applicationId ? applicationIds.has(result.applicationId) : false))
    const jobIds = new Set(applications.map((application) => application.jobId))
    const jobs = state.jobs.filter((job) => jobIds.has(job.id)).map((job) => ({ id: job.id, code: job.code, title: job.title }))
    return { ...candidate, applications, resumes, analysisTasks, analysisResults, jobs }
  }

  async createCandidate(input: CreateCandidateInput, actorId = 'user-demo'): Promise<CandidateRecord> {
    if (this.repository) {
      const item = await this.repository.createCandidate({ name: required(input.fullName, '候选人姓名'), ...(input.email ? { email: input.email } : {}), ...(input.phone ? { phone: input.phone } : {}), ...(input.source ? { source: input.source } : {}), consentStatus: 'unknown' })
      return { id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), status: 'active', createdAt: item.createdAt, updatedAt: item.updatedAt }
    }
    return this.store.transaction((state) => {
      const tags = normalizeTags(input.tags)
      const candidate: CandidateRecord = { id: randomUUID(), code: `CAN-${state.nextCandidateNumber++}`, fullName: required(input.fullName, '候选人姓名'), ...(input.email ? { email: clean(input.email) } : {}), ...(input.phone ? { phone: clean(input.phone) } : {}), ...(input.source ? { source: clean(input.source) } : {}), ...(tags ? { tags } : {}), status: 'active', createdAt: LocalRecruitingStore.timestamp(), updatedAt: LocalRecruitingStore.timestamp() }
      state.candidates.push(candidate)
      addEvent(state, { subjectType: 'candidate', subjectId: candidate.id, action: 'create', actorId })
      return candidate
    })
  }

  async updateCandidate(id: string, input: UpdateCandidateInput, actorId = 'user-demo'): Promise<CandidateRecord> {
    if (this.repository) {
      const item = await this.repository.updateCandidate(id, { ...(input.fullName === undefined ? {} : { name: input.fullName }), ...(input.email === undefined ? {} : { email: input.email }), ...(input.phone === undefined ? {} : { phone: input.phone }), ...(input.source === undefined ? {} : { source: input.source }), ...(input.status === undefined ? {} : { consentStatus: input.status }) })
      return { id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), status: item.consentStatus === 'do_not_contact' ? 'do_not_contact' : 'active', createdAt: item.createdAt, updatedAt: item.updatedAt }
    }
    return this.store.transaction((state) => {
      const candidate = candidateOrThrow(state, id)
      const fromStatus = candidate.status
      if (input.fullName !== undefined) candidate.fullName = required(input.fullName, '候选人姓名')
      if (input.email !== undefined) { const email = clean(input.email); if (email) candidate.email = email; else delete candidate.email }
      if (input.phone !== undefined) { const phone = clean(input.phone); if (phone) candidate.phone = phone; else delete candidate.phone }
      if (input.source !== undefined) { const source = clean(input.source); if (source) candidate.source = source; else delete candidate.source }
      if (input.tags !== undefined) {
        const tags = normalizeTags(input.tags)
        if (tags) candidate.tags = tags; else delete candidate.tags
        const allTags = new Set([...(candidate.tags ?? []), ...(state.candidateTags ?? [])])
        state.candidateTags = [...allTags]
      }
      if (input.status !== undefined) {
        if (!['active', 'archived', 'do_not_contact'].includes(input.status)) throw new RecruitingWorkflowError('VALIDATION_ERROR', `候选人不支持状态 ${input.status}`, 400)
        candidate.status = input.status
      }
      candidate.updatedAt = LocalRecruitingStore.timestamp()
      const toStatus = candidate.status
      addEvent(state, { subjectType: 'candidate', subjectId: candidate.id, action: toStatus === fromStatus ? 'update' : 'status_changed', fromStatus, toStatus, actorId, ...(input.reason ? { reason: clean(input.reason) } : {}) })
      return candidate
    })
  }

  async createApplication(input: CreateApplicationInput, actorId = 'user-demo'): Promise<ApplicationRecord> {
    if (this.repository) {
      const item = await this.repository.createApplication({ candidateId: required(input.candidateId, '候选人'), jobId: required(input.jobId, '岗位'), ...(input.source ? { source: input.source } : {}) })
      return { id: item.id, code: item.businessId, candidateId: item.candidateId, jobId: item.jobId, status: item.status as ApplicationRecord['status'], ...(item.source ? { source: item.source } : {}), aiStatus: 'pending', appliedAt: item.appliedAt, updatedAt: item.updatedAt }
    }
    return this.store.transaction((state) => {
      candidateOrThrow(state, required(input.candidateId, '候选人'))
      jobOrThrow(state, required(input.jobId, '岗位'))
      if (state.applications.some((item) => item.candidateId === input.candidateId && item.jobId === input.jobId)) throw new RecruitingWorkflowError('APPLICATION_ALREADY_EXISTS', '该候选人已经申请此岗位')
      const timestamp = LocalRecruitingStore.timestamp()
      const application: ApplicationRecord = { id: randomUUID(), code: `APP-${state.nextApplicationNumber++}`, candidateId: input.candidateId, jobId: input.jobId, ...(input.source ? { source: clean(input.source) } : {}), status: 'pending_analysis', aiStatus: 'pending', appliedAt: timestamp, updatedAt: timestamp }
      state.applications.push(application)
      addEvent(state, { subjectType: 'application', subjectId: application.id, action: 'create', actorId })
      return application
    })
  }

  async listApplications(candidateId?: string, jobId?: string, departmentId?: string): Promise<ApplicationRecord[]> {
    const jobIds = departmentId ? await this.jobIdsInDepartment(departmentId) : undefined
    if (this.repository) {
      const rows = await this.repository.listApplications(candidateId, jobId)
      const mapped: ApplicationRecord[] = rows.map((item) => ({ id: item.id, code: item.businessId, candidateId: item.candidateId, jobId: item.jobId, status: item.status as ApplicationRecord['status'], ...(item.source ? { source: item.source } : {}), aiStatus: 'pending', appliedAt: item.appliedAt, updatedAt: item.updatedAt }))
      return jobIds ? mapped.filter((item) => jobIds.has(item.jobId)) : mapped
    }
    const state = departmentId ? filterStateByDepartment(await this.store.read(), departmentId) : await this.store.read()
    return state.applications.filter((item) => (!candidateId || item.candidateId === candidateId) && (!jobId || item.jobId === jobId))
  }

  async listInterviews(applicationId?: string, departmentId?: string): Promise<Array<InterviewRecord & { feedbackStatus: InterviewFeedbackRecord['status'] | 'pending'; application: ApplicationRecord }>> {
    const state = await this.stateView(departmentId)
    return state.interviews.filter((i) => !applicationId || i.applicationId === applicationId).map((interview) => { const feedback = state.interviewFeedback.filter((x) => x.interviewId === interview.id); return { ...interview, application: applicationOrThrow(state, interview.applicationId), feedbackStatus: feedback.length && feedback.every((x) => x.status === 'locked') ? 'locked' : feedback.length ? feedback[0]!.status : 'pending' } })
  }

  async getInterview(id: string): Promise<InterviewRecord & { feedbackStatus: InterviewFeedbackRecord['status'] | 'pending'; application: ApplicationRecord; feedback: InterviewFeedbackRecord[] }> {
    const state = await this.stateView()
    const interview = state.interviews.find((x) => x.id === id)
    if (!interview) throw new RecruitingNotFoundError(`未找到面试：${id}`)
    const feedback = state.interviewFeedback.filter((x) => x.interviewId === id).map((item) => ({ ...item }))
    const feedbackStatus = feedback.length && feedback.every((x) => x.status === 'locked') ? 'locked' : feedback.length ? feedback[0]!.status : 'pending'
    return { ...interview, application: applicationOrThrow(state, interview.applicationId), feedbackStatus, feedback }
  }

  async createInterview(input: CreateInterviewInput, actorId = 'user-demo'): Promise<InterviewRecord> {
    if (this.repository) {
      const applicationRow = await this.repository.getApplication(required(input.applicationId, '申请'))
      if (['rejected', 'offer_declined', 'offer_cancelled', 'offer_expired', 'onboarding_archived'].includes(applicationRow.status)) throw new RecruitingWorkflowError('APPLICATION_NOT_INTERVIEWABLE', '当前申请不能安排面试')
      const participants = (input.participants ?? []).map((item) => ({ userId: required(item.userId, '面试官'), ...(item.name ? { name: clean(item.name) } : {}), role: item.role ?? 'interviewer', required: item.required ?? true }))
      if (!participants.some((item) => item.role === 'interviewer')) throw new RecruitingWorkflowError('INTERVIEWER_REQUIRED', '至少需要一名面试官')
      const existing = await this.repository.listInterviews(applicationRow.id)
      const created = await this.repository.createInterview({ applicationId: applicationRow.id, round: input.round ?? existing.length + 1, type: input.type ?? 'other', title: required(input.title, '面试标题'), scheduledStartAt: input.scheduledStartAt ?? null, scheduledEndAt: input.scheduledEndAt ?? null, timezone: input.timezone ? clean(input.timezone) : null, location: input.location ? clean(input.location) : null, meetingUrl: input.meetingUrl ? clean(input.meetingUrl) : null, participants })
      await this.repository.appendWorkflowEvent({ subjectType: 'interview', subjectId: created.id, action: 'create', actorId })
      if (['pending_analysis', 'analysis_queued', 'human_review'].includes(applicationRow.status)) await this.repository.updateApplicationStatus(applicationRow.id, 'interviewing')
      return this.mapRepositoryInterview(created)
    }
    return this.store.transaction((state) => { const application = applicationOrThrow(state, required(input.applicationId, '申请')); if (['rejected', 'offer_declined', 'offer_cancelled', 'offer_expired', 'onboarding_archived'].includes(application.status)) throw new RecruitingWorkflowError('APPLICATION_NOT_INTERVIEWABLE', '当前申请不能安排面试'); const timestamp = LocalRecruitingStore.timestamp(); const participants = (input.participants ?? []).map((p) => ({ userId: required(p.userId, '面试官'), ...(p.name ? { name: clean(p.name) } : {}), role: p.role ?? 'interviewer', required: p.required ?? true })); if (!participants.some((p) => p.role === 'interviewer')) throw new RecruitingWorkflowError('INTERVIEWER_REQUIRED', '至少需要一名面试官'); const interview: InterviewRecord = { id: randomUUID(), code: `INT-${state.nextInterviewNumber++}`, applicationId: application.id, round: input.round ?? state.interviews.filter((x) => x.applicationId === application.id).length + 1, type: input.type ?? 'other', title: required(input.title, '面试标题'), status: 'scheduled', ...(input.scheduledStartAt ? { scheduledStartAt: input.scheduledStartAt } : {}), ...(input.scheduledEndAt ? { scheduledEndAt: input.scheduledEndAt } : {}), ...(input.timezone ? { timezone: clean(input.timezone) } : {}), ...(input.location ? { location: clean(input.location) } : {}), ...(input.meetingUrl ? { meetingUrl: clean(input.meetingUrl) } : {}), participants, createdAt: timestamp, updatedAt: timestamp }; state.interviews.push(interview); addEvent(state, { subjectType: 'interview', subjectId: interview.id, action: 'create', actorId }); if (application.status === 'pending_analysis' || application.status === 'analysis_queued' || application.status === 'human_review') application.status = 'interviewing'; application.updatedAt = timestamp; return interview }) }

  async submitFeedback(id: string, input: FeedbackInput, actorId = 'user-demo'): Promise<InterviewFeedbackRecord> {
    if (this.repository) {
      const interview = await this.repository.getInterview(id)
      const interviewerId = required(input.interviewerId, '面试官')
      const existing = await this.repository.getInterviewFeedbackForInterviewer(interview.id, interviewerId)
      if (existing?.status === 'locked') throw new RecruitingWorkflowError('FEEDBACK_LOCKED', '反馈已锁定，不能修改', 409)
      const payload = { status: 'submitted', overallScore: input.overallScore !== undefined ? Number(input.overallScore) : (existing?.overallScore ?? null), recommendation: input.recommendation ?? existing?.recommendation ?? null, ratings: input.ratings ?? existing?.ratings ?? {}, strengths: input.strengths ?? existing?.strengths ?? [], concerns: input.concerns ?? existing?.concerns ?? [], notes: input.notes !== undefined ? input.notes : (existing?.notes ?? null), submittedAt: LocalRecruitingStore.timestamp() }
      const feedback = existing
        ? await this.repository.updateInterviewFeedback(existing.id, payload)
        : await this.repository.createInterviewFeedback({ interviewId: interview.id, interviewerId, ...payload })
      await this.repository.appendWorkflowEvent({ subjectType: 'interview', subjectId: interview.id, action: 'feedback_submitted', actorId: interviewerId })
      return this.mapRepositoryFeedback(feedback)
    }
    return this.store.transaction((state) => { const interview = state.interviews.find((x) => x.id === id); if (!interview) throw new RecruitingNotFoundError(`未找到面试：${id}`); const interviewerId = required(input.interviewerId, '面试官'); const existing = state.interviewFeedback.find((x) => x.interviewId === id && x.interviewerId === interviewerId); if (existing?.status === 'locked') throw new RecruitingWorkflowError('FEEDBACK_LOCKED', '反馈已锁定，不能修改', 409); const feedback = existing ?? { id: randomUUID(), interviewId: id, interviewerId, status: 'draft' as const, ratings: {}, strengths: [], concerns: [] }; Object.assign(feedback, { status: 'submitted', ...(input.overallScore !== undefined ? { overallScore: Number(input.overallScore) } : {}), ...(input.recommendation ? { recommendation: input.recommendation } : {}), ratings: input.ratings ?? feedback.ratings, strengths: input.strengths ?? feedback.strengths, concerns: input.concerns ?? feedback.concerns, ...(input.notes !== undefined ? { notes: input.notes } : {}), submittedAt: LocalRecruitingStore.timestamp() }); if (!existing) { state.interviewFeedback.push(feedback); addEvent(state, { subjectType: 'interview', subjectId: id, action: 'feedback_submitted', actorId: interviewerId }) } else { addEvent(state, { subjectType: 'interview', subjectId: id, action: 'feedback_submitted', actorId: interviewerId }) }
      return feedback }) }

  async lockFeedback(id: string, interviewerId: string, actorId = 'user-demo'): Promise<InterviewFeedbackRecord> {
    if (this.repository) {
      const interview = await this.repository.getInterview(id)
      const resolvedInterviewer = required(interviewerId, '面试官')
      const feedback = await this.repository.getInterviewFeedbackForInterviewer(interview.id, resolvedInterviewer)
      if (!feedback) throw new RecruitingNotFoundError('未找到反馈')
      if (feedback.status !== 'submitted') throw new RecruitingWorkflowError('FEEDBACK_NOT_SUBMITTED', '只有已提交反馈才能锁定')
      const locked = await this.repository.updateInterviewFeedback(feedback.id, { status: 'locked', lockedAt: LocalRecruitingStore.timestamp() })
      await this.repository.appendWorkflowEvent({ subjectType: 'interview', subjectId: interview.id, action: 'feedback_locked', actorId: resolvedInterviewer })
      return this.mapRepositoryFeedback(locked)
    }
    return this.store.transaction((state) => { const feedback = state.interviewFeedback.find((x) => x.interviewId === id && x.interviewerId === required(interviewerId, '面试官')); if (!feedback) throw new RecruitingNotFoundError('未找到反馈'); if (feedback.status !== 'submitted') throw new RecruitingWorkflowError('FEEDBACK_NOT_SUBMITTED', '只有已提交反馈才能锁定'); feedback.status = 'locked'; feedback.lockedAt = LocalRecruitingStore.timestamp(); addEvent(state, { subjectType: 'interview', subjectId: id, action: 'feedback_locked', actorId: interviewerId }); return feedback }) }

  async concludeInterview(id: string, outcome: 'continue' | 'offer' | 'reject', actorId = 'user-demo'): Promise<InterviewRecord> {
    if (this.repository) {
      const interview = await this.repository.getInterview(id)
      const feedback = await this.repository.listInterviewFeedback(interview.id)
      if (!feedback.length || feedback.some((item) => item.status !== 'locked')) throw new RecruitingWorkflowError('INTERVIEW_FEEDBACK_INCOMPLETE', '所有面试反馈锁定后才能完成面试')
      const fromStatus = interview.status
      const updated = await this.repository.updateInterview(interview.id, { status: 'completed' })
      const nextStatus = outcome === 'offer' ? 'offer_approval' : outcome === 'reject' ? 'rejected' : 'interviewing'
      await this.repository.updateApplicationStatus(interview.applicationId, nextStatus, outcome === 'reject' ? '面试未通过' : undefined)
      await this.repository.appendWorkflowEvent({ subjectType: 'interview', subjectId: interview.id, action: 'conclude', fromStatus, toStatus: 'completed', actorId })
      return this.mapRepositoryInterview(updated)
    }
    return this.store.transaction((state) => { const interview = state.interviews.find((x) => x.id === id); if (!interview) throw new RecruitingNotFoundError(`未找到面试：${id}`); const application = applicationOrThrow(state, interview.applicationId); const feedback = state.interviewFeedback.filter((x) => x.interviewId === id); if (!feedback.length || feedback.some((x) => x.status !== 'locked')) throw new RecruitingWorkflowError('INTERVIEW_FEEDBACK_INCOMPLETE', '所有面试反馈锁定后才能完成面试'); interview.status = 'completed'; interview.updatedAt = LocalRecruitingStore.timestamp(); application.status = outcome === 'offer' ? 'offer_approval' : outcome === 'reject' ? 'rejected' : 'interviewing'; if (outcome === 'reject') application.rejectionReason = '面试未通过'; application.updatedAt = interview.updatedAt; addEvent(state, { subjectType: 'interview', subjectId: id, action: 'conclude', fromStatus: 'scheduled', toStatus: 'completed', actorId }); return interview }) }

  async getDashboardSummary(departmentId?: string): Promise<DashboardSummary> {
    const state = await this.stateView(departmentId)
    const applications = state.applications
    const count = (statuses: string[]) => applications.filter((item) => statuses.includes(item.status)).length
    const counts = [applications.length, count(['human_review', 'interviewing', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['interviewing', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['onboarding_archived'])]
    const funnel = ['收到申请', '通过筛选', '进入面试', '发出 Offer', '已入职'].map((stage, index) => ({ stage, count: counts[index]!, conversionRate: index === 0 ? null : counts[index - 1] ? Math.round(counts[index]! / counts[index - 1]! * 10000) / 100 : 0 }))
    const metrics: DashboardSummary['metrics'] = [
      { label: '收到申请', value: counts[0]!, detail: '全部申请记录' },
      { label: '通过筛选', value: counts[1]!, detail: (funnel[1]!.conversionRate ?? 0) + '% 转化率' },
      { label: '进入面试', value: counts[2]!, detail: (funnel[2]!.conversionRate ?? 0) + '% 转化率' },
      { label: '发出 Offer', value: counts[3]!, detail: (funnel[3]!.conversionRate ?? 0) + '% 转化率' },
    ]
    const pendingApprovals = state.recruitmentRequests
      .filter((request) => request.status === 'pending_approval')
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const pendingFeedback = state.interviews
      .filter((interview) => interview.status === 'scheduled' || interview.status === 'completed')
      .map((interview) => {
        const feedback = state.interviewFeedback.filter((item) => item.interviewId === interview.id)
        const feedbackStatus: InterviewFeedbackRecord['status'] | 'pending' = feedback.length && feedback.every((item) => item.status === 'locked') ? 'locked' : feedback.length ? feedback[0]!.status : 'pending'
        const application = state.applications.find((item) => item.id === interview.applicationId)
        const candidate = application ? state.candidates.find((item) => item.id === application.candidateId) : undefined
        const job = application ? state.jobs.find((item) => item.id === application.jobId) : undefined
        return { ...interview, application: application!, feedbackStatus, candidateName: candidate?.fullName || '未知候选人', jobTitle: job?.title || '未知岗位' }
      })
      .filter((interview) => interview.feedbackStatus !== 'locked')
      .sort((a, b) => (a.scheduledStartAt ?? a.updatedAt).localeCompare(b.scheduledStartAt ?? b.updatedAt))
    const failedTasks = state.analysisTasks
      .filter((task) => task.status === 'failed')
      .slice()
      .sort((a, b) => b.availableAt.localeCompare(a.availableAt))
    return { generatedAt: LocalRecruitingStore.timestamp(), metrics, funnel, pendingApprovals, pendingFeedback, failedTasks }
  }

  async getReports(departmentId?: string): Promise<RecruitingReport> {
    const state = await this.stateView(departmentId); const applications = state.applications
    const count = (statuses: string[]) => applications.filter((item) => statuses.includes(item.status)).length
    const counts = [applications.length, count(['human_review', 'interviewing', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['interviewing', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['onboarding_archived'])]
    const stages = ['收到申请', '通过筛选', '进入面试', '发出 Offer', '已入职']
    const funnel = stages.map((stage, index) => ({ stage, count: counts[index]!, conversionRate: index === 0 ? null : counts[index - 1] ? Math.round(counts[index]! / counts[index - 1]! * 10000) / 100 : 0 }))
    const statusStats: RecruitingReport['statusStats'] = []
    const statuses = (entity: string, values: string[], records: Array<{ status: string }>) => values.forEach((status) => { const value = records.filter((item) => item.status === status).length; if (value) statusStats.push({ entity, status, count: value }) })
    statuses('招聘需求', ['draft', 'pending_approval', 'approved', 'rejected', 'closed'], state.recruitmentRequests); statuses('岗位', ['draft', 'ready', 'published', 'paused', 'closed'], state.jobs); statuses('申请', ['pending_analysis','analysis_queued','human_review','interviewing','offer_approval','offer_sent','offer_accepted','onboarding_archived','rejected','offer_declined','offer_cancelled','offer_expired'], applications)
    const jobFilling = state.jobs.map((job) => { const filledCount = Math.max(job.filledCount, applications.filter((item) => item.jobId === job.id && item.status === 'onboarding_archived').length); return { jobId: job.id, code: job.code, title: job.title, headcount: job.headcount, filledCount, openCount: Math.max(job.headcount - filledCount, 0), fillRate: job.headcount ? Math.round(filledCount / job.headcount * 10000) / 100 : 0 } })
    const channelMap = new Map<string, RecruitingReport['channels'][number]>()
    applications.forEach((application) => { const candidate = state.candidates.find((item) => item.id === application.candidateId); const channel = application.source || candidate?.source || '未标注'; const row = channelMap.get(channel) ?? { channel, applications: 0, screened: 0, interviewed: 0, offers: 0, hired: 0, conversionRate: 0 }; row.applications++; if (['human_review', 'interviewing', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived'].includes(application.status)) row.screened++; if (['interviewing', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived'].includes(application.status)) row.interviewed++; if (['offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived'].includes(application.status)) row.offers++; if (application.status === 'onboarding_archived') row.hired++; row.conversionRate = Math.round(row.hired / row.applications * 10000) / 100; channelMap.set(channel, row) })
    const hiredApplications = applications.filter((item) => item.status === 'onboarding_archived')
    const hireDurations = hiredApplications.map((item) => Math.max(0, (Date.parse(item.updatedAt) - Date.parse(item.appliedAt)) / 86400000)).sort((a, b) => a - b)
    const recruitmentCycle = { averageDaysToHire: hireDurations.length ? Math.round(hireDurations.reduce((sum, value) => sum + value, 0) / hireDurations.length * 10) / 10 : null, medianDaysToHire: hireDurations.length ? Math.round(hireDurations[Math.floor(hireDurations.length / 2)]! * 10) / 10 : null, hiredCount: hiredApplications.length }
    const completedInterviewIds = new Set(state.interviews.filter((item) => item.status === 'completed').map((item) => item.id))
    const expectedFeedback = state.interviews.filter((item) => completedInterviewIds.has(item.id)).reduce((sum, item) => sum + item.participants.filter((participant) => participant.role === 'interviewer').length, 0)
    const lockedFeedback = state.interviewFeedback.filter((item) => completedInterviewIds.has(item.interviewId) && item.status === 'locked').length
    const feedbackCompletion = { expected: expectedFeedback, locked: lockedFeedback, completionRate: expectedFeedback ? Math.round(lockedFeedback / expectedFeedback * 10000) / 100 : null }
    const sentOffers = state.offers.filter((item) => ['sent', 'accepted', 'declined', 'expired'].includes(item.status)).length
    const acceptedOffers = state.offers.filter((item) => item.status === 'accepted').length
    const offerAcceptance = { sent: sentOffers, accepted: acceptedOffers, acceptanceRate: sentOffers ? Math.round(acceptedOffers / sentOffers * 10000) / 100 : null }
    return { generatedAt: LocalRecruitingStore.timestamp(), summary: [{ label: '收到申请', value: counts[0]!, detail: '全部申请记录' }, { label: '通过筛选', value: counts[1]!, detail: `${funnel[1]!.conversionRate}% 转化率` }, { label: '进入面试', value: counts[2]!, detail: `${funnel[2]!.conversionRate}% 转化率` }, { label: '发出 Offer', value: counts[3]!, detail: `${funnel[3]!.conversionRate}% 转化率` }], funnel, statusStats, jobFilling, channels: [...channelMap.values()].sort((a, b) => b.applications - a.applications), recruitmentCycle, feedbackCompletion, offerAcceptance }
  }

  async updateApplicationStatus(id: string, status: ApplicationRecord['status'], reason?: unknown, actorId = 'user-demo'): Promise<ApplicationRecord> {
    if (this.repository) {
      const current = await this.repository.getApplication(id)
      const allowed: Record<string, string[]> = { pending_analysis: ['analysis_queued', 'rejected'], analysis_queued: ['human_review', 'rejected'], human_review: ['interviewing', 'rejected'], interviewing: ['offer_approval', 'rejected'], offer_approval: ['offer_sent', 'offer_cancelled'], offer_sent: ['offer_accepted', 'offer_declined', 'offer_expired'], offer_accepted: ['onboarding_archived'] }
      if (!(allowed[current.status] ?? []).includes(status)) throw new RecruitingWorkflowError('APPLICATION_INVALID_TRANSITION', `申请状态 ${current.status} 不允许变更为 ${status}`)
      const normalizedReason = reason === undefined ? undefined : required(reason, '原因')
      const item = await this.repository.updateApplicationStatus(id, status, normalizedReason)
      return { id: item.id, code: item.businessId, candidateId: item.candidateId, jobId: item.jobId, status: item.status as ApplicationRecord['status'], ...(item.source ? { source: item.source } : {}), ...(item.rejectedReason ? { rejectionReason: item.rejectedReason } : {}), aiStatus: 'pending', appliedAt: item.appliedAt, updatedAt: item.updatedAt }
    }
    return this.store.transaction((state) => {
      const application = applicationOrThrow(state, id)
      const allowed: Record<ApplicationRecord['status'], ApplicationRecord['status'][]> = { pending_analysis: ['analysis_queued', 'rejected'], analysis_queued: ['human_review', 'rejected'], human_review: ['interviewing', 'rejected'], interviewing: ['offer_approval', 'rejected'], offer_approval: ['offer_sent', 'offer_cancelled'], offer_sent: ['offer_accepted', 'offer_declined', 'offer_expired'], offer_accepted: ['onboarding_archived'], onboarding_archived: [], rejected: [], offer_declined: [], offer_cancelled: [], offer_expired: [] }
      if (!allowed[application.status].includes(status)) throw new RecruitingWorkflowError('APPLICATION_INVALID_TRANSITION', `申请状态 ${application.status} 不允许变更为 ${status}`)
      if (['rejected','offer_declined','offer_cancelled'].includes(status)) required(reason, '原因')
      const previousStatus = application.status
      application.status = status; application.updatedAt = LocalRecruitingStore.timestamp()
      addEvent(state, { subjectType: 'application', subjectId: application.id, action: 'status_changed', fromStatus: previousStatus, toStatus: status, actorId, ...(reason ? { reason: clean(reason) } : {}) })
      return application
    })
  }

  async listResumes(candidateId?: string, applicationId?: string, departmentId?: string): Promise<ResumeRecord[]> {
    const ids = departmentId ? await this.scopedIds(departmentId) : undefined
    if (this.repository) { const items = (await this.repository.listResumes(candidateId, applicationId)).map((item) => ({ id: item.id, candidateId: item.candidateId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), storageKey: item.storageKey, originalFilename: item.originalFilename, mimeType: item.mimeType, sizeBytes: item.sizeBytes, contentHash: item.contentHash ?? '', scanStatus: item.scanStatus as ResumeRecord['scanStatus'], createdAt: item.createdAt })); return ids ? items.filter((item) => ids.applicationIds.has(item.applicationId ?? '') || ids.candidateIds.has(item.candidateId)) : items }
    const state = departmentId ? filterStateByDepartment(await this.store.read(), departmentId) : await this.store.read()
    return state.resumes.filter((item) => (!candidateId || item.candidateId === candidateId) && (!applicationId || item.applicationId === applicationId))
  }

  async createResume(input: CreateResumeInput, actorId = 'user-demo'): Promise<{ resume: ResumeRecord; task: AnalysisTaskRecord }> {
    const candidateId = required(input.candidateId, '候选人')
    const rawContent = required(input.content, '简历内容')
    const filename = required(input.originalFilename, '文件名')
    const mimeType = clean(input.mimeType) || 'application/octet-stream'
    const encoding = input.encoding === 'base64' ? 'base64' : 'utf8'
    const payload = encoding === 'base64' ? Buffer.from(rawContent, 'base64') : Buffer.from(rawContent, 'utf8')
    if (payload.length > 10 * 1024 * 1024) throw new RecruitingWorkflowError('RESUME_TOO_LARGE', '简历文件不能超过 10 MB', 413)
    if (this.repository) {
      await this.repository.getCandidate(candidateId)
      if (input.applicationId) {
        const application = await this.repository.getApplication(input.applicationId)
        if (application.candidateId !== candidateId) throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历与申请的候选人不一致')
      }
      const id = randomUUID(); const hash = contentHashBuffer(payload); const storageKey = `${id}.${resumeExtension(filename, mimeType)}`
      await mkdir(this.quarantineRoot, { recursive: true }); await writeFile(resolve(this.quarantineRoot, storageKey), payload)
      const saved = await this.repository.createResume({ id, candidateId, ...(input.applicationId ? { applicationId: input.applicationId } : {}), storageKey, originalFilename: filename, mimeType, sizeBytes: payload.length, contentHash: hash })
      const queued = await this.repository.createAnalysisTask({ resumeId: saved.id, ...(saved.applicationId ? { applicationId: saved.applicationId } : {}), idempotencyKey: `resume-analysis:${saved.id}:${hash}` })
      return { resume: { id: saved.id, candidateId: saved.candidateId, ...(saved.applicationId ? { applicationId: saved.applicationId } : {}), storageKey: saved.storageKey, originalFilename: saved.originalFilename, mimeType: saved.mimeType, sizeBytes: saved.sizeBytes, contentHash: saved.contentHash ?? hash, scanStatus: saved.scanStatus as ResumeRecord['scanStatus'], createdAt: saved.createdAt }, task: { id: queued.id, resumeId: queued.resumeId, ...(queued.applicationId ? { applicationId: queued.applicationId } : {}), status: queued.status as AnalysisTaskRecord['status'], attempts: queued.attempts, idempotencyKey: queued.idempotencyKey, availableAt: queued.availableAt, createdAt: queued.createdAt } }
    }
    return this.store.transaction(async (state) => {
      const candidate = candidateOrThrow(state, candidateId)
      let application: ApplicationRecord | undefined
      if (input.applicationId) {
        application = applicationOrThrow(state, input.applicationId)
        if (application.candidateId !== candidate.id) throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历与申请的候选人不一致')
      }
      const id = randomUUID()
      const hash = contentHashBuffer(payload)
      const ext = resumeExtension(filename, mimeType)
      const storageKey = `${id}.${ext}`
      await mkdir(this.quarantineRoot, { recursive: true })
      await writeFile(resolve(this.quarantineRoot, storageKey), payload)
      const timestamp = LocalRecruitingStore.timestamp()
      const resume: ResumeRecord = { id, candidateId: candidate.id, ...(application ? { applicationId: application.id } : {}), storageKey, originalFilename: filename, mimeType, sizeBytes: payload.length, contentHash: hash, scanStatus: 'quarantined', createdAt: timestamp }
      const task: AnalysisTaskRecord = { id: randomUUID(), resumeId: resume.id, ...(application ? { applicationId: application.id } : {}), status: 'queued', attempts: 0, idempotencyKey: `resume-analysis:${resume.id}:${hash}`, availableAt: timestamp, createdAt: timestamp }
      state.resumes.push(resume)
      state.analysisTasks.push(task)
      return { resume, task }
    })
  }

  async getAnalysisTask(id: string): Promise<AnalysisTaskRecord> {
    if (this.repository) {
      try { return mapRepositoryAnalysisTask(await this.repository.getAnalysisTask(id)) } catch (error) { if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'REPOSITORY_NOT_FOUND') throw new RecruitingNotFoundError(`未找到分析任务：${id}`); throw error }
    }
    const state = await this.store.read()
    const task = state.analysisTasks.find((item) => item.id === id)
    if (!task) throw new RecruitingNotFoundError(`未找到分析任务：${id}`)
    return task
  }

  async listAnalysisTasks(status?: string): Promise<AnalysisTaskRecord[]> {
    if (this.repository) return (await this.repository.listAnalysisTasks(status)).map(mapRepositoryAnalysisTask)
    const state = await this.store.read()
    return state.analysisTasks.filter((item) => !status || item.status === status)
  }

  async listAnalysisResults(resumeId?: string, applicationId?: string): Promise<AnalysisResultRecord[]> {
    if (this.repository) return (await this.repository.listAnalysisResults(resumeId, applicationId)).map(mapRepositoryAnalysisResult)
    const state = await this.store.read()
    return state.analysisResults.filter((item) => (!resumeId || item.resumeId === resumeId) && (!applicationId || item.applicationId === applicationId))
  }

  async getAnalysisResult(taskId: string): Promise<AnalysisResultRecord> {
    if (this.repository) {
      try { return mapRepositoryAnalysisResult(await this.repository.getAnalysisResultByTask(taskId)) } catch (error) { if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'REPOSITORY_NOT_FOUND') throw new RecruitingNotFoundError(`未找到分析结果：${taskId}`); throw error }
    }
    const state = await this.store.read()
    const result = state.analysisResults.find((item) => item.analysisTaskId === taskId)
    if (!result) throw new RecruitingNotFoundError(`未找到分析结果：${taskId}`)
    return result
  }

  async getAnalysisResultById(id: string): Promise<AnalysisResultRecord> {
    if (this.repository) {
      try { return mapRepositoryAnalysisResult(await this.repository.getAnalysisResult(id)) } catch (error) { if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'REPOSITORY_NOT_FOUND') throw new RecruitingNotFoundError(`未找到分析结果：${id}`); throw error }
    }
    const state = await this.store.read()
    const result = state.analysisResults.find((item) => item.id === id)
    if (!result) throw new RecruitingNotFoundError(`未找到分析结果：${id}`)
    return result
  }

  async reviewAnalysisResult(id: string, input: { status: AnalysisResultRecord['humanReviewStatus']; comment?: string; reviewedBy?: string }, actorId = 'user-demo'): Promise<AnalysisResultRecord> {
    if (this.repository) {
      if (!['accepted', 'needs_correction'].includes(input.status)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '复核状态必须是 accepted 或 needs_correction', 400)
      const current = await this.repository.getAnalysisResult(id)
      const report = current.result as { humanReview?: Record<string, unknown> }
      report.humanReview = { ...(report.humanReview ?? {}), status: input.status, ...(input.comment ? { comment: clean(input.comment) } : {}), reviewedBy: clean(input.reviewedBy) || actorId, reviewedAt: new Date().toISOString() }
      return mapRepositoryAnalysisResult(await this.repository.reviewAnalysisResult(id, input.status, current.result))
    }
    return this.store.transaction((state) => {
      const result = state.analysisResults.find((item) => item.id === id)
      if (!result) throw new RecruitingNotFoundError(`未找到分析结果：${id}`)
      if (!['accepted', 'needs_correction'].includes(input.status)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '复核状态必须是 accepted 或 needs_correction', 400)
      result.humanReviewStatus = input.status
      const report = result.result as { humanReview?: Record<string, unknown> }
      report.humanReview = { ...(report.humanReview ?? {}), status: input.status, ...(input.comment ? { comment: clean(input.comment) } : {}), reviewedBy: clean(input.reviewedBy) || actorId, reviewedAt: LocalRecruitingStore.timestamp() }
      return result
    })
  }

  async processAnalysisTask(taskId: string): Promise<AnalysisTaskRecord> {
    if (this.repository) {
      let task: RepositoryAnalysisTask
      try { task = await this.repository.getAnalysisTask(taskId) } catch (error) { if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'REPOSITORY_NOT_FOUND') throw new RecruitingNotFoundError(`未找到分析任务：${taskId}`); throw error }
      if (task.status === 'completed') return mapRepositoryAnalysisTask(task)
      if (task.status === 'processing') throw new RecruitingWorkflowError('ANALYSIS_TASK_BUSY', '分析任务正在处理中', 409)
      const startedAt = new Date().toISOString()
      const processing = await this.repository.updateAnalysisTask(taskId, { status: 'processing', attempts: task.attempts + 1, startedAt, lastError: null })
      try {
        const resume = await this.repository.getResume(processing.resumeId)
        const application = processing.applicationId ? await this.repository.getApplication(processing.applicationId) : undefined
        const job = application ? await this.repository.getJob(application.jobId) : undefined
        const content = await readFile(resolve(this.quarantineRoot, resume.storageKey), 'utf8')
        const report = buildRuleBasedReport({ resume: { documentId: resume.id, fileName: resume.originalFilename, mimeType: resume.mimeType, text: content, source: 'upload' }, job: buildJobRequirements(job ? mapRepositoryJobForAnalysis(job) : undefined, job?.id) as Parameters<typeof buildRuleBasedReport>[0]['job'], subject: { resumeId: resume.id, ...(processing.applicationId ? { applicationId: processing.applicationId } : {}), ...(job ? { jobId: job.id } : {}) } })
        await this.repository.createAnalysisResult({ analysisTaskId: processing.id, resumeId: resume.id, ...(processing.applicationId ? { applicationId: processing.applicationId } : {}), result: report as unknown as Record<string, unknown>, analyzerVersion: 'resume-intelligence-rule-based-0.1.0', inputHash: resume.contentHash })
        return mapRepositoryAnalysisTask(await this.repository.updateAnalysisTask(taskId, { status: 'completed', completedAt: new Date().toISOString(), lastError: null }))
      } catch (error) {
        return mapRepositoryAnalysisTask(await this.repository.updateAnalysisTask(taskId, { status: 'failed', lastError: error instanceof Error ? error.message : '分析失败' }))
      }
    }
    return this.store.transaction(async (state) => {
      const task = taskOrThrow(state, taskId)
      if (task.status === 'completed') return task
      if (task.status === 'processing') throw new RecruitingWorkflowError('ANALYSIS_TASK_BUSY', '分析任务正在处理中', 409)
      const resume = resumeOrThrow(state, task.resumeId)
      const application = task.applicationId ? applicationOrThrow(state, task.applicationId) : undefined
      const job = application ? jobOrThrow(state, application.jobId) : undefined
      task.status = 'processing'; task.attempts += 1; task.startedAt = LocalRecruitingStore.timestamp(); delete task.lastError
      try {
        const content = await readFile(resolve(this.quarantineRoot, resume.storageKey), 'utf8')
        resume.scanStatus = 'local_unscanned'
        const report = buildRuleBasedReport({ resume: { documentId: resume.id, fileName: resume.originalFilename, mimeType: resume.mimeType, text: content, source: 'upload' }, job: buildJobRequirements(job, job?.id) as Parameters<typeof buildRuleBasedReport>[0]['job'], subject: { resumeId: resume.id, ...(task.applicationId ? { applicationId: task.applicationId } : {}), ...(job ? { jobId: job.id } : {}) } })
        const result: AnalysisResultRecord = { id: randomUUID(), analysisTaskId: task.id, resumeId: resume.id, ...(task.applicationId ? { applicationId: task.applicationId } : {}), result: report as unknown as Record<string, unknown>, analyzerVersion: 'resume-intelligence-rule-based-0.1.0', inputHash: resume.contentHash, humanReviewStatus: 'pending', createdAt: LocalRecruitingStore.timestamp() }
        state.analysisResults = state.analysisResults.filter((item) => item.analysisTaskId !== task.id)
        state.analysisResults.push(result)
        if (application) {
          const score = (result.result.assessment as { score?: number } | undefined)?.score
          application.aiStatus = 'completed'
          if (typeof score === 'number') application.score = score
          application.updatedAt = LocalRecruitingStore.timestamp()
        }
        task.status = 'completed'; task.completedAt = LocalRecruitingStore.timestamp()
      } catch (error) {
        task.status = 'failed'; task.lastError = error instanceof Error ? error.message : '分析失败'
      }
      return task
    })
  }
  async listOffers(status?: string, departmentId?: string): Promise<OfferRecord[]> { const state = await this.stateView(departmentId); return state.offers.filter(x=>!status||x.status===status) }
  async getOffer(id:string): Promise<OfferRecord & { versions: OfferVersionRecord[]; onboarding?: OnboardingRecord }> { const state=await this.stateView(); const offer=state.offers.find(x=>x.id===id) ?? state.offers.find(x=>x.code===id); if(!offer) throw new RecruitingNotFoundError(`未找到 Offer：${id}`); const onboarding=state.onboarding.find(x=>x.offerId===offer.id); return {...offer,versions:state.offerVersions.filter(x=>x.offerId===offer.id),...(onboarding?{onboarding}: {})} }
  async listOnboarding(departmentId?: string): Promise<OnboardingRecord[]> { const state = await this.stateView(departmentId); return state.onboarding }
  async getOnboarding(id: string): Promise<OnboardingRecord> { const state = await this.stateView(); const item = state.onboarding.find((x) => x.id === id); if (!item) throw new RecruitingNotFoundError(`未找到入职归档：${id}`); return item }
  async updateOnboarding(id: string, input: { plannedStartDate?: string; notes?: string }, actorId = 'user-demo'): Promise<OnboardingRecord> {
    if (this.repository) {
      const current = await this.repository.getOnboarding(id)
      if (current.status === 'cancelled' || current.status === 'completed') throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '已取消或已归档记录不能编辑')
      const patched = await this.repository.updateOnboarding(current.id, { ...(input.plannedStartDate !== undefined ? { plannedStartDate: clean(input.plannedStartDate) } : {}), ...(input.notes !== undefined ? { notes: clean(input.notes) } : {}) })
      await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: current.id, action: 'update', actorId })
      return this.mapRepositoryOnboarding(patched)
    }
    return this.store.transaction((state) => { const item = state.onboarding.find((x) => x.id === id); if (!item) throw new RecruitingNotFoundError(`未找到入职归档：${id}`); if (item.status === 'cancelled' || item.status === 'completed') throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '已取消或已归档记录不能编辑'); if (input.plannedStartDate !== undefined) item.plannedStartDate = clean(input.plannedStartDate); if (input.notes !== undefined) item.notes = clean(input.notes); item.updatedAt = LocalRecruitingStore.timestamp(); addEvent(state, { subjectType: 'onboarding', subjectId: item.id, action: 'update', actorId }); return item }) }
  async onboardingAction(id: string, action: string, reason?: unknown, actorId = 'user-demo'): Promise<OnboardingRecord> {
    if (this.repository) {
      const current = await this.repository.getOnboarding(id)
      const from = current.status
      const allowed: Record<string, string[]> = { schedule: ['pending', 'cancelled'], complete: ['pending', 'scheduled'], cancel: ['pending', 'scheduled'] }
      if (!allowed[action] || !allowed[action]!.includes(from)) throw new RecruitingWorkflowError('ONBOARDING_INVALID_TRANSITION', `入职归档状态 ${from} 不允许执行 ${action}`)
      if (action === 'cancel') required(reason, '取消原因')
      const next: Record<string, OnboardingRecord['status']> = { schedule: 'scheduled', complete: 'completed', cancel: 'cancelled' }
      const timestamp = LocalRecruitingStore.timestamp()
      const patched = await this.repository.updateOnboarding(current.id, { status: next[action]!, ...(action === 'complete' ? { archivedAt: timestamp } : {}) })
      if (action === 'complete') {
        const application = await this.repository.getApplication(current.applicationId)
        if (application.status !== 'onboarding_archived') await this.repository.updateApplicationStatus(application.id, 'onboarding_archived')
        await this.repository.appendWorkflowEvent({ subjectType: 'application', subjectId: application.id, action: 'status_changed', fromStatus: application.status, toStatus: 'onboarding_archived', actorId })
      }
      await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: current.id, action, fromStatus: from, toStatus: patched.status, actorId, ...(reason ? { reason: clean(reason) } : {}) })
      return this.mapRepositoryOnboarding(patched)
    }
    return this.store.transaction((state) => { const item = state.onboarding.find((x) => x.id === id); if (!item) throw new RecruitingNotFoundError(`未找到入职归档：${id}`); const from = item.status; const allowed: Record<string, string[]> = { schedule: ['pending', 'cancelled'], complete: ['pending', 'scheduled'], cancel: ['pending', 'scheduled'] }; if (!allowed[action] || !allowed[action]!.includes(from)) throw new RecruitingWorkflowError('ONBOARDING_INVALID_TRANSITION', `入职归档状态 ${from} 不允许执行 ${action}`); if (action === 'cancel') required(reason, '取消原因'); const next: Record<string, OnboardingRecord['status']> = { schedule: 'scheduled', complete: 'completed', cancel: 'cancelled' }; item.status = next[action]!; const now = LocalRecruitingStore.timestamp(); if (action === 'complete') { item.archivedAt = now; const app = state.applications.find((x) => x.id === item.applicationId); if (app) { app.status = 'onboarding_archived'; app.updatedAt = now; addEvent(state, { subjectType: 'application', subjectId: app.id, action: 'status_changed', fromStatus: 'offer_accepted', toStatus: 'onboarding_archived', actorId }); } } item.updatedAt = now; addEvent(state, { subjectType: 'onboarding', subjectId: item.id, action, fromStatus: from, toStatus: item.status, actorId, ...(reason ? { reason: clean(reason) } : {}) }); return item }) }
  async createOffer(input: CreateOfferInput, actorId = 'user-demo'): Promise<OfferRecord> {
    if (this.repository) {
      const application = await this.repository.getApplication(required(input.applicationId, '申请'))
      if (!['interviewing', 'offer_approval'].includes(application.status)) throw new RecruitingWorkflowError('OFFER_APPLICATION_INVALID', '当前申请不允许创建 Offer')
      const offer = await this.repository.createOffer({ applicationId: application.id, status: 'draft', approvalStatus: 'pending' })
      const compensation = { baseSalary: input.baseSalary, ...(input.bonus ? { bonus: input.bonus } : {}), ...(input.equity ? { equity: input.equity } : {}) }
      const version = await this.repository.createOfferVersion({ offerId: offer.id, positionTitle: required(input.positionTitle, '职位名称'), departmentId: required(input.departmentId, '部门'), employmentType: required(input.employmentType, '用工类型'), startDate: input.startDate ?? null, compensation: compensation as unknown as Record<string, unknown>, benefits: input.benefits ?? [], content: required(input.content, 'Offer 内容') })
      const updated = await this.repository.updateOffer(offer.id, { currentVersionId: version.id })
      await this.repository.appendWorkflowEvent({ subjectType: 'offer', subjectId: offer.id, action: 'create', toStatus: 'draft', actorId })
      return this.mapRepositoryOffer(updated)
    }
    return this.store.transaction(state=>{ const app=applicationOrThrow(state,required(input.applicationId,'申请')); if(!['interviewing','offer_approval'].includes(app.status)) throw new RecruitingWorkflowError('OFFER_APPLICATION_INVALID','当前申请不允许创建 Offer'); const t=LocalRecruitingStore.timestamp(); const offer:OfferRecord={id:randomUUID(),code:`OFF-${state.nextOfferNumber++}`,applicationId:app.id,status:'draft',approval:{status:'pending',approver:'待审批'},version:1,createdAt:t,updatedAt:t}; const v:OfferVersionRecord={id:randomUUID(),offerId:offer.id,version:1,positionTitle:required(input.positionTitle,'职位名称'),departmentId:required(input.departmentId,'部门'),employmentType:required(input.employmentType,'用工类型'),...(input.startDate?{startDate:input.startDate}:{}),compensation:{baseSalary:input.baseSalary},benefits:input.benefits??[],content:required(input.content,'Offer 内容'),createdAt:t}; state.offers.push(offer); state.offerVersions.push(v); offer.currentVersionId=v.id; addEvent(state,{subjectType:"offer",subjectId:offer.id,action:"create",toStatus:"draft",actorId}); return offer }) }
  async updateOffer(id:string,input:Partial<CreateOfferInput>, actorId = 'user-demo'):Promise<OfferRecord>{
    if (this.repository) {
      const offer = await this.repository.getOffer(id)
      if (offer.status !== 'draft') throw new RecruitingWorkflowError('OFFER_IMMUTABLE', '只有草稿 Offer 可以修改')
      const versions = await this.repository.listOfferVersions(offer.id)
      const previous = versions[0]
      if (!previous) throw new RecruitingNotFoundError('Offer 还没有版本记录')
      const priorCompensation = previous.compensation as { baseSalary?: { amount: number; currency: string }; bonus?: { amount: number; currency: string }; equity?: string }
      const startDate = input.startDate !== undefined ? input.startDate : previous.startDate
      const equity = input.equity !== undefined ? input.equity : priorCompensation.equity
      const bonus = input.bonus !== undefined ? input.bonus : priorCompensation.bonus
      const baseSalary = input.baseSalary ?? priorCompensation.baseSalary
      if (!baseSalary) throw new RecruitingWorkflowError('OFFER_BASE_SALARY_REQUIRED', 'Offer 缺少基本薪资', 400)
      const compensation = { baseSalary, ...(bonus ? { bonus } : {}), ...(equity ? { equity } : {}) }
      const version = await this.repository.createOfferVersion({ offerId: offer.id, positionTitle: input.positionTitle?.trim() || previous.positionTitle, departmentId: input.departmentId?.trim() || previous.departmentId, employmentType: input.employmentType || previous.employmentType, startDate: startDate ?? null, compensation: compensation as unknown as Record<string, unknown>, benefits: input.benefits ?? previous.benefits, content: input.content?.trim() || previous.content })
      const updated = await this.repository.updateOffer(offer.id, { currentVersionId: version.id, version: offer.version + 1 })
      await this.repository.appendWorkflowEvent({ subjectType: 'offer', subjectId: offer.id, action: 'revise', fromStatus: 'draft', toStatus: 'draft', actorId })
      return this.mapRepositoryOffer(updated)
    }
    return this.store.transaction(state=>{const o=state.offers.find(x=>x.id===id);if(!o)throw new RecruitingNotFoundError(`未找到 Offer：${id}`);if(o.status!=='draft')throw new RecruitingWorkflowError('OFFER_IMMUTABLE','只有草稿 Offer 可以修改');const old=state.offerVersions.filter(x=>x.offerId===id).sort((a,b)=>b.version-a.version)[0]!;const startDate=input.startDate!==undefined?input.startDate:old.startDate;const equity=input.equity!==undefined?input.equity:old.compensation.equity;const bonus=input.bonus!==undefined?input.bonus:old.compensation.bonus;const baseSalary=input.baseSalary??old.compensation.baseSalary;const compensation:{baseSalary:{amount:number;currency:string};bonus?:{amount:number;currency:string};equity?:string}={baseSalary,...(bonus?{bonus}:{}),...(equity?{equity}:{})};const v:OfferVersionRecord={...old,id:randomUUID(),version:old.version+1,positionTitle:input.positionTitle?.trim()||old.positionTitle,departmentId:input.departmentId?.trim()||old.departmentId,employmentType:input.employmentType||old.employmentType,...(startDate?{startDate}:{}),compensation,benefits:input.benefits??old.benefits,content:input.content?.trim()||old.content,createdAt:LocalRecruitingStore.timestamp()};state.offerVersions.push(v);o.currentVersionId=v.id;o.version++;o.updatedAt=LocalRecruitingStore.timestamp();addEvent(state,{subjectType:'offer',subjectId:o.id,action:'revise',fromStatus:'draft',toStatus:'draft',actorId});return o})}
  async offerAction(id:string,action:string,reason?:unknown,actorId = 'user-demo'):Promise<OfferRecord|OnboardingRecord>{
    if (this.repository) {
      const offer = await this.repository.getOffer(id)
      const from = offer.status
      const timestamp = LocalRecruitingStore.timestamp()
      if (action === 'archive_onboarding') {
        if (from !== 'accepted') throw new RecruitingWorkflowError('OFFER_INVALID_TRANSITION', `Offer 状态 ${from} 不允许执行 ${action}`)
        const record = await this.repository.createOnboarding({ applicationId: offer.applicationId, offerId: offer.id, status: 'pending' })
        await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: record.id, action, fromStatus: 'accepted', toStatus: 'pending', actorId })
        return this.mapRepositoryOnboarding(record)
      }
      const allowed: Record<string, string[]> = { submit_approval: ['draft'], reject: ['pending_approval'], approve: ['pending_approval'], send: ['approved'], accept: ['sent'], decline: ['sent'], expire: ['sent'], cancel: ['draft', 'pending_approval', 'approved', 'sent'] }
      if (!allowed[action] || !allowed[action]!.includes(from)) throw new RecruitingWorkflowError('OFFER_INVALID_TRANSITION', `Offer 状态 ${from} 不允许执行 ${action}`)
      if (['decline', 'cancel', 'reject'].includes(action)) required(reason, '原因')
      const next: Record<string, string> = { submit_approval: 'pending_approval', approve: 'approved', send: 'sent', accept: 'accepted', decline: 'declined', cancel: 'cancelled', reject: 'draft', expire: 'expired' }
      const patch: { status: string; version: number; approvalStatus?: string; sentAt?: string; respondedAt?: string; expiresAt?: string } = { status: next[action]!, version: offer.version + 1 }
      if (action === 'submit_approval') patch.approvalStatus = 'pending'
      else if (action === 'approve') patch.approvalStatus = 'approved'
      else if (action === 'reject') patch.approvalStatus = 'rejected'
      else if (action === 'cancel') patch.approvalStatus = 'cancelled'
      if (action === 'send') patch.sentAt = timestamp
      if (action === 'accept' || action === 'decline') patch.respondedAt = timestamp
      if (action === 'expire') patch.expiresAt = offer.expiresAt ?? timestamp
      const updated = await this.repository.updateOffer(offer.id, patch)
      await this.repository.appendWorkflowEvent({ subjectType: 'offer', subjectId: offer.id, action, fromStatus: from, toStatus: updated.status, actorId, ...(reason ? { reason: clean(reason) } : {}) })
      return this.mapRepositoryOffer(updated)
    }
    return this.store.transaction(state=>{const o=state.offers.find(x=>x.id===id);if(!o)throw new RecruitingNotFoundError(`未找到 Offer：${id}`);const t=LocalRecruitingStore.timestamp();const from=o.status;const next:Record<string,string>={submit_approval:'pending_approval',approve:'approved',send:'sent',accept:'accepted',decline:'declined',cancel:'cancelled',reject:'draft',expire:'expired'};if(action==='archive_onboarding'){if(from!=='accepted')throw new RecruitingWorkflowError('OFFER_INVALID_TRANSITION',`Offer 状态 ${from} 不允许执行 ${action}`);const r:OnboardingRecord={id:randomUUID(),applicationId:o.applicationId,offerId:o.id,status:'pending',createdAt:t,updatedAt:t};state.onboarding.push(r);addEvent(state,{subjectType:'onboarding',subjectId:r.id,action,fromStatus:'accepted',toStatus:'pending',actorId});return r}const allowed:Record<string,string[]>={submit_approval:['draft'],reject:['pending_approval'],approve:['pending_approval'],send:['approved'],accept:['sent'],decline:['sent'],expire:['sent'],cancel:['draft','pending_approval','approved','sent']};if(!allowed[action]||!allowed[action]!.includes(from))throw new RecruitingWorkflowError('OFFER_INVALID_TRANSITION',`Offer 状态 ${from} 不允许执行 ${action}`);if(['decline','cancel','reject'].includes(action))required(reason,'原因');o.status=next[action] as OfferRecord['status'];if(action==='submit_approval')o.approval={status:'pending',approver:'待审批'};else if(action==='approve')o.approval={status:'approved',approver:'当前审批人',actedAt:t};else if(action==='reject')o.approval={status:'rejected',approver:'当前审批人',comment:clean(reason),actedAt:t};else if(action==='cancel')o.approval.status='cancelled';if(action==='accept'||action==='decline')o.respondedAt=t;if(action==='expire')o.expiresAt=o.expiresAt??t;o.version++;o.updatedAt=t;addEvent(state,{subjectType:'offer',subjectId:o.id,action,fromStatus:from,toStatus:o.status,actorId,...(reason?{reason:clean(reason)}:{})});return o})}
  async listWorkflowEvents(filter?: { subjectType?: WorkflowEventRecord['subjectType']; limit?: number }): Promise<Array<WorkflowEventRecord & { subjectLabel: string }>> {
    const state = await this.stateView()
    const limit = Math.max(1, Math.min(filter?.limit ?? 200, 500))
    const subjectType = filter?.subjectType
    return state.workflowEvents
      .filter((event) => !subjectType || event.subjectType === subjectType)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((event) => {
        const request = state.recruitmentRequests.find((item) => item.id === event.subjectId)
        const job = state.jobs.find((item) => item.id === event.subjectId)
        const offer = state.offers.find((item) => item.id === event.subjectId)
        const onboarding = state.onboarding.find((item) => item.id === event.subjectId)
        const candidate = state.candidates.find((item) => item.id === event.subjectId)
        const application = state.applications.find((item) => item.id === event.subjectId)
        const interview = state.interviews.find((item) => item.id === event.subjectId)
        const label = event.subjectType === 'recruitment_request' ? (request?.code || request?.title) : event.subjectType === 'job' ? (job?.code || job?.title) : event.subjectType === 'offer' ? (offer?.code || offer?.id) : event.subjectType === 'onboarding' ? (onboarding?.id || '入职归档') : event.subjectType === 'candidate' ? (candidate?.fullName || candidate?.code) : event.subjectType === 'application' ? (application?.code || application?.id) : event.subjectType === 'interview' ? (interview?.code || interview?.title) : event.subjectId
        return { ...event, subjectLabel: label || event.subjectId }
      })
  }
}




