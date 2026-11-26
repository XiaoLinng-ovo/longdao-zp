import { createHash, randomUUID } from 'node:crypto'
import { interviewOutcome, validateInterviewOutcome, type InterviewResult } from './interview-result.js'
import { resolve } from 'node:path'
import { LocalRecruitingStore } from './store.js'
import { filterReportState, reportChannel, reportFilterOptions, type ReportFilters } from './report-filters.js'
import { normalizeOfferTemplateFields, type OfferTemplateFields } from './offer-template-fields.js'
import { isLocalOfferEligible } from './offer-eligibility.js'
import { createRecruitingStore } from './postgres-store.js'
import { NormalizedRecruitingRepository } from './repositories/postgres-repository.js'
import type { JobRelatedRecord } from './repositories/types.js'
import type { PreparedResumeUpload, ResumeUploadCheckpoint } from './resume-upload.js'
import { createDatabasePool } from '../db/connection.js'
import type { AnalysisTaskRecord as RepositoryAnalysisTask, AnalysisResultRecord as RepositoryAnalysisResult, JobRecord as RepositoryJob, JobSpecVersionDbRecord as RepositoryJobSpecVersion, JobDescriptionVersionDbRecord as RepositoryJobDescriptionVersion, InterviewDbRecord as RepositoryInterview, InterviewFeedbackDbRecord as RepositoryInterviewFeedback, OfferDbRecord as RepositoryOffer, OnboardingDbRecord as RepositoryOnboarding, OnboardingTaskDbRecord as RepositoryOnboardingTask, OnboardingMaterialDbRecord as RepositoryOnboardingMaterial, OnboardingReminderDbRecord as RepositoryOnboardingReminder, OnboardingIntegrationDbRecord as RepositoryOnboardingIntegration, OfferTemplateDbRecord as RepositoryOfferTemplate } from './repositories/types.js'
import type { AnalysisResultRecord, AnalysisTaskRecord, ApplicationRecord, ApprovalAuditRecord, ApprovalInstanceRecord, ApprovalRecord, ApprovalStepRecord, CandidateRecord, JobDescriptionRecord, JobDescriptionVersionRecord, JobRecord, JobSpecRecord, JobSpecVersionRecord, RecruitingStoreState, RecruitmentRequestRecord, ResumeRecord, WorkflowEventRecord, InterviewRecord, InterviewFeedbackRecord, InterviewType, OfferRecord, OfferVersionRecord, OnboardingRecord, OnboardingTaskRecord, OnboardingTaskCategory, OnboardingTaskStatus, OnboardingTaskOwnerRole, OnboardingMaterialRecord, OnboardingMaterialStatus, OnboardingReminderRecord, OnboardingIntegrationRecord, OnboardingIntegrationProvider, OnboardingIntegrationStatus, OnboardingWorkbenchItem, OnboardingReport, InterviewParticipant } from './types.js'
import { RecruitingWorkflowError, transitionJob, transitionRequest } from './workflow.js'
import { transitionOfferWorkflow } from './offer-workflow.js'
import { lastOfferEmail, offerConfirmation } from './offer-confirmation.js'
import { validateResumeUpload } from './file-security.js'
import { extractResumeText } from './resume-text-extractor.js'
import { bindBillingEnv } from '@smartrecruit-pro/enterprise-ai'
import { createHttpOcrClient, meteredOcrClient } from './ocr-client.js'
import mammoth from 'mammoth'
import { resumeExperienceView } from './resume-experience-view.js'
import { createObjectStorageFromEnv, type ObjectStorage } from '@smartrecruit-pro/object-storage'
import { anonymizeText, buildRuleBasedReport, buildJobAnalysisContext, buildJobRequirements as normalizeJobRequirements, isResumePlaceholderName, isResumeNameWithAppendedFields, normalizeResumeCandidateName } from '@smartrecruit-pro/resume-intelligence'
import { initialResumeScanStatus } from './resume-scan-policy.js'
import { latestAnalysisByKey } from './latest-analysis.js'
import { buildDashboardTodos, type DashboardTodo } from './dashboard-todos.js'
import { dashboardActivity, parseDashboardPeriod, type DashboardActivity } from './dashboard-period.js'
import type { DashboardInterviewReview } from '../interviews/question-sheet-repository.js'
import { interviewProgressByApplication } from './interview-progress.js'
import { normalizeInterviewParticipants, type AssignedParticipant } from './interview-responsibilities.js'
import { prepareInterviewScheduleUpdate } from './interview-schedule.js'
import { applyResumeReview, resumeScoreSummary, type ResumeReviewInput } from './resume-scoring.js'
import { buildOnboardingReminderSchedule, buildOnboardingReport, buildOnboardingWorkbenchItem, isClockTime, isIsoDate, isOnboardingEditable, missingSchedulingFields, onboardingCancellationReasons, onboardingNoShowReasons } from './onboarding-workbench.js'

type RuleReportBuilder = (input: { resume: { documentId: string; fileName: string; mimeType: string; text: string; source: 'upload' }; job: ReturnType<typeof buildJobRequirements>; subject: { resumeId: string; applicationId?: string; jobId?: string } }) => Record<string, unknown>

type CreateRecruitmentRequestInput = {
  title: string; departmentId: string; hiringManagerId?: string; headcount: number; employmentType: string; workMode: string; location?: string;
  salaryRange?: { min?: { amount: number; currency: string }; max?: { amount: number; currency: string } }; justification: string
}
type UpdateRecruitmentRequestInput = Partial<CreateRecruitmentRequestInput>
type CreateJobInput = { title: string; departmentId: string; hiringManagerId?: string; recruitmentRequestId?: string; headcount: number; employmentType: string; workMode: string; location?: string }
type UpdateJobInput = Partial<Omit<CreateJobInput, 'recruitmentRequestId'>>
type CreateJobSpecInput = { title: string; summary: string; responsibilities: string[]; requirements: Array<{ label: string; description: string; required: boolean; weight?: number }>; skills: string[]; generatedBy?: 'ai' | 'local_fallback' | 'human' }
type CreateCandidateInput = { fullName: string; email?: string; phone?: string; source?: string; tags?: string[] }
type UpdateCandidateInput = Partial<Omit<CreateCandidateInput, 'fullName'>> & { fullName?: string; status?: CandidateRecord['status']; reason?: string }
type CreateApplicationInput = { candidateId: string; jobId: string; source?: string }
type UpdateOnboardingInput = {
  plannedStartDate?: string | null
  plannedStartTime?: string | null
  reportingMode?: OnboardingRecord['reportingMode'] | null
  reportingLocation?: string | null
  reportingContactName?: string | null
  reportingContactPhone?: string | null
  hrOwnerName?: string | null
  hiringManagerName?: string | null
  workCity?: string | null
  officeLocation?: string | null
  riskNotes?: string | null
  notes?: string | null
}
type CreateOnboardingTaskInput = { title: string; category: OnboardingTaskCategory; isRequired?: boolean; ownerRole?: OnboardingTaskOwnerRole | null; templateKey?: string | null; ownerName?: string | null; dueDate?: string | null; notes?: string | null }
type UpdateOnboardingTaskInput = Partial<CreateOnboardingTaskInput> & { status?: OnboardingTaskStatus; blockedReason?: string | null }
type CreateOnboardingMaterialInput = { code: string; label: string; isRequired?: boolean; notes?: string }
type UpdateOnboardingMaterialInput = { status?: OnboardingMaterialStatus; isRequired?: boolean; notes?: string }
type UpdateOnboardingIntegrationInput = { status?: OnboardingIntegrationStatus; externalReference?: string | null; lastError?: string | null }
type OnboardingActionResult = { reasonCode?: string; notes?: string; reason?: string }
const defaultOnboardingTasks = (): Array<Pick<OnboardingTaskRecord, 'title' | 'category' | 'ownerName' | 'isRequired' | 'ownerRole' | 'templateKey'>> => [
  { title: '核对劳动合同与入职材料', category: 'hr', ownerName: 'HR', isRequired: true, ownerRole: 'hr_admin', templateKey: 'hr_documents' },
  { title: '建立员工档案并录入 HRIS', category: 'hr', ownerName: 'HR', isRequired: true, ownerRole: 'hr_admin', templateKey: 'hr_employee_record' },
  { title: '开通账号与工作邮箱', category: 'it', ownerName: 'IT', isRequired: true, ownerRole: 'admin', templateKey: 'it_accounts' },
  { title: '配置系统权限与 VPN', category: 'it', ownerName: 'IT', isRequired: true, ownerRole: 'admin', templateKey: 'it_permissions' },
  { title: '准备工位、电脑与办公用品', category: 'admin', ownerName: '行政', isRequired: true, ownerRole: 'admin', templateKey: 'admin_workplace' },
  { title: '办理门禁卡与园区权限', category: 'admin', ownerName: '行政', isRequired: true, ownerRole: 'admin', templateKey: 'admin_access_card' },
  { title: '确认直属主管与报到联系人', category: 'manager', ownerName: '用人部门', isRequired: true, ownerRole: 'hiring_manager', templateKey: 'manager_first_week' },
  { title: '制定首周计划与岗位目标', category: 'manager', ownerName: '用人部门', isRequired: true, ownerRole: 'hiring_manager', templateKey: 'manager_goals' },
  { title: '安排入职引导与团队介绍', category: 'training', ownerName: '培训负责人', isRequired: true, ownerRole: 'hr_admin', templateKey: 'training_orientation' },
  { title: '完成合规与信息安全培训', category: 'training', ownerName: '培训负责人', isRequired: true, ownerRole: 'hr_admin', templateKey: 'training_compliance' },
  { title: '确认报到时间、地点与交通方式', category: 'candidate', ownerName: '候选人', isRequired: true, ownerRole: 'candidate', templateKey: 'candidate_reporting_confirmation' },
  { title: '提交并核对入职材料', category: 'candidate', ownerName: '候选人', isRequired: true, ownerRole: 'candidate', templateKey: 'candidate_materials' },
]
const defaultOnboardingMaterials = ['身份证明', '学历与学位证明', '离职证明', '银行卡信息']
const defaultOnboardingIntegrationProviders: OnboardingIntegrationProvider[] = ['oa', 'it_service_desk', 'access_control', 'email_account', 'hris']
const onboardingReasonLabels: Record<string, string> = {
  candidate_declined: '候选人放弃', offer_revoked: 'Offer 撤回', schedule_changed: '报到时间调整', position_closed: '岗位关闭', failed_requirements: '条件不符', candidate_unreachable: '无法联系候选人', personal_reason: '个人原因', another_offer: '接受其他 Offer', document_issue: '材料问题', attendance_issue: '报到异常', other: '其他原因',
}

const onboardingMaterialCodes: Record<string, string> = {
  '身份证明': 'identity',
  '身份证': 'id_card',
  '学历与学位证明': 'education',
  '毕业证书、学位证书': 'graduation_certificate',
  '离职证明': 'separation',
  '上家公司劳动合同解除证明或者离职证明': 'previous_employment_release',
  '上家单位一年工资流水': 'previous_employment_payroll',
  '一寸照片一张': 'photo',
  '体检报告': 'medical_report',
  '银行卡信息': 'bank_account',
  '工资卡': 'bank_card',
}

const onboardingMaterialCodeLabels: Record<string, string> = {
  identity: '身份证明',
  id_card: '身份证',
  education: '学历与学位证明',
  graduation_certificate: '毕业证书、学位证书',
  separation: '离职证明',
  previous_employment_release: '上家公司劳动合同解除证明或者离职证明',
  previous_employment_payroll: '上家单位一年工资流水',
  photo: '一寸照片',
  medical_report: '体检报告',
  bank_account: '银行卡信息',
  bank_card: '工资卡',
}

function onboardingMaterialTemplates(labels = defaultOnboardingMaterials): Array<{ code: string; label: string; isRequired: boolean }> {
  const used = new Set<string>()
  const templates: Array<{ code: string; label: string; isRequired: boolean }> = []
  labels.forEach((rawLabel, index) => {
    const normalized = clean(rawLabel)
    const [rawCode, ...details] = normalized.split(':')
    const detail = details.join(':').trim()
    const mappedFromChinese = onboardingMaterialCodes[normalized]
    const mappedFromCode = onboardingMaterialCodes[rawCode ?? '']
    const code = mappedFromChinese ?? mappedFromCode ?? (/^[a-z0-9_]+$/i.test(rawCode ?? '') ? rawCode! : `material_${index + 1}`)
    if (used.has(code)) return
    const readableCode = code.replaceAll('_', ' ').trim().replace(/^[a-z]/, (letter) => letter.toUpperCase())
    const label = rawCode === 'bank_card' && detail
      ? `${detail}工资卡`
      : mappedFromChinese
        ? normalized
        : onboardingMaterialCodeLabels[code] ?? detail ?? (mappedFromChinese ? normalized : readableCode) ?? `入职材料 ${index + 1}`
    used.add(code)
    templates.push({ code, label, isRequired: true })
  })
  return templates
}

function optionalClean(value: string | null | undefined): string | undefined {
  if (value === null) return undefined
  const result = clean(value)
  return result || undefined
}

function validateOnboardingContactPhone(value: string): void {
  if (!/^[0-9+()\-\s]{6,30}$/.test(value) || value.replace(/\D/g, '').length < 6) {
    throw new RecruitingWorkflowError('ONBOARDING_CONTACT_PHONE_INVALID', '联系人电话格式无效', 400)
  }
}

function validateOnboardingScheduleInput(input: UpdateOnboardingInput): void {
  if (input.plannedStartDate && !isIsoDate(input.plannedStartDate)) throw new RecruitingWorkflowError('ONBOARDING_DATE_INVALID', '计划入职日期格式应为 YYYY-MM-DD', 400)
  if (input.plannedStartTime && !isClockTime(input.plannedStartTime)) throw new RecruitingWorkflowError('ONBOARDING_TIME_INVALID', '计划报到时间格式应为 HH:mm', 400)
  if (input.reportingMode && !['onsite', 'remote', 'hybrid'].includes(input.reportingMode)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '报到方式无效', 400)
  if (input.reportingContactPhone) validateOnboardingContactPhone(input.reportingContactPhone)
}

function validateOnboardingTaskInput(input: Partial<UpdateOnboardingTaskInput>): void {
  if (input.category !== undefined && !['hr', 'it', 'admin', 'manager', 'training', 'candidate'].includes(input.category)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '任务分类无效', 400)
  if (input.status !== undefined && !['pending', 'in_progress', 'completed', 'blocked', 'not_required'].includes(input.status)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '任务状态无效', 400)
  if (input.dueDate && !isIsoDate(input.dueDate)) throw new RecruitingWorkflowError('ONBOARDING_TASK_DUE_DATE_INVALID', '任务截止日期格式应为 YYYY-MM-DD', 400)
}

function onboardingReasonInput(value: unknown): { code?: string; notes?: string; legacy?: string } {
  if (typeof value === 'string') {
    const legacy = clean(value)
    return legacy ? { legacy } : {}
  }
  if (!value || typeof value !== 'object') return {}
  const row = value as Record<string, unknown>
  const code = clean(row.reasonCode)
  const notes = clean(row.notes)
  return { ...(code ? { code } : {}), ...(notes ? { notes } : {}) }
}

function validateOnboardingReason(kind: 'cancel' | 'no_show', value: unknown): { reasonCode?: string; notes?: string; auditReason: string } {
  const reason = onboardingReasonInput(value)
  const allowed = kind === 'cancel' ? onboardingCancellationReasons : onboardingNoShowReasons
  if (reason.code && !(allowed as readonly string[]).includes(reason.code)) throw new RecruitingWorkflowError('ONBOARDING_REASON_INVALID', '原因选项无效', 400)
  if (reason.code === 'other' && !reason.notes) throw new RecruitingWorkflowError('ONBOARDING_REASON_NOTES_REQUIRED', '选择“其他原因”时必须填写说明', 400)
  const auditReason = reason.notes || (reason.code ? onboardingReasonLabels[reason.code] ?? reason.code : reason.legacy ?? '')
  if (!reason.code && !auditReason) throw new RecruitingWorkflowError('ONBOARDING_REASON_REQUIRED', kind === 'cancel' ? '取消原因不能为空' : '未报到原因不能为空', 400)
  return { ...(reason.code ? { reasonCode: reason.code } : {}), ...(reason.notes ? { notes: reason.notes } : {}), auditReason }
}
type CreateResumeInput = { candidateId: string; applicationId?: string; originalFilename: string; mimeType?: string; content: string; encoding?: 'utf8' | 'base64' }
type CreateInterviewInput = { applicationId: string; round?: number; type?: InterviewType; title: string; scheduledStartAt?: string; scheduledEndAt?: string; timezone?: string; location?: string; meetingUrl?: string; participants: Array<Omit<AssignedParticipant, 'role' | 'required'> & { role?: AssignedParticipant['role']; required?: boolean }> }
type FeedbackInput = { interviewerId: string; overallScore?: number; recommendation?: InterviewFeedbackRecord['recommendation']; ratings?: Record<string, number>; strengths?: string[]; concerns?: string[]; notes?: string }
function normalizeOfferInvoiceField(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new RecruitingWorkflowError('VALIDATION_ERROR', `${label}必须为文本`, 400)
  const text = value.trim()
  if (text.length > maxLength) throw new RecruitingWorkflowError('VALIDATION_ERROR', `${label}不能超过 ${maxLength} 个字符`, 400)
  return text
}

type CreateOfferInput = { applicationId: string; positionTitle: string; departmentId: string; employmentType: string; startDate?: string; reportingLocation?: string; invoiceTitle?: string; taxNumber?: string; templateFields?: OfferTemplateFields; baseSalary: { amount: number; currency: string }; probationSalary?: { amount: number; currency: string }; bonus?: { amount: number; currency: string }; equity?: string; benefits?: string[]; materials?: string[]; content: string; expiresAt?: string }
type OfferTemplateInput = { name: string; filename: string; content: string; isActive?: boolean; isDefault?: boolean }
type OfferTemplatePatch = Partial<OfferTemplateInput>
type ExtractedCandidateProfile = { candidate?: { fullName?: string; email?: string; phone?: string } }
type ReviewAnalysisResultInput = {
  status: AnalysisResultRecord['humanReviewStatus']
  comment?: string
  reviewedBy?: string
  edits?: {
    score?: number
    recommendation?: string
    strengths?: string[]
    risks?: string[]
  }
}
export interface RecruitingReport { generatedAt: string; summary: Array<{ label: string; value: number; detail: string }>; funnel: Array<{ stage: string; count: number; conversionRate: number | null }>; statusStats: Array<{ entity: string; status: string; count: number }>; jobFilling: Array<{ jobId: string; code: string; title: string; headcount: number; filledCount: number; openCount: number; fillRate: number }>; channels: Array<{ channel: string; applications: number; screened: number; interviewed: number; offers: number; hired: number; conversionRate: number }>; recruitmentCycle: { averageDaysToHire: number | null; medianDaysToHire: number | null; hiredCount: number }; feedbackCompletion: { expected: number; locked: number; completionRate: number | null }; offerAcceptance: { sent: number; accepted: number; acceptanceRate: number | null } }
export interface DashboardSummary {
  activity?: DashboardActivity
  generatedAt: string
  todos: DashboardTodo[]
  metrics: Array<{ label: string; value: number; detail: string }>
  funnel: Array<{ stage: string; count: number; conversionRate: number | null }>
  pendingApprovals: RecruitmentRequestRecord[]
  pendingInterviews: Array<InterviewRecord & { application: ApplicationRecord; candidateName: string; jobTitle: string }>
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

function requireCleanResume(scanStatus: string): void {
  // 病毒扫描已从默认业务链路移除。仍拒绝明确感染的文件，避免把
  // 安全校验误删成“任何文件都可分析”。历史 quarantined/scanning/failed
  // 状态由迁移归一为 clean，不再阻塞简历分析。
  if (scanStatus === 'infected') throw new RecruitingWorkflowError('RESUME_SCAN_NOT_CLEAN', '简历被安全检查标记为感染，不能分析', 409)
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

const PLACEHOLDER_CANDIDATE_NAMES = new Set(['待解析候选人', '待解析', '未命名候选人'])
const RESUME_SECTION_START = /^(?:教育背景|教育经历|学习经历|工作经历|工作经验|工作履历|项目经历|项目经验|技能标签|专业技能|自我评价|求职意向)/u
const RESUME_DATE_IN_NAME = /(?:19|20)\d{2}(?:[./年-]\d{1,2})?/u

function isClearlyMisparsedCandidateName(value: string): boolean {
  return value.length > 24 || RESUME_SECTION_START.test(value) || RESUME_DATE_IN_NAME.test(value)
}

function extractedCandidatePatch(candidate: CandidateRecord, extraction: ExtractedCandidateProfile | undefined, sourceText = ''): { fullName?: string; email?: string; phone?: string } {
  const draft = extraction?.candidate
  if (!draft) return {}
  const patch: { fullName?: string; email?: string; phone?: string } = {}
  const email = clean(draft.email)
  const phone = clean(draft.phone)
  const fullName = normalizeResumeCandidateName(clean(draft.fullName) ?? '') ?? ''
  if (email) patch.email = email
  if (phone) patch.phone = phone
  const existingName = clean(candidate.fullName)
  const normalizedExistingName = normalizeResumeCandidateName(existingName)
  const explicitNameInResume = /(?:^|[\s，,;；])(?:姓\s*名|名\s*字)\s*[:：]/u.test(sourceText)
  if (!candidate.nameManuallyEdited && fullName && (
    PLACEHOLDER_CANDIDATE_NAMES.has(existingName)
    || isResumePlaceholderName(existingName)
    || isResumeNameWithAppendedFields(existingName, fullName)
    || (normalizedExistingName && normalizedExistingName !== existingName && normalizedExistingName === fullName)
    || (explicitNameInResume && isClearlyMisparsedCandidateName(existingName))
  )) patch.fullName = fullName
  return patch
}

function normalizedStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new RecruitingWorkflowError('VALIDATION_ERROR', `${field} 必须是字符串数组`, 400)
  return [...new Set(value.map((item) => clean(item)).filter(Boolean))]
}

function applyAnalysisEdits(report: Record<string, unknown>, input: ReviewAnalysisResultInput, actorId: string): void {
  const analysis = report.analysis && typeof report.analysis === 'object' ? report.analysis as Record<string, unknown> : undefined
  const nestedReport = analysis?.report && typeof analysis.report === 'object' ? analysis.report as Record<string, unknown> : undefined
  const target = nestedReport ?? report
  const assessment = target.assessment && typeof target.assessment === 'object'
    ? target.assessment as Record<string, unknown>
    : {}
  const humanReview = target.humanReview && typeof target.humanReview === 'object'
    ? target.humanReview as Record<string, unknown>
    : {}
  const edits = input.edits ?? {}
  const before = {
    score: assessment.score,
    recommendation: assessment.recommendation,
    strengths: Array.isArray(assessment.strengths) ? assessment.strengths.map((item) => clean(item)).filter(Boolean) : [],
    risks: Array.isArray(assessment.risks) ? assessment.risks.map((item) => clean(item)).filter(Boolean) : [],
  }

  if (edits.score !== undefined) {
    const score = Number(edits.score)
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new RecruitingWorkflowError('VALIDATION_ERROR', '综合评分必须在 0-100 之间', 400)
    }
    assessment.score = Math.round(score * 100) / 100
  }
  if (edits.recommendation !== undefined) assessment.recommendation = clean(edits.recommendation)
  const strengths = normalizedStringList(edits.strengths, 'strengths')
  const risks = normalizedStringList(edits.risks, 'risks')
  if (strengths !== undefined) assessment.strengths = strengths
  if (risks !== undefined) assessment.risks = risks

  const after = {
    score: assessment.score,
    recommendation: assessment.recommendation,
    strengths: Array.isArray(assessment.strengths) ? assessment.strengths.map((item) => clean(item)).filter(Boolean) : [],
    risks: Array.isArray(assessment.risks) ? assessment.risks.map((item) => clean(item)).filter(Boolean) : [],
  }
  const history = Array.isArray(humanReview.history) ? humanReview.history : []
  const editedAt = new Date().toISOString()
  target.assessment = assessment
  target.humanReview = {
    ...humanReview,
    status: input.status,
    ...(input.comment ? { comment: clean(input.comment) } : {}),
    reviewedBy: clean(input.reviewedBy) || actorId,
    reviewedAt: editedAt,
    history: [
      ...history,
      {
        action: 'edited',
        editedBy: clean(input.reviewedBy) || actorId,
        editedAt,
        ...(input.comment ? { comment: clean(input.comment) } : {}),
        before,
        after,
      },
    ],
  }
}


function positiveInteger(value: unknown, field: string): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1) throw new RecruitingWorkflowError('VALIDATION_ERROR', `${field} 必须是大于 0 的整数`, 400)
  return result
}

/** 把仓储层的说明书版本（job_spec_versions 行）还原成领域 spec 对象，供 getJob 详情回填。 */
function specFromDbVersion(item: RepositoryJobSpecVersion): JobSpecRecord {
  const content = item.content && typeof item.content === 'object' ? item.content as Record<string, unknown> : {}
  const generatedBy = content.generatedBy === 'ai' || content.generatedBy === 'local_fallback' || content.generatedBy === 'human' ? content.generatedBy : undefined
  const requirements = Array.isArray(content.requirements) ? content.requirements.map((entry) => {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    return { label: String(row.label ?? ''), description: String(row.description ?? ''), required: row.required !== false, ...(typeof row.weight === 'number' ? { weight: row.weight } : {}) }
  }) : []
  return {
    version: item.version,
    title: String(content.title ?? ''),
    summary: String(content.summary ?? ''),
    responsibilities: Array.isArray(content.responsibilities) ? content.responsibilities.map(String) : [],
    requirements,
    skills: Array.isArray(content.skills) ? content.skills.map(String) : [],
    ...(generatedBy ? { generatedBy } : {}),
    confirmed: item.confirmedAt != null,
    ...(item.confirmedAt ? { confirmedAt: item.confirmedAt } : {}),
  }
}

/** 把仓储层的 JD 版本（job_description_versions 行）还原成领域 jd 对象。JD 语言未落库，默认中文。 */
function jdFromDbVersion(item: RepositoryJobDescriptionVersion): JobDescriptionRecord {
  const generatedBy = item.status === 'ai_assisted' || item.status === 'local_fallback' ? item.status : 'human'
  return {
    version: item.version,
    language: 'zh-CN',
    content: item.content,
    generatedBy,
    confirmed: item.confirmedAt != null,
    ...(item.confirmedAt ? { confirmedAt: item.confirmedAt } : {}),
  }
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
  const spec = job?.spec?.confirmed ? job.spec : undefined
  const jd = job?.jd?.confirmed ? job.jd : undefined
  const jobKey = jobId ?? job?.id
  const context = buildJobAnalysisContext({ title: job?.title ?? '未命名岗位', specContent: spec, jdContent: jd?.content })
  const requirements = normalizeJobRequirements({ ...(jobKey ? { jobId: jobKey } : {}), requirementLabels: context.requirements, requirementRequired: context.requirementRequired, skills: context.skills })
  return { ...(jobKey ? { jobId: jobKey } : {}), title: context.title, ...(spec?.summary ? { summary: spec.summary } : {}), requirements }
}

/** Keep editor drafts separate from the confirmed scoring baseline. */
function confirmedJobForAnalysis(job: JobRecord, state: RecruitingStoreState): JobRecord {
  const spec = [...state.jobSpecVersions.filter((item) => item.jobId === job.id), ...(job.spec ? [job.spec] : [])]
    .filter((item) => item.confirmed).sort((a, b) => b.version - a.version)[0]
  const jd = [...state.jobDescriptionVersions.filter((item) => item.jobId === job.id), ...(job.jd ? [job.jd] : [])]
    .filter((item) => item.confirmed).sort((a, b) => b.version - a.version)[0]
  const { spec: _draftSpec, jd: _draftJd, ...base } = job
  return { ...base, ...(spec ? { spec } : {}), ...(jd ? { jd } : {}) }
}

function mapRepositoryAnalysisTask(item: RepositoryAnalysisTask): AnalysisTaskRecord {
  return { id: item.id, resumeId: item.resumeId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), status: item.status as AnalysisTaskRecord['status'], attempts: item.attempts, idempotencyKey: item.idempotencyKey, ...(item.lastError ? { lastError: item.lastError } : {}), availableAt: item.availableAt, ...(item.startedAt ? { startedAt: item.startedAt } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}), createdAt: item.createdAt }
}

function mapRepositoryAnalysisResult(item: RepositoryAnalysisResult): AnalysisResultRecord {
  return { id: item.id, analysisTaskId: item.analysisTaskId, resumeId: item.resumeId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), result: item.result, analyzerVersion: item.analyzerVersion ?? 'unknown', inputHash: item.inputHash ?? '', humanReviewStatus: item.humanReviewStatus as AnalysisResultRecord['humanReviewStatus'], createdAt: item.createdAt }
}

function analysisReport(result: unknown): { assessment?: { score?: number | null }; extraction?: unknown } {
  if (!result || typeof result !== 'object') return {}
  const row = result as Record<string, unknown>
  const nested = row.analysis && typeof row.analysis === 'object'
    ? (row.analysis as Record<string, unknown>).report
    : undefined
  const report = nested && typeof nested === 'object' ? { ...nested as Record<string, unknown>, ...row } : row
  return {
    ...(report.assessment && typeof report.assessment === 'object' ? { assessment: report.assessment as { score?: number | null } } : {}),
    ...(report.extraction && typeof report.extraction === 'object' ? { extraction: report.extraction } : {}),
  }
}

function analysisSearchFields(result: unknown): { company?: string; skills?: string[] } {
  const extraction = analysisReport(result).extraction
  if (!extraction || typeof extraction !== 'object') return {}
  const row = extraction as Record<string, unknown>
  const experience = Array.isArray(row.experience) ? row.experience.find((item) => item && typeof item === 'object') as Record<string, unknown> | undefined : undefined
  const company = typeof experience?.employer === 'string' ? experience.employer.trim() : ''
  const skills = Array.isArray(row.skills)
    ? row.skills.map((item) => item && typeof item === 'object' ? String((item as Record<string, unknown>).value ?? (item as Record<string, unknown>).canonical ?? '').trim() : '').filter(Boolean)
    : []
  return { ...(company ? { company } : {}), ...(skills.length ? { skills } : {}) }
}

function analysisTaskProgress(status: string | undefined): number {
  if (status === 'queued') return 15
  if (status === 'processing') return 65
  if (status === 'completed' || status === 'failed') return 100
  return 0
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

function jobInput(input: CreateJobInput, request?: RecruitmentRequestRecord): JobRecord {
  const timestamp = LocalRecruitingStore.timestamp()
  return {
    id: randomUUID(), code: '', title: required(input.title, '岗位名称'), departmentId: required(input.departmentId, '部门'), department: request?.department ?? required(input.departmentId, '部门'),
    ...(input.hiringManagerId ? { hiringManagerId: clean(input.hiringManagerId) } : {}), recruitmentRequestId: request?.id ?? '', headcount: positiveInteger(input.headcount, '岗位人数'),
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
    onboardingTasks: state.onboardingTasks.filter((task) => onboardingIds.has(task.onboardingId)),
    onboardingMaterials: state.onboardingMaterials.filter((material) => onboardingIds.has(material.onboardingId)),
    onboardingReminders: state.onboardingReminders.filter((reminder) => onboardingIds.has(reminder.onboardingId)),
    onboardingIntegrations: state.onboardingIntegrations.filter((integration) => onboardingIds.has(integration.onboardingId)),
    approvalInstances,
    approvalSteps: state.approvalSteps.filter((step) => instanceIds.has(step.instanceId)),
    approvalRecords: state.approvalRecords.filter((record) => instanceIds.has(record.instanceId)),
    workflowEvents: state.workflowEvents.filter((event) => subjectIds[event.subjectType]?.has(event.subjectId) ?? false),
  }
}

export class RecruitingService {
  private readonly repository: NormalizedRecruitingRepository | undefined
  private readonly store!: ReturnType<typeof createRecruitingStore>
  private readonly objectStorage: ObjectStorage
  private readonly ownsObjectStorage: boolean
  private ownsRepositoryPool = false
  private closing: Promise<void> | undefined
  constructor(
    store?: ReturnType<typeof createRecruitingStore>,
    quarantineRoot = process.env.RECRUITING_QUARANTINE_ROOT || resolve(process.cwd(), '../../data/resumes/quarantine'),
    objectStorage?: ObjectStorage,
    repository?: NormalizedRecruitingRepository,
    private readonly resolveBillingEnv?: () => Promise<NodeJS.ProcessEnv>,
  ) {
    this.ownsObjectStorage = !objectStorage
    this.objectStorage = objectStorage ?? createObjectStorageFromEnv(process.env, quarantineRoot)
    if (repository) {
      this.repository = repository
      return
    }
    if (process.env.NODE_ENV === 'test') {
      this.store = store ?? createRecruitingStore()
      this.repository = undefined
    } else {
      this.repository = new NormalizedRecruitingRepository(createDatabasePool())
      this.ownsRepositoryPool = true
    }
  }

  /** Root owners drain requests before releasing their own storage and pool. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { if (this.ownsObjectStorage) await this.objectStorage.close?.() }
      finally { if (this.ownsRepositoryPool) await this.repository?.pool.end() }
    })()
  }

  /** 为当前请求创建企业级数据视图，共享连接池和对象存储，不跨请求泄露租户范围。 */
  forOrganization(organizationId?: string): RecruitingService {
    if (!this.repository || !organizationId?.trim()) return this
    return new RecruitingService(undefined, process.env.RECRUITING_QUARANTINE_ROOT || resolve(process.cwd(), '../../data/resumes/quarantine'), this.objectStorage, this.repository.withOrganization(organizationId.trim()), async () => bindBillingEnv({}, this.repository!.pool, organizationId.trim()))
  }

  private extractText(content: Buffer, filename: string, mimeType?: string): Promise<string> {
    const client = createHttpOcrClient()
    return extractResumeText(content, filename, mimeType, this.resolveBillingEnv ? meteredOcrClient(client, this.resolveBillingEnv) : client)
  }

  forUploadConnection(client: import('pg').PoolClient) {
    if (!this.repository) throw new Error('上传连接复用仅支持数据库仓储')
    const service = new RecruitingService(undefined, undefined, this.objectStorage,
      this.repository.withUploadConnection(client), this.resolveBillingEnv)
    return {
      createCandidate: service.createCandidate.bind(service),
      createApplication: service.createApplication.bind(service),
      createResume: service.createResume.bind(service),
      prepareResumeUpload: service.prepareResumeUpload.bind(service),
      completeResumeUpload: service.completeResumeUpload.bind(service),
      failResumeUpload: service.failResumeUpload.bind(service),
      discardQuotaRejectedImport: service.repository!.discardQuotaRejectedImport.bind(service.repository),
    }
  }

  /** 对象存储（MinIO）写失败时给出可诊断的提示，避免只抛出底层网络错误。 */
  private async putResumeObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.objectStorage.put(key, body, contentType)
    } catch (error) {
      throw new RecruitingWorkflowError('OBJECT_STORAGE_UNAVAILABLE', `简历存储不可用：无法写入对象存储（MinIO），请确认本地 MinIO 已启动。原始错误：${error instanceof Error ? error.message : '未知错误'}`, 503)
    }
  }

  /** 对象存储（MinIO）读失败时同样给出可诊断的提示，便于在分析任务里定位。 */
  private async getResumeObject(key: string): Promise<Buffer> {
    try {
      return await this.objectStorage.get(key)
    } catch (error) {
      throw new RecruitingWorkflowError('OBJECT_STORAGE_UNAVAILABLE', `简历存储不可用：无法读取对象存储（MinIO），请确认本地 MinIO 已启动。原始错误：${error instanceof Error ? error.message : '未知错误'}`, 503)
    }
  }

  /**
   * 仓储模式的只读快照：把仓储记录装配成与本地状态同构的对象，
   * 让面试/Offer/入职/报表/看板这些读接口只维护一份口径，并复用 filterStateByDepartment 的部门范围推导。
   */
  private async repositoryStateView(departmentId?: string): Promise<RecruitingStoreState> {
    const repository = this.repository
    if (!repository) throw new Error('repositoryStateView 需要仓储实例')
    const [requests, jobs, candidates, applications, resumes, tasks, results, interviews, feedback, offers, offerVersions, onboarding, onboardingTasks, onboardingMaterials, onboardingReminders, onboardingIntegrations, specRows, jdRows, events] = await Promise.all([
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
      repository.listOnboardingTasks(),
      repository.listOnboardingMaterials(),
      repository.listOnboardingReminders(),
      repository.listOnboardingIntegrations(),
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

    // 面试参与人通常只落 userId（不落 name），这里批量补 display_name，避免前端展示裸 UUID。
    const participantUserIds = [...new Set(interviews.flatMap((item) => item.participants.map((participant) => participant.userId)).filter(Boolean))]
    const userNameMap = await repository.resolveUserDisplayNames(participantUserIds)
    const mappedInterviews = interviews.map((item) => this.mapRepositoryInterview(item)).map((interview) => ({ ...interview, participants: interview.participants.map((participant) => { if (participant.name) return participant; const displayName = userNameMap.get(participant.userId); return displayName ? { ...participant, name: displayName } : participant }) }))
    const state: RecruitingStoreState = {
      recruitmentRequests: requests.map((item) => this.mapRepositoryRequest(item)),
      jobs: mappedJobs,
      candidates: candidates.map((item) => ({ id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), status: item.consentStatus === 'do_not_contact' ? 'do_not_contact' : 'active', createdAt: item.createdAt, updatedAt: item.updatedAt })),
      applications: applications.map((item) => ({ id: item.id, code: item.businessId, candidateId: item.candidateId, jobId: item.jobId, status: item.status as ApplicationRecord['status'], ...(item.source ? { source: item.source } : {}), aiStatus: 'pending', ...(item.recruiterId ? { recruiterId: item.recruiterId } : {}), appliedAt: item.appliedAt, ...(item.rejectedReason ? { rejectionReason: item.rejectedReason } : {}), updatedAt: item.updatedAt })),
      resumes: resumes.map((item) => ({ id: item.id, candidateId: item.candidateId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), storageKey: item.storageKey, originalFilename: item.originalFilename, mimeType: item.mimeType, sizeBytes: item.sizeBytes, contentHash: item.contentHash ?? '', scanStatus: item.scanStatus as ResumeRecord['scanStatus'], createdAt: item.createdAt })),
      analysisTasks: tasks.map((item) => ({ id: item.id, resumeId: item.resumeId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), status: item.status as AnalysisTaskRecord['status'], attempts: item.attempts, idempotencyKey: item.idempotencyKey, ...(item.lastError ? { lastError: item.lastError } : {}), availableAt: item.availableAt, ...(item.startedAt ? { startedAt: item.startedAt } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}), createdAt: item.createdAt })),
      analysisResults: results.map((item) => ({ id: item.id, analysisTaskId: item.analysisTaskId, resumeId: item.resumeId, ...(item.applicationId ? { applicationId: item.applicationId } : {}), result: item.result, analyzerVersion: item.analyzerVersion ?? '', inputHash: item.inputHash ?? '', humanReviewStatus: item.humanReviewStatus as AnalysisResultRecord['humanReviewStatus'], createdAt: item.createdAt })),
      interviews: mappedInterviews,
      interviewFeedback: feedback.map((item) => this.mapRepositoryFeedback(item)),
      offers: offers.map((item) => this.mapRepositoryOffer(item)),
      offerVersions: offerVersions.map((item) => ({ id: item.id, offerId: item.offerId, version: item.version, positionTitle: item.positionTitle, departmentId: item.departmentId, employmentType: item.employmentType, ...(item.startDate ? { startDate: item.startDate } : {}), ...(item.reportingLocation ? { reportingLocation: item.reportingLocation } : {}), ...(item.invoiceTitle ? { invoiceTitle: item.invoiceTitle } : {}), ...(item.taxNumber ? { taxNumber: item.taxNumber } : {}), templateFields: item.templateFields ?? {}, compensation: item.compensation as unknown as OfferVersionRecord['compensation'], benefits: item.benefits, materials: item.materials, content: item.content, createdAt: item.createdAt })),
      onboarding: onboarding.map((item) => this.mapRepositoryOnboarding(item)),
      onboardingTasks: onboardingTasks.map((item) => this.mapRepositoryOnboardingTask(item)),
      onboardingMaterials: onboardingMaterials.map((item) => this.mapRepositoryOnboardingMaterial(item)),
      onboardingReminders: onboardingReminders.map((item) => this.mapRepositoryOnboardingReminder(item)),
      onboardingIntegrations: onboardingIntegrations.map((item) => this.mapRepositoryOnboardingIntegration(item)),
      jobSpecVersions: specVersions,
      jobDescriptionVersions: jdVersions,
      approvalInstances: [],
      approvalSteps: [],
      approvalRecords: [],
      workflowEvents: events.map((item) => ({ id: item.id, subjectType: item.subjectType as WorkflowEventRecord['subjectType'], subjectId: item.subjectId, action: item.action, ...(item.fromStatus ? { fromStatus: item.fromStatus } : {}), ...(item.toStatus ? { toStatus: item.toStatus } : {}), actorId: item.actorId ?? '', ...(item.actorName ? { actorName: item.actorName } : {}), ...(item.reason ? { reason: item.reason } : {}), createdAt: item.createdAt })),
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
    return { id: item.id, code: item.businessId, applicationId: item.applicationId, round: item.round, stage: item.stage, type: item.type as InterviewType, title: item.title, status: item.status as InterviewRecord['status'], ...(item.scheduledStartAt ? { scheduledStartAt: item.scheduledStartAt } : {}), ...(item.scheduledEndAt ? { scheduledEndAt: item.scheduledEndAt } : {}), ...(item.timezone ? { timezone: item.timezone } : {}), ...(item.location ? { location: item.location } : {}), ...(item.meetingUrl ? { meetingUrl: item.meetingUrl } : {}), participants: item.participants.map((participant) => ({ ...participant, userId: participant.userId, ...(participant.name ? { name: participant.name } : {}), role: (participant.role || 'interviewer') as InterviewParticipant['role'], required: participant.required ?? true })), createdAt: item.createdAt, updatedAt: item.updatedAt }
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

  private mapRepositoryOfferTemplate(item: RepositoryOfferTemplate): RepositoryOfferTemplate {
    return { ...item }
  }

  private mapRepositoryOnboarding(item: RepositoryOnboarding): OnboardingRecord {
    return { id: item.id, applicationId: item.applicationId, offerId: item.offerId, ...(item.plannedStartDate ? { plannedStartDate: item.plannedStartDate } : {}), ...(item.plannedStartTime ? { plannedStartTime: item.plannedStartTime } : {}), ...(item.reportingMode ? { reportingMode: item.reportingMode } : {}), ...(item.reportingLocation ? { reportingLocation: item.reportingLocation } : {}), ...(item.reportingContactName ? { reportingContactName: item.reportingContactName } : {}), ...(item.reportingContactPhone ? { reportingContactPhone: item.reportingContactPhone } : {}), ...(item.hrOwnerName ? { hrOwnerName: item.hrOwnerName } : {}), ...(item.hiringManagerName ? { hiringManagerName: item.hiringManagerName } : {}), ...(item.workCity ? { workCity: item.workCity } : {}), ...(item.officeLocation ? { officeLocation: item.officeLocation } : {}), ...(item.riskNotes ? { riskNotes: item.riskNotes } : {}), ...(item.cancellationReasonCode ? { cancellationReasonCode: item.cancellationReasonCode as NonNullable<OnboardingRecord['cancellationReasonCode']> } : {}), ...(item.cancellationNotes ? { cancellationNotes: item.cancellationNotes } : {}), ...(item.cancelledAt ? { cancelledAt: item.cancelledAt } : {}), ...(item.noShowReasonCode ? { noShowReasonCode: item.noShowReasonCode as NonNullable<OnboardingRecord['noShowReasonCode']> } : {}), ...(item.noShowNotes ? { noShowNotes: item.noShowNotes } : {}), ...(item.noShowAt ? { noShowAt: item.noShowAt } : {}), ...(item.actualArrivalAt ? { actualArrivalAt: item.actualArrivalAt } : {}), status: item.status as OnboardingRecord['status'], ...(item.notes ? { notes: item.notes } : {}), ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryOnboardingTask(item: RepositoryOnboardingTask): OnboardingTaskRecord {
    return { id: item.id, onboardingId: item.onboardingId, title: item.title, category: item.category, status: item.status, isRequired: item.isRequired, ...(item.ownerRole ? { ownerRole: item.ownerRole } : {}), ...(item.templateKey ? { templateKey: item.templateKey } : {}), ...(item.ownerName ? { ownerName: item.ownerName } : {}), ...(item.dueDate ? { dueDate: item.dueDate } : {}), ...(item.notes ? { notes: item.notes } : {}), ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryOnboardingMaterial(item: RepositoryOnboardingMaterial): import('./types.js').OnboardingMaterialRecord {
    return { id: item.id, onboardingId: item.onboardingId, code: item.code, label: item.label, status: item.status, isRequired: item.isRequired, ...(item.collectedAt ? { collectedAt: item.collectedAt } : {}), ...(item.verifiedAt ? { verifiedAt: item.verifiedAt } : {}), ...(item.verifiedByUserId ? { verifiedByUserId: item.verifiedByUserId } : {}), ...(item.waivedAt ? { waivedAt: item.waivedAt } : {}), ...(item.notes ? { notes: item.notes } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryOnboardingReminder(item: RepositoryOnboardingReminder): import('./types.js').OnboardingReminderRecord {
    return { id: item.id, onboardingId: item.onboardingId, milestone: item.milestone, audience: item.audience, channel: item.channel, status: item.status, scheduledAt: item.scheduledAt, ...(item.sentAt ? { sentAt: item.sentAt } : {}), ...(item.failedAt ? { failedAt: item.failedAt } : {}), ...(item.failureReason ? { failureReason: item.failureReason } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryOnboardingIntegration(item: RepositoryOnboardingIntegration): import('./types.js').OnboardingIntegrationRecord {
    return { id: item.id, onboardingId: item.onboardingId, provider: item.provider, status: item.status, ...(item.externalReference ? { externalReference: item.externalReference } : {}), ...(item.lastAttemptAt ? { lastAttemptAt: item.lastAttemptAt } : {}), ...(item.lastSuccessAt ? { lastSuccessAt: item.lastSuccessAt } : {}), ...(item.lastError ? { lastError: item.lastError } : {}), createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryRequest(item: import('./repositories/types.js').RecruitmentRequestRecord): RecruitmentRequestRecord {
    const approvalStatus = item.approvalStatus ?? (item.status === 'approved' ? 'approved' : item.status === 'rejected' ? 'rejected' : item.status === 'cancelled' ? 'cancelled' : 'pending')
    return { id: item.id, code: item.businessId, title: item.title, departmentId: item.departmentId ?? '', department: item.departmentName ?? item.departmentId ?? '', requesterId: item.requestedById ?? '', ...(item.requesterName ? { requesterName: item.requesterName } : {}), ...(item.requesterEmail ? { requesterEmail: item.requesterEmail } : {}), ...(item.hiringManagerId ? { hiringManagerId: item.hiringManagerId } : {}), headcount: item.headcount, employmentType: item.employmentType ?? 'full_time', workMode: item.workMode ?? 'onsite', ...(item.location ? { location: item.location } : {}), ...(item.budgetMin === null && item.budgetMax === null ? {} : { salaryRange: { ...(item.budgetMin === null ? {} : { min: { amount: item.budgetMin, currency: 'CNY' } }), ...(item.budgetMax === null ? {} : { max: { amount: item.budgetMax, currency: 'CNY' } }) } }), justification: item.reason, status: item.status as RecruitmentRequestRecord['status'], approval: { status: approvalStatus, approver: '', ...(item.approvalProvider ? { provider: item.approvalProvider } : {}), ...(item.approvalExternalInstanceId ? { externalInstanceId: item.approvalExternalInstanceId } : {}) }, convertedJobIds: [], version: item.version, createdAt: item.createdAt, updatedAt: item.updatedAt }
  }

  private mapRepositoryJob(item: import('./repositories/types.js').JobRecord): JobRecord {
    return { id: item.id, code: item.businessId, title: item.title, departmentId: item.departmentId, department: item.departmentName ?? item.departmentId, ...(item.hiringManagerId ? { hiringManagerId: item.hiringManagerId } : {}), recruitmentRequestId: item.recruitmentRequestId ?? '', headcount: item.headcount, filledCount: 0, employmentType: item.employmentType ?? 'full_time', workMode: item.workMode ?? 'onsite', ...(item.location ? { location: item.location } : {}), status: item.status as JobRecord['status'], channels: [], version: 1, createdAt: item.createdAt, updatedAt: item.updatedAt }
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
    const application = this.repository ? await this.repository.getApplication(applicationId) : applicationOrThrow(await this.store.read(), applicationId)
    if (!departmentId) return
    const job = await this.getJob(application.jobId)
    if (job.departmentId !== departmentId) throw new RecruitingWorkflowError('FORBIDDEN', '当前账号无权访问其他部门数据', 403)
  }

  /** 候选人主档没有部门字段，按其在目标部门岗位上的申请归属判定。 */
  async assertCandidateInScope(candidateId: string, departmentId?: string): Promise<void> {
    if (this.repository) await this.repository.getCandidate(candidateId)
    else candidateOrThrow(await this.store.read(), candidateId)
    if (!departmentId) return
    const jobIds = await this.jobIdsInDepartment(departmentId)
    const applications = await this.listApplications()
    if (!applications.some((application) => application.candidateId === candidateId && jobIds.has(application.jobId))) {
      throw new RecruitingWorkflowError('FORBIDDEN', '当前账号无权访问其他部门数据', 403)
    }
  }

  async assertInterviewInScope(interviewId: string, departmentId?: string): Promise<void> {
    // 企业范围始终校验；企业管理员没有部门限制，也不能访问其他企业的面试。
    const interview = await this.getInterview(interviewId)
    if (departmentId) await this.assertApplicationInScope(interview.applicationId, departmentId)
  }

  async assertOfferInScope(offerId: string, departmentId?: string): Promise<void> {
    const offer = await this.getOffer(offerId)
    await this.assertApplicationInScope(offer.applicationId, departmentId)
  }

  async assertOnboardingInScope(onboardingId: string, departmentId?: string): Promise<void> {
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
      const row = await this.repository.createRecruitmentRequest({ title: required(input.title, '岗位名称'), departmentId: input.departmentId, requestedById: actorId, hiringManagerId: input.hiringManagerId ?? null, headcount: positiveInteger(input.headcount, '招聘人数'), budgetMin: input.salaryRange?.min?.amount ?? null, budgetMax: input.salaryRange?.max?.amount ?? null, employmentType: input.employmentType ?? null, workMode: input.workMode ?? null, location: input.location ?? null, reason: input.justification, status: 'draft' })
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
      const row = await this.repository.updateRecruitmentRequest(id, { ...(input.title === undefined ? {} : { title: input.title }), ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }), ...(input.hiringManagerId === undefined ? {} : { hiringManagerId: input.hiringManagerId ?? null }), ...(input.headcount === undefined ? {} : { headcount: positiveInteger(input.headcount, '招聘人数') }), ...(input.employmentType === undefined ? {} : { employmentType: input.employmentType ?? null }), ...(input.workMode === undefined ? {} : { workMode: input.workMode ?? null }), ...(input.location === undefined ? {} : { location: input.location ?? null }), ...(input.justification === undefined ? {} : { reason: input.justification }), ...(input.salaryRange?.min ? { budgetMin: input.salaryRange.min.amount } : {}), ...(input.salaryRange?.max ? { budgetMax: input.salaryRange.max.amount } : {}), version: current.version + 1 })
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
    if (action === 'approve' || action === 'reject') throw new RecruitingWorkflowError('RECRUITMENT_APPROVAL_DISABLED', '招聘需求已取消审批，请直接提交需求')
    if (this.repository && ['submit', 'resubmit', 'approve', 'reject', 'withdraw', 'close', 'cancel', 'convert'].includes(action)) {
      const row = await this.repository.requestApprovalAction(id, action as 'submit' | 'resubmit' | 'approve' | 'reject' | 'withdraw' | 'close' | 'cancel' | 'convert', actorId, reason === undefined ? undefined : clean(reason))
      return this.mapRepositoryRequest(row)
    }
    return this.store.transaction((state) => {
      const request = requestOrThrow(state, id)
      const fromStatus = request.status
      transitionRequest(request, action, reason)

      addEvent(state, { subjectType: 'recruitment_request', subjectId: request.id, action, fromStatus, toStatus: request.status, actorId, ...(reason ? { reason: clean(reason) } : {}) })
      return request
    })
  }

  async getRequestApproval(id: string): Promise<{ current: ApprovalInstanceRecord | null; steps: ApprovalStepRecord[]; records: ApprovalAuditRecord[] }> {
    if (this.repository) {
      await this.repository.getRecruitmentRequest(id)
      const approval = await this.repository.getRecruitmentRequestApproval(id)
      return {
        current: approval.current ? { id: approval.current.id, entityType: 'recruitment_request', entityId: approval.current.entityId, version: approval.current.version, status: approval.current.status, ...(approval.current.provider ? { provider: approval.current.provider } : {}), ...(approval.current.externalInstanceId ? { externalInstanceId: approval.current.externalInstanceId } : {}), createdAt: approval.current.createdAt, updatedAt: approval.current.updatedAt, ...(approval.current.completedAt ? { completedAt: approval.current.completedAt } : {}) } : null,
        steps: approval.steps.map((item) => ({ id: item.id, instanceId: item.instanceId, order: item.order, name: item.name, approverRole: item.approverRole, ...(item.externalStepId ? { externalStepId: item.externalStepId } : {}), ...(item.nodeName ? { nodeName: item.nodeName } : {}), status: item.status, ...(item.actedAt ? { actedAt: item.actedAt } : {}) })),
        records: approval.records.map((item) => ({ id: item.id, instanceId: item.instanceId, stepId: item.stepId, actorId: item.actorId, ...(item.approver ? { approver: item.approver } : {}), action: item.action, ...(item.comment ? { comment: item.comment } : {}), createdAt: item.createdAt })),
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
      const scoped = rows.filter((item) => !departmentId || item.departmentId === departmentId)
      if (!scoped.length) return []
      const [specRows, jdRows] = await Promise.all([
        this.repository.listJobSpecVersions(),
        this.repository.listJobDescriptionVersions(),
      ])
      const latestSpecs = new Map<string, JobSpecRecord>()
      const latestJds = new Map<string, JobDescriptionRecord>()
      for (const row of specRows) if (!latestSpecs.has(row.jobId)) latestSpecs.set(row.jobId, specFromDbVersion(row))
      for (const row of jdRows) if (!latestJds.has(row.jobId)) latestJds.set(row.jobId, jdFromDbVersion(row))
      return scoped.map((item) => {
        const mapped = this.mapRepositoryJob(item)
        const spec = latestSpecs.get(item.id)
        const jd = latestJds.get(item.id)
        if (spec) mapped.spec = spec
        if (jd) mapped.jd = jd
        return mapped
      })
    }
    const state = await this.store.read()
    return state.jobs.filter((item) => (!status || item.status === status) && (!recruitmentRequestId || item.recruitmentRequestId === recruitmentRequestId) && (!departmentId || item.departmentId === departmentId))
  }

  async getJob(id: string): Promise<JobRecord> {
    if (this.repository) {
      const row = await this.repository.getJob(id)
      const mapped = this.mapRepositoryJob(row)
      const [specVersions, jdVersions] = await Promise.all([this.repository.listJobSpecVersions(row.id), this.repository.listJobDescriptionVersions(row.id)])
      if (specVersions[0]) mapped.spec = specFromDbVersion(specVersions[0])
      if (jdVersions[0]) mapped.jd = jdFromDbVersion(jdVersions[0])
      return mapped
    }
    const state = await this.store.read()
    return jobOrThrow(state, id)
  }

  private async getJobForAnalysis(id: string): Promise<JobRecord> {
    if (!this.repository) {
      const state = await this.store.read()
      return confirmedJobForAnalysis(jobOrThrow(state, id), state)
    }
    const row = await this.repository.getJob(id)
    await this.repository.assertJobAnalysisContextScope(row.id)
    const [specs, jds] = await Promise.all([this.repository.listJobSpecVersions(id), this.repository.listJobDescriptionVersions(id)])
    const spec = specs.filter((item) => item.confirmedAt).sort((a, b) => b.version - a.version)[0]
    const jd = jds.filter((item) => item.confirmedAt).sort((a, b) => b.version - a.version)[0]
    return { ...this.mapRepositoryJob(row), ...(spec ? { spec: specFromDbVersion(spec) } : {}), ...(jd ? { jd: jdFromDbVersion(jd) } : {}) }
  }

  async listJobRelatedRecords(id: string): Promise<JobRelatedRecord[]> {
    if (this.repository) return this.repository.listJobRelatedRecords(id)
    const state = await this.store.read()
    const job = jobOrThrow(state, id)
    return state.applications.filter(item => item.jobId === job.id).map(item => ({
      kind: 'application' as const, id: item.id,
      title: `${state.candidates.find(candidate => candidate.id === item.candidateId)?.fullName || '候选人'} · ${item.code || item.id}`,
      status: item.status, candidateId: item.candidateId, applicationId: item.id, updatedAt: item.updatedAt,
    })).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async deleteJob(id: string, actorId = 'user-demo'): Promise<void> {
    if (this.repository) { await this.repository.deleteJob(id, actorId); return }
    await this.store.transaction((state) => {
      const job = jobOrThrow(state, id)
      if (state.applications.some((item) => item.jobId === job.id)) {
        throw new RecruitingWorkflowError('JOB_IN_USE', '该岗位已有候选人申请记录，不能直接删除。请先在简历管理中处理关联的岗位申请；候选人及简历资料不会被自动删除。')
      }
      state.jobs = state.jobs.filter((item) => item.id !== job.id)
      state.jobSpecVersions = state.jobSpecVersions.filter((item) => item.jobId !== job.id)
      state.jobDescriptionVersions = state.jobDescriptionVersions.filter((item) => item.jobId !== job.id)
      for (const request of state.recruitmentRequests) {
        request.convertedJobIds = request.convertedJobIds.filter((jobId) => jobId !== job.id)
      }
      addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'delete', actorId,
        metadata: { title: job.title, candidatesRetained: true, resumesRetained: true } })
    })
  }

  async createJob(input: CreateJobInput, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const row = await this.repository.createJob({ title: required(input.title, '岗位名称'), departmentId: input.departmentId, hiringManagerId: clean(input.hiringManagerId) || null, recruitmentRequestId: clean(input.recruitmentRequestId) || null, headcount: positiveInteger(input.headcount, '岗位人数'), status: 'draft', employmentType: input.employmentType ?? null, workMode: input.workMode ?? null, location: input.location ?? null, createdById: actorId })
      return this.mapRepositoryJob(row)
    }
    return this.store.transaction((state) => {
      const requestId = clean(input.recruitmentRequestId)
      const request = requestId ? requestOrThrow(state, requestId) : undefined
      if (request && request.status !== 'approved' && request.status !== 'converted') throw new RecruitingWorkflowError('RECRUITMENT_REQUEST_NOT_APPROVED', '只有审批通过的招聘需求才能创建岗位')
      const job = jobInput(input, request)
      job.code = `JOB-${state.nextJobNumber++}`
      state.jobs.push(job)
      if (request) {
        request.convertedJobIds.push(job.id)
        request.updatedAt = LocalRecruitingStore.timestamp()
      }
      addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'create_job', toStatus: job.status, actorId })
      return job
    })
  }

  async updateJob(id: string, input: UpdateJobInput, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const row = await this.repository.updateJob(id, { ...(input.title === undefined ? {} : { title: input.title }), ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }), ...(input.hiringManagerId === undefined ? {} : { hiringManagerId: clean(input.hiringManagerId) || null }), ...(input.headcount === undefined ? {} : { headcount: positiveInteger(input.headcount, '岗位人数') }), ...(input.employmentType === undefined ? {} : { employmentType: input.employmentType ?? null }), ...(input.workMode === undefined ? {} : { workMode: input.workMode ?? null }), ...(input.location === undefined ? {} : { location: input.location ?? null }) })
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
        if (input[field] !== undefined) (job as unknown as Record<string, unknown>)[field] = field === 'hiringManagerId' ? clean(input[field]) : input[field]
      }
      if (input.headcount !== undefined) job.headcount = positiveInteger(input.headcount, '岗位人数')
      job.version += 1; job.updatedAt = LocalRecruitingStore.timestamp(); addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'update_job', actorId })
      return job
    })
  }

  async createSpec(id: string, input: CreateJobSpecInput, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const jobRow = await this.repository.getJob(id)
      // Allocate the version under the repository's parent-job lock, not from a scoped list.
      const spec: Omit<JobSpecRecord, 'version'> = { title: required(input.title, '说明书标题'), summary: required(input.summary, '岗位摘要'), responsibilities: input.responsibilities ?? [], requirements: input.requirements ?? [], skills: input.skills ?? [], ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}), confirmed: false }
      await this.repository.createJobSpecVersion({ jobId: jobRow.id, content: spec as unknown as Record<string, unknown>, createdById: actorId })
      await this.repository.appendWorkflowEvent({ subjectType: 'job', subjectId: jobRow.id, action: 'spec_created', actorId })
      return this.getJob(jobRow.id)
    }
    return this.store.transaction((state) => {
      const job = jobOrThrow(state, id)
      const createdAt = LocalRecruitingStore.timestamp()
      if (job.spec) state.jobSpecVersions.push({ ...job.spec, jobId: job.id, createdAt, actorId })
      job.spec = { version: (job.spec?.version ?? 0) + 1, title: required(input.title, '说明书标题'), summary: required(input.summary, '岗位摘要'), responsibilities: input.responsibilities ?? [], requirements: input.requirements ?? [], skills: input.skills ?? [], ...(input.generatedBy ? { generatedBy: input.generatedBy } : {}), confirmed: false }
      state.jobSpecVersions.push({ ...job.spec, jobId: job.id, createdAt, actorId })
      job.version += 1; job.updatedAt = createdAt
      addEvent(state, { subjectType: 'job', subjectId: job.id, action: 'spec_created', actorId })
      return job
    })
  }

  async createJd(id: string, input: { language: string; content: string; generatedBy?: 'human' | 'ai_assisted' | 'local_fallback' }, actorId = 'user-demo'): Promise<JobRecord> {
    if (this.repository) {
      const jobRow = await this.repository.getJob(id)
      await this.repository.createJobDescriptionVersion({ jobId: jobRow.id, title: jobRow.title, content: required(input.content, 'JD 内容'), status: input.generatedBy ?? 'human', createdById: actorId })
      await this.repository.appendWorkflowEvent({ subjectType: 'job', subjectId: jobRow.id, action: 'jd_created', actorId })
      return this.getJob(jobRow.id)
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
      if (action === 'publish' && job.recruitmentRequestId && !request) throw new RecruitingNotFoundError(`未找到招聘需求：${job.recruitmentRequestId}`)
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
      const request = job.recruitmentRequestId ? requestOrThrow(state, job.recruitmentRequestId) : undefined
      const fromStatus = job.status
      transitionJob(job, action, request, reason)
      addEvent(state, { subjectType: 'job', subjectId: job.id, action, fromStatus, toStatus: job.status, actorId, ...(reason ? { reason: clean(reason) } : {}) })
      return job
    })
  }

  async listCandidates(departmentId?: string): Promise<Array<CandidateRecord & { applications: ApplicationRecord[]; aiStatus: 'completed' | 'pending'; score?: number | null; analysisStatus?: 'queued' | 'processing' | 'completed' | 'failed'; analysisProgress?: number; analysisAttempts?: number; analysisError?: string }>> {
    const jobIds = departmentId ? await this.jobIdsInDepartment(departmentId) : undefined
    if (this.repository) {
      const [candidates, applications, results, resumes, tasks, interviews] = await Promise.all([
        this.repository.listCandidates(),
        this.repository.listApplications(),
        this.repository.listAnalysisResults(),
        this.repository.listResumes(),
        this.repository.listAnalysisTasks(),
        this.repository.listInterviews(),
      ])
      const interviewProgress = interviewProgressByApplication(interviews)
      const resultByApplication = latestAnalysisByKey(results, (result) => result.applicationId)
      const applicationCandidate = new Map(applications.map((app) => [app.id, app.candidateId]))
      const resumeCandidate = new Map(resumes.map((resume) => [resume.id, resume.candidateId]))
      const latestResultByCandidate = latestAnalysisByKey(results, (result) =>
        (result.applicationId ? applicationCandidate.get(result.applicationId) : undefined) ?? resumeCandidate.get(result.resumeId))
      const latestTaskByCandidate = latestAnalysisByKey(tasks, (task) => resumeCandidate.get(task.resumeId))
      const latestTaskByApplication = latestAnalysisByKey(tasks, (task) => task.applicationId)
      const rows = candidates.map((item) => {
        const candidateApplications = applications.filter((app) => app.candidateId === item.id).map((app) => {
          const result = resultByApplication.get(app.id)
          const resumeReview = result ? resumeScoreSummary(result.id, result.result) : undefined
          const score = resumeReview?.finalScore ?? resumeReview?.aiScore
          const task = latestTaskByApplication.get(app.id)
          const currentInterview = interviewProgress.get(app.id)
          const progress = { ...(currentInterview ? { interviewProgress: currentInterview } : {}), ...(task ? { analysisStatus: task.status as AnalysisTaskRecord['status'], analysisProgress: analysisTaskProgress(task.status), analysisAttempts: task.attempts, ...(task.lastError ? { analysisError: task.lastError } : {}) } : {}) }
          return { ...progress, id: app.id, code: app.businessId, candidateId: app.candidateId, jobId: app.jobId, status: app.status as ApplicationRecord['status'], ...(app.source ? { source: app.source } : {}), ...(typeof score === 'number' ? { score } : {}), ...(resumeReview ? { resumeReview } : {}), aiStatus: result ? 'completed' : 'pending', appliedAt: app.appliedAt, updatedAt: app.updatedAt }
        })
        const latestResult = latestResultByCandidate.get(item.id)
        const latestTask = latestTaskByCandidate.get(item.id)
        const latestReview = latestResult ? resumeScoreSummary(latestResult.id, latestResult.result) : undefined
        const latestScore = latestReview?.finalScore ?? latestReview?.aiScore
        const searchFields = analysisSearchFields(latestResult?.result)
        const analysisStatus = latestTask?.status as 'queued' | 'processing' | 'completed' | 'failed' | undefined
        return { id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), ...searchFields, status: (item.consentStatus === 'do_not_contact' ? 'do_not_contact' : 'active') as CandidateRecord['status'], createdAt: item.createdAt, updatedAt: item.updatedAt, aiStatus: (latestResult ? 'completed' : 'pending') as 'completed' | 'pending', ...(latestResult ? { score: typeof latestScore === 'number' ? latestScore : null } : {}), ...(analysisStatus ? { analysisStatus, analysisProgress: analysisTaskProgress(analysisStatus), analysisAttempts: latestTask?.attempts ?? 0 } : {}), ...(latestTask?.lastError ? { analysisError: latestTask.lastError } : {}), applications: candidateApplications as ApplicationRecord[] }
      })
      return jobIds ? rows.filter((row) => row.applications.some((application) => jobIds.has(application.jobId))) : rows
    }

    const state = await this.store.read()
    const scoped = departmentId ? filterStateByDepartment(state, departmentId) : state
    const latestTaskByApplication = latestAnalysisByKey(scoped.analysisTasks, (task) => task.applicationId)
    const interviewProgress = interviewProgressByApplication(scoped.interviews)
    const rows = scoped.candidates.map((candidate) => {
      const resumeIds = new Set(scoped.resumes.filter((resume) => resume.candidateId === candidate.id).map((resume) => resume.id))
      const applicationIds = new Set(scoped.applications.filter((application) => application.candidateId === candidate.id).map((application) => application.id))
      const latest = scoped.analysisResults.filter((result) => resumeIds.has(result.resumeId) || (result.applicationId ? applicationIds.has(result.applicationId) : false)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
      const latestTask = scoped.analysisTasks.filter((task) => resumeIds.has(task.resumeId)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
      const latestReview = latest ? resumeScoreSummary(latest.id, latest.result) : undefined
      const score = latestReview?.finalScore ?? latestReview?.aiScore
      const searchFields = analysisSearchFields(latest?.result)
      const analysisStatus = latestTask?.status as 'queued' | 'processing' | 'completed' | 'failed' | undefined
      return { ...candidate, ...searchFields, aiStatus: (latest ? 'completed' : 'pending') as 'completed' | 'pending', ...(latest ? { score: typeof score === 'number' ? score : null } : {}), ...(analysisStatus ? { analysisStatus, analysisProgress: analysisTaskProgress(analysisStatus), analysisAttempts: latestTask?.attempts ?? 0 } : {}), ...(latestTask?.lastError ? { analysisError: latestTask.lastError } : {}), applications: scoped.applications.filter((application) => application.candidateId === candidate.id).map((application) => {
        const result = scoped.analysisResults.filter((item) => item.applicationId === application.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
        const resumeReview = result ? resumeScoreSummary(result.id, result.result) : undefined
        const task = latestTaskByApplication.get(application.id)
        const currentInterview = interviewProgress.get(application.id)
        return { ...application, ...(currentInterview ? { interviewProgress: currentInterview } : {}), aiStatus: result ? 'completed' as const : application.aiStatus, ...(task ? { analysisStatus: task.status, analysisProgress: analysisTaskProgress(task.status), analysisAttempts: task.attempts, ...(task.lastError ? { analysisError: task.lastError } : {}) } : {}), ...(resumeReview ? { resumeReview, score: resumeReview.finalScore ?? resumeReview.aiScore } : {}) }
      }) }
    })
    return jobIds ? rows.filter((row) => row.applications.some((application) => jobIds.has(application.jobId))) : rows
  }

  async listCandidateTags(): Promise<string[]> {
    if (this.repository) return []
    const state = await this.stateView()
    return [...(state.candidateTags ?? [])]
  }

  async getCandidate(id: string): Promise<CandidateRecord & { applications: ApplicationRecord[]; resumes: ResumeRecord[]; analysisTasks: AnalysisTaskRecord[]; analysisResults: AnalysisResultRecord[]; jobs: Array<{ id: string; code: string; title: string }> }> {
    if (this.repository) {
      const item = await this.repository.getCandidate(id)
      const applications = await this.repository.listApplications(item.id)
      const [allResumes, allTasks, allResults, allJobs] = await Promise.all([this.repository.listResumes(item.id), this.repository.listAnalysisTasks(), this.repository.listAnalysisResults(), this.repository.listJobs()])
      const resumes = allResumes.filter((r) => r.candidateId === item.id); const appIds = new Set(applications.map((a) => a.id)); const resumeIds = new Set(resumes.map((r) => r.id))
      const analysisTasks = allTasks.filter((t) => resumeIds.has(t.resumeId) || (t.applicationId ? appIds.has(t.applicationId) : false)).map(mapRepositoryAnalysisTask)
      const analysisResults = allResults.filter((r) => resumeIds.has(r.resumeId) || (r.applicationId ? appIds.has(r.applicationId) : false)).map((item) => ({ ...mapRepositoryAnalysisResult(item), result: resumeExperienceView(item.result) }))
      const resultByApplication = latestAnalysisByKey(analysisResults, (result) => result.applicationId)
      const jobs = allJobs.filter((j) => new Set(applications.map((a) => a.jobId)).has(j.id)).map((j) => ({ id: j.id, code: j.businessId, title: j.title }))
      return { id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), status: (item.consentStatus === 'do_not_contact' ? 'do_not_contact' : 'active') as CandidateRecord['status'], createdAt: item.createdAt, updatedAt: item.updatedAt, applications: applications.map((app) => { const result = resultByApplication.get(app.id); const resumeReview = result ? resumeScoreSummary(result.id, result.result) : undefined; const score = resumeReview?.finalScore ?? resumeReview?.aiScore; return { id: app.id, code: app.businessId, candidateId: app.candidateId, jobId: app.jobId, status: app.status as ApplicationRecord['status'], ...(typeof score === 'number' ? { score } : {}), ...(resumeReview ? { resumeReview } : {}), aiStatus: (resultByApplication.has(app.id) ? 'completed' : 'pending') as ApplicationRecord['aiStatus'], appliedAt: app.appliedAt, updatedAt: app.updatedAt } }), resumes: resumes.map((r) => ({ id: r.id, candidateId: r.candidateId, ...(r.applicationId ? { applicationId: r.applicationId } : {}), storageKey: r.storageKey, originalFilename: r.originalFilename, mimeType: r.mimeType, sizeBytes: r.sizeBytes, contentHash: r.contentHash ?? '', scanStatus: r.scanStatus as ResumeRecord['scanStatus'], createdAt: r.createdAt })), analysisTasks, analysisResults, jobs }
    }
    const state = await this.store.read()
    const candidate = candidateOrThrow(state, id)
    const applications = state.applications.filter((application) => application.candidateId === id)
    const resumes = state.resumes.filter((resume) => resume.candidateId === id)
    const resumeIds = new Set(resumes.map((resume) => resume.id))
    const applicationIds = new Set(applications.map((application) => application.id))
    const analysisTasks = state.analysisTasks.filter((task) => resumeIds.has(task.resumeId) || (task.applicationId ? applicationIds.has(task.applicationId) : false))
    const analysisResults = state.analysisResults.filter((result) => resumeIds.has(result.resumeId) || (result.applicationId ? applicationIds.has(result.applicationId) : false)).map((item) => ({ ...item, result: resumeExperienceView(item.result) }))
    const jobIds = new Set(applications.map((application) => application.jobId))
    const jobs = state.jobs.filter((job) => jobIds.has(job.id)).map((job) => ({ id: job.id, code: job.code, title: job.title }))
    return { ...candidate, applications: applications.map((application) => {
      const result = analysisResults.filter((item) => item.applicationId === application.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
      const resumeReview = result ? resumeScoreSummary(result.id, result.result) : undefined
      return { ...application, ...(resumeReview ? { resumeReview, score: resumeReview.finalScore ?? resumeReview.aiScore } : {}) }
    }), resumes, analysisTasks, analysisResults, jobs }
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

  async deleteCandidate(id: string, actorId = 'user-demo'): Promise<void> {
    const storageKeys = this.repository
      ? await this.repository.deleteCandidate(id, actorId)
      : await this.store.transaction((state) => {
        const candidate = candidateOrThrow(state, id)
        const applicationIds = new Set(state.applications.filter((item) => item.candidateId === candidate.id).map((item) => item.id))
        const resumes = state.resumes.filter((item) => item.candidateId === candidate.id)
        const resumeIds = new Set(resumes.map((item) => item.id))
        if (state.interviews.some((item) => applicationIds.has(item.applicationId))
          || state.offers.some((item) => applicationIds.has(item.applicationId))
          || state.onboarding.some((item) => applicationIds.has(item.applicationId))) {
          throw new RecruitingWorkflowError('CANDIDATE_IN_USE', '该候选人已有面试、Offer 或入职记录，不能直接删除，请先处理关联流程。')
        }
        const related = (item: { resumeId: string; applicationId?: string }) => resumeIds.has(item.resumeId) || !!item.applicationId && applicationIds.has(item.applicationId)
        if (state.analysisTasks.some((item) => related(item) && item.status === 'processing')) {
          throw new RecruitingWorkflowError('CANDIDATE_ANALYSIS_IN_PROGRESS', '该候选人的 AI 分析正在进行，请等待分析结束后再删除。')
        }
        state.analysisResults = state.analysisResults.filter((item) => !related(item))
        state.analysisTasks = state.analysisTasks.filter((item) => !related(item))
        state.resumes = state.resumes.filter((item) => !resumeIds.has(item.id))
        state.applications = state.applications.filter((item) => !applicationIds.has(item.id))
        state.candidates = state.candidates.filter((item) => item.id !== candidate.id)
        addEvent(state, { subjectType: 'candidate', subjectId: candidate.id, action: 'delete', actorId })
        return resumes.map((item) => item.storageKey)
      })
    // PostgreSQL persists cleanup tasks in the deletion transaction; only the queue deletes files.
    if (this.repository) return
    for (const key of storageKeys) {
      await this.objectStorage.delete(key).catch(() => console.warn('Candidate deleted; resume object cleanup failed'))
    }
  }

  async updateCandidate(id: string, input: UpdateCandidateInput, actorId = 'user-demo'): Promise<CandidateRecord> {
    if (input.fullName !== undefined && (!input.fullName.trim() || input.fullName.trim().length > 60 || /[\u0000-\u001f\u007f]/u.test(input.fullName))) {
      throw new RecruitingWorkflowError('VALIDATION_ERROR', '候选人姓名须为 1 至 60 个字符，不能包含控制字符', 400)
    }
    if (this.repository) {
      const item = await this.repository.updateCandidate(id, { ...(input.fullName === undefined ? {} : { name: input.fullName }), ...(input.email === undefined ? {} : { email: input.email }), ...(input.phone === undefined ? {} : { phone: input.phone }), ...(input.source === undefined ? {} : { source: input.source }), ...(input.status === undefined ? {} : { consentStatus: input.status }) })
      return { id: item.id, code: item.businessId, fullName: item.name, ...(item.email ? { email: item.email } : {}), ...(item.phone ? { phone: item.phone } : {}), ...(item.source ? { source: item.source } : {}), status: item.consentStatus === 'do_not_contact' ? 'do_not_contact' : 'active', createdAt: item.createdAt, updatedAt: item.updatedAt }
    }
    return this.store.transaction((state) => {
      const candidate = candidateOrThrow(state, id)
      const fromStatus = candidate.status
      if (input.fullName !== undefined) { candidate.fullName = required(input.fullName, '候选人姓名'); candidate.nameManuallyEdited = true }
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

  async deleteApplication(id: string, actorId = 'user-demo'): Promise<{ candidateDeleted: boolean }> {
    if (this.repository) return this.repository.deleteApplication(id, actorId)
    const result = await this.store.transaction((state) => {
      const application = applicationOrThrow(state, id)
      if (state.interviews.some((item) => item.applicationId === application.id)
        || state.offers.some((item) => item.applicationId === application.id)
        || state.onboarding.some((item) => item.applicationId === application.id)) {
        throw new RecruitingWorkflowError('APPLICATION_IN_USE', '此岗位申请已有面试、Offer 或入职记录，不能直接删除，请先处理关联流程。')
      }
      const candidateDeleted = !state.applications.some((item) => item.candidateId === application.candidateId && item.id !== application.id)
      const resumes = state.resumes.filter((item) => item.candidateId === application.candidateId)
      const sharedResumeIds = new Set([...state.analysisTasks, ...state.analysisResults]
        .filter((item) => item.applicationId && item.applicationId !== application.id).map((item) => item.resumeId))
      const targetResumeIds = new Set([...state.analysisTasks, ...state.analysisResults]
        .filter((item) => item.applicationId === application.id).map((item) => item.resumeId))
      const deletedResumes = resumes.filter((item) => candidateDeleted
        || (item.applicationId === application.id || !item.applicationId && targetResumeIds.has(item.id)) && !sharedResumeIds.has(item.id))
      const resumeIds = new Set(deletedResumes.map((item) => item.id))
      const related = (item: { resumeId: string; applicationId?: string }) => item.applicationId === application.id || resumeIds.has(item.resumeId)
      if (state.analysisTasks.some((item) => related(item) && item.status === 'processing')) {
        throw new RecruitingWorkflowError('APPLICATION_ANALYSIS_IN_PROGRESS', '此岗位申请或其关联简历的 AI 分析正在进行，请等待分析结束后再删除。')
      }
      state.analysisResults = state.analysisResults.filter((item) => !related(item))
      state.analysisTasks = state.analysisTasks.filter((item) => !related(item))
      state.resumes = state.resumes.filter((item) => !resumeIds.has(item.id))
      for (const resume of state.resumes) {
        if (resume.applicationId === application.id) delete resume.applicationId
      }
      state.applications = state.applications.filter((item) => item.id !== application.id)
      if (candidateDeleted) {
        state.candidates = state.candidates.filter((item) => item.id !== application.candidateId)
        addEvent(state, { subjectType: 'candidate', subjectId: application.candidateId, action: 'delete', actorId,
          metadata: { applicationCount: 1, resumeCount: deletedResumes.length, reason: 'last_application_deleted', applicationId: application.id } })
      }
      addEvent(state, { subjectType: 'application', subjectId: application.id, action: 'delete', actorId,
        metadata: { candidateId: application.candidateId, candidateDeleted, deletedResumeCount: deletedResumes.length, resumesRetained: resumes.length > deletedResumes.length } })
      return { candidateDeleted, storageKeys: deletedResumes.map((item) => item.storageKey) }
    })
    for (const key of result.storageKeys) {
      await this.objectStorage.delete(key).catch(() => console.warn('Application deleted; resume object cleanup failed'))
    }
    return { candidateDeleted: result.candidateDeleted }
  }

  async createApplication(input: CreateApplicationInput, actorId = 'user-demo'): Promise<ApplicationRecord> {
    if (this.repository) {
      const item = await this.repository.createApplication({ candidateId: required(input.candidateId, '候选人'), jobId: required(input.jobId, '岗位'), ...(input.source ? { source: input.source } : {}) })
      return { id: item.id, code: item.businessId, candidateId: item.candidateId, jobId: item.jobId, status: item.status as ApplicationRecord['status'], ...(item.source ? { source: item.source } : {}), aiStatus: 'pending', appliedAt: item.appliedAt, updatedAt: item.updatedAt }
    }
    return this.store.transaction((state) => {
      candidateOrThrow(state, required(input.candidateId, '候选人'))
      jobOrThrow(state, required(input.jobId, '岗位'))
      if (state.applications.some((item) => item.candidateId === input.candidateId && item.jobId === input.jobId)) throw new RecruitingWorkflowError('APPLICATION_ALREADY_EXISTS', '该候选人已申请此岗位，请在原申请上继续处理；简历筛选通过后请选择“安排面试”，无需新建申请。', 409)
      const timestamp = LocalRecruitingStore.timestamp()
      const application: ApplicationRecord = { id: randomUUID(), code: `APP-${state.nextApplicationNumber++}`, candidateId: input.candidateId, jobId: input.jobId, ...(input.source ? { source: clean(input.source) } : {}), status: 'pending_analysis', aiStatus: 'pending', appliedAt: timestamp, updatedAt: timestamp }
      state.applications.push(application)
      addEvent(state, { subjectType: 'application', subjectId: application.id, action: 'create', actorId })
      return application
    })
  }

  async listApplications(candidateId?: string, jobId?: string, departmentId?: string, offerEligibleOnly = false): Promise<ApplicationRecord[]> {
    const jobIds = departmentId ? await this.jobIdsInDepartment(departmentId) : undefined
    if (this.repository) {
      const rows = await this.repository.listApplications(candidateId, jobId, offerEligibleOnly)
      const mapped: ApplicationRecord[] = rows.map((item) => ({ id: item.id, code: item.businessId, candidateId: item.candidateId, jobId: item.jobId, status: item.status as ApplicationRecord['status'], ...(item.source ? { source: item.source } : {}), aiStatus: 'pending', appliedAt: item.appliedAt, updatedAt: item.updatedAt }))
      return jobIds ? mapped.filter((item) => jobIds.has(item.jobId)) : mapped
    }
    const state = departmentId ? filterStateByDepartment(await this.store.read(), departmentId) : await this.store.read()
    return state.applications.filter((item) => (!candidateId || item.candidateId === candidateId) && (!jobId || item.jobId === jobId) && (!offerEligibleOnly || isLocalOfferEligible(item, state)))
  }

  async listInterviews(applicationId?: string, departmentId?: string): Promise<Array<InterviewRecord & InterviewResult & { feedbackStatus: InterviewFeedbackRecord['status'] | 'pending'; application: ApplicationRecord }>> {
    const state = await this.stateView(departmentId)
    const interviews = state.interviews.filter(i => !applicationId || i.applicationId === applicationId)
    const results = this.repository ? await this.repository.listInterviewResults(interviews.map(i => i.id)) : null
    return interviews.map(interview => {
      const feedback = state.interviewFeedback.filter(x => x.interviewId === interview.id)
      const event = [...state.workflowEvents].reverse().find(e => e.subjectType === 'interview' && e.subjectId === interview.id && ['conclude', 'correct_conclusion'].includes(e.action))
      const result = results?.get(interview.id) ?? { outcome: interviewOutcome(event?.metadata?.outcome), aiScore: null, aiScoreStatus: 'none' }
      return { ...interview, ...result, application: applicationOrThrow(state, interview.applicationId), feedbackStatus: feedback.length && feedback.every(x => x.status === 'locked') ? 'locked' as const : feedback.length ? feedback[0]!.status : 'pending' as const }
    })
  }

  async getInterview(id: string): Promise<InterviewRecord & InterviewResult & { feedbackStatus: InterviewFeedbackRecord['status'] | 'pending'; application: ApplicationRecord; feedback: InterviewFeedbackRecord[] }> {
    const state = await this.stateView()
    const interview = state.interviews.find((x) => x.id === id)
    if (!interview) throw new RecruitingNotFoundError(`未找到面试：${id}`)
    const feedback = state.interviewFeedback.filter((x) => x.interviewId === id).map((item) => ({ ...item }))
    const feedbackStatus = feedback.length && feedback.every((x) => x.status === 'locked') ? 'locked' : feedback.length ? feedback[0]!.status : 'pending'
    const event = [...state.workflowEvents].reverse().find((item) => item.subjectType === 'interview' && item.subjectId === id && ['conclude', 'correct_conclusion'].includes(item.action))
    const result = this.repository
      ? (await this.repository.listInterviewResults([id])).get(id)
      : undefined
    return {
      ...interview,
      ...(result ?? { outcome: interviewOutcome(event?.metadata?.outcome), aiScore: null, aiScoreStatus: 'none' }),
      application: applicationOrThrow(state, interview.applicationId),
      feedbackStatus,
      feedback,
    }
  }

  async getInterviewQuestionContext(id: string): Promise<{
    jobTitle: string
    jobRequirements: string[]
    anonymizedResume: string
    analysisSummary: string[]
    questionCount: number
    stage: 'initial' | 'final'
  }> {
    const interview = await this.getInterview(id)
    const [candidate, job] = await Promise.all([
      this.getCandidate(interview.application.candidateId),
      this.getJob(interview.application.jobId),
    ])
    const { resume, latest } = this.resolveApplicationResume(interview.application.id, candidate)
    if (resume) requireCleanResume(resume.scanStatus)
    const result = latest?.result
    const nested = (result?.analysis as { report?: Record<string, unknown> } | undefined)?.report
    const report = { ...nested, ...result, parsedResume: result?.parsedResume ?? nested?.parsedResume, extraction: result?.extraction ?? nested?.extraction, assessment: result?.assessment ?? nested?.assessment } as {
      parsedResume?: { normalizedText?: string; originalText?: string }
      extraction?: {
        profile?: { headline?: string; summary?: string; totalExperienceYears?: number }
        experience?: Array<{ employer?: string; title?: string; description?: string; evidence?: string }>
        education?: Array<{ institution?: string; degree?: string; fieldOfStudy?: string; evidence?: string }>
        skills?: Array<{ value?: string; canonical?: string }>
      }
      assessment?: {
        strengths?: string[]
        risks?: string[]
        matchedRequirements?: Array<{ label?: string; rationale?: string }>
      }
    } | undefined
    const extraction = report?.extraction
    const resumeLines = [
      extraction?.profile?.summary,
      extraction?.profile?.headline,
      ...(extraction?.experience ?? []).map((item) => [item.employer, item.title, item.description, item.evidence].filter(Boolean).join(' · ')),
      ...(extraction?.education ?? []).map((item) => [item.institution, item.degree, item.fieldOfStudy, item.evidence].filter(Boolean).join(' · ')),
      (extraction?.skills ?? []).map((item) => item.value || item.canonical).filter(Boolean).join('、'),
    ].map((item) => clean(item)).filter(Boolean)
    let resumeText = clean(report?.parsedResume?.normalizedText) || clean(report?.parsedResume?.originalText) || resumeLines.join('\n')
    if (!resumeText && resume) {
      const content = await this.getResumeObject(resume.storageKey)
      resumeText = await this.extractText(content, resume.originalFilename, resume.mimeType)
    }
    const requirements = [
      ...(job.spec?.requirements ?? []).map((item) => clean(item.label)),
      ...(job.spec?.skills ?? []).map((item) => clean(item)),
    ].filter(Boolean)
    const analysisSummary = [
      ...(report?.assessment?.strengths ?? []),
      ...(report?.assessment?.risks ?? []),
      ...(report?.assessment?.matchedRequirements ?? []).map((item) => item.rationale || item.label || ''),
    ].map((item) => clean(item)).filter(Boolean)
    return {
      jobTitle: job.title,
      jobRequirements: requirements.length ? requirements : [`具备 ${job.title} 相关经验`],
      anonymizedResume: anonymizeText(resumeText, { replaceNames: true, name: candidate.fullName }).text,
      analysisSummary,
      questionCount: 5,
      stage: interview.stage ?? (interview.round >= 2 ? 'final' : 'initial'),
    }
  }

  async updateInterviewSchedule(id: string, input: unknown, actorId = 'user-demo'): Promise<InterviewRecord> {
    if (this.repository) {
      return this.mapRepositoryInterview(await this.repository.updateInterviewSchedule(id, input, actorId))
    }
    return this.store.transaction((state) => {
      const current = state.interviews.find((item) => item.id === id || item.code === id)
      if (!current) throw new RecruitingNotFoundError(`未找到面试：${id}`)
      const patch = prepareInterviewScheduleUpdate(current, input)
      if (!Object.keys(patch).length) return current
      const before = Object.fromEntries(Object.keys(patch).map((key) => [key, current[key as keyof typeof patch] ?? null]))
      if (patch.scheduledStartAt !== undefined) current.scheduledStartAt = patch.scheduledStartAt
      if (patch.scheduledEndAt !== undefined) {
        if (patch.scheduledEndAt === null) delete current.scheduledEndAt
        else current.scheduledEndAt = patch.scheduledEndAt
      }
      if (patch.location !== undefined) {
        if (patch.location === null) delete current.location
        else current.location = patch.location
      }
      if (patch.meetingUrl !== undefined) {
        if (patch.meetingUrl === null) delete current.meetingUrl
        else current.meetingUrl = patch.meetingUrl
      }
      if (patch.participants !== undefined) current.participants = patch.participants
      current.updatedAt = LocalRecruitingStore.timestamp()
      addEvent(state, { subjectType: 'interview', subjectId: current.id, action: 'update', actorId, reason: '修改面试安排', metadata: { before, after: patch } })
      return current
    })
  }

  async createInterview(input: CreateInterviewInput, actorId = 'user-demo'): Promise<InterviewRecord> {
    if (this.repository) {
      const applicationRow = await this.repository.getApplication(required(input.applicationId, '申请'))
      if (['rejected', 'offer_declined', 'offer_cancelled', 'offer_expired', 'onboarding_archived'].includes(applicationRow.status)) throw new RecruitingWorkflowError('APPLICATION_NOT_INTERVIEWABLE', '当前申请不能安排面试')
      const participants = normalizeInterviewParticipants(input.participants ?? [], input.round && input.round >= 2 ? 'final' : 'initial')
      const existing = await this.repository.listInterviews(applicationRow.id)
      const round = input.round ?? existing.length + 1
      if (!Number.isInteger(round) || round < 1 || round > 2) throw new RecruitingWorkflowError('INTERVIEW_ROUND_LIMIT', '系统仅支持初试和复试两轮面试', 400)
      if (existing.some((item) => item.round === round)) throw new RecruitingWorkflowError('INTERVIEW_ROUND_EXISTS', `${round === 1 ? '初试' : '复试'}已经存在，不能重复创建`, 409)
      if (round !== 1 && !participants.some((item) => item.role === 'interviewer')) throw new RecruitingWorkflowError('INTERVIEWER_REQUIRED', '至少需要一名面试官')
      const created = await this.repository.createInterview({ createdBy: actorId, applicationId: applicationRow.id, round, type: input.type ?? 'other', title: required(input.title, '面试标题'), scheduledStartAt: input.scheduledStartAt ?? null, scheduledEndAt: input.scheduledEndAt ?? null, timezone: input.timezone ? clean(input.timezone) : null, location: input.location ? clean(input.location) : null, meetingUrl: input.meetingUrl ? clean(input.meetingUrl) : null, participants })
      await this.repository.appendWorkflowEvent({ subjectType: 'interview', subjectId: created.id, action: 'create', actorId })
      if (['pending_analysis', 'analysis_queued', 'human_review'].includes(applicationRow.status)) await this.repository.updateApplicationStatus(applicationRow.id, 'interviewing')
      return this.mapRepositoryInterview(created)
    }
    return this.store.transaction((state) => { const application = applicationOrThrow(state, required(input.applicationId, '申请')); if (['rejected', 'offer_declined', 'offer_cancelled', 'offer_expired', 'onboarding_archived'].includes(application.status)) throw new RecruitingWorkflowError('APPLICATION_NOT_INTERVIEWABLE', '当前申请不能安排面试'); const timestamp = LocalRecruitingStore.timestamp(); const existing = state.interviews.filter((x) => x.applicationId === application.id); const round = input.round ?? existing.length + 1; if (!Number.isInteger(round) || round < 1 || round > 2) throw new RecruitingWorkflowError('INTERVIEW_ROUND_LIMIT', '系统仅支持初试和复试两轮面试', 400); if (existing.some((item) => item.round === round)) throw new RecruitingWorkflowError('INTERVIEW_ROUND_EXISTS', `${round === 1 ? '初试' : '复试'}已经存在，不能重复创建`, 409); const participants = normalizeInterviewParticipants(input.participants ?? [], round >= 2 ? 'final' : 'initial'); if (round !== 1 && !participants.some((p) => p.role === 'interviewer')) throw new RecruitingWorkflowError('INTERVIEWER_REQUIRED', '至少需要一名面试官'); const interview: InterviewRecord = { id: randomUUID(), code: `INT-${state.nextInterviewNumber++}`, applicationId: application.id, round, type: input.type ?? 'other', title: required(input.title, '面试标题'), status: 'scheduled', ...(input.scheduledStartAt ? { scheduledStartAt: input.scheduledStartAt } : {}), ...(input.scheduledEndAt ? { scheduledEndAt: input.scheduledEndAt } : {}), ...(input.timezone ? { timezone: clean(input.timezone) } : {}), ...(input.location ? { location: clean(input.location) } : {}), ...(input.meetingUrl ? { meetingUrl: clean(input.meetingUrl) } : {}), participants, createdAt: timestamp, updatedAt: timestamp }; state.interviews.push(interview); addEvent(state, { subjectType: 'interview', subjectId: interview.id, action: 'create', actorId }); if (application.status === 'pending_analysis' || application.status === 'analysis_queued' || application.status === 'human_review') application.status = 'interviewing'; application.updatedAt = timestamp; return interview }) }

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

  async deleteInterview(id: string, actorId = 'user-demo'): Promise<void> {
    if (this.repository) {
      const interview = await this.repository.getInterview(id)
      await this.repository.deleteInterview(interview.id)
      await this.repository.appendWorkflowEvent({ subjectType: 'interview', subjectId: interview.id, action: 'delete', actorId })
      return
    }
    await this.store.transaction((state) => {
      const index = state.interviews.findIndex((item) => item.id === id || item.code === id)
      if (index < 0) throw new RecruitingNotFoundError(`未找到面试：${id}`)
      const interview = state.interviews[index]!
      state.interviews.splice(index, 1)
      state.interviewFeedback = state.interviewFeedback.filter((item) => item.interviewId !== interview.id)
      addEvent(state, { subjectType: 'interview', subjectId: interview.id, action: 'delete', actorId })
    })
  }

  async completeInterview(id: string, outcome: 'continue' | 'offer' | 'reject' | 'cancelled', actorId = 'user-demo'): Promise<InterviewRecord> {
    return this.concludeInterview(id, outcome, actorId, true)
  }

  async concludeInterview(id: string, outcome: 'continue' | 'offer' | 'reject' | 'cancelled', actorId = 'user-demo', directCompletion = false): Promise<InterviewRecord> {
    if (this.repository) {
      return this.mapRepositoryInterview(await this.repository.concludeInterview(id, outcome, actorId, directCompletion))
    }
    if (!['continue', 'offer', 'reject', 'cancelled'].includes(outcome)) throw new RecruitingWorkflowError('INVALID_INTERVIEW_OUTCOME', '无效的面试结论')
    return this.store.transaction((state) => {
      const interview = state.interviews.find((item) => item.id === id || item.code === id)
      if (!interview) throw new RecruitingNotFoundError(`未找到面试：${id}`)
      validateInterviewOutcome(interview, outcome)
      const application = applicationOrThrow(state, interview.applicationId)
      const previous = [...state.workflowEvents].reverse().find((event) => event.subjectId === interview.id && event.action === 'conclude')
      if (interview.status === 'cancelled') {
        if (previous?.metadata?.outcome === 'cancelled' && outcome === 'cancelled') return interview
        throw new RecruitingWorkflowError('INTERVIEW_CANCELLED', '已取消的面试不能确认其他结论', 409)
      }
      if (previous && previous.metadata?.outcome !== outcome) throw new RecruitingWorkflowError('INTERVIEW_ALREADY_CONCLUDED', '该面试已确认其他结论，请在当前面试阶段继续处理', 409)
      const completingFinalOffer = application.status === 'offer_approval' && outcome === 'offer' && (interview.stage === 'final' || interview.round >= 2)
      if (!previous && !['interviewing', 'human_review'].includes(application.status) && !completingFinalOffer) throw new RecruitingWorkflowError('APPLICATION_NOT_INTERVIEWABLE', '当前申请状态不能确认面试结论', 409)
      if (!previous && !directCompletion && outcome !== 'cancelled') {
        const feedback = state.interviewFeedback.filter((item) => item.interviewId === interview.id)
        const missingRequired = interview.participants.some((person) => person.required && (person.role ?? 'interviewer') === 'interviewer'
          && !feedback.some((item) => item.interviewerId === person.userId && item.status === 'locked'))
        if (!feedback.length || feedback.some((item) => item.status !== 'locked') || missingRequired) throw new RecruitingWorkflowError('INTERVIEW_FEEDBACK_INCOMPLETE', '所有面试官反馈锁定后才能完成面试')
      }
      const now = LocalRecruitingStore.timestamp()
      if ((interview.stage === 'initial' || (!interview.stage && interview.round === 1)) && outcome === 'continue') {
        const existing = state.interviews.some((item) => item.applicationId === application.id && (item.stage === 'final' || item.round >= 2))
        if (!existing) {
          if (!['interviewing', 'human_review'].includes(application.status)) throw new RecruitingWorkflowError('APPLICATION_NOT_INTERVIEWABLE', '当前申请状态不能进入复试', 409)
          const next: InterviewRecord = { id: randomUUID(), code: `INT-${state.nextInterviewNumber++}`, applicationId: application.id, round: 2, stage: 'final', type: interview.type, title: '第二轮复试', status: 'scheduled', ...(interview.timezone ? { timezone: interview.timezone } : {}), participants: interview.participants.map((person) => ({ ...person })), createdAt: now, updatedAt: now }
          state.interviews.push(next)
          addEvent(state, { subjectType: 'application', subjectId: application.id, action: 'advance_to_final_interview', actorId, fromStatus: application.status, toStatus: 'interviewing', metadata: { interviewId: next.id, round: 2, stage: 'final' } })
        }
      }
      if (previous) return interview
      const fromStatus = interview.status
      interview.status = outcome === 'cancelled' ? 'cancelled' : 'completed'
      interview.updatedAt = now
      application.status = outcome === 'offer' ? 'offer_approval' : outcome === 'reject' ? 'rejected' : 'interviewing'
      if (outcome === 'reject') application.rejectionReason = '面试未通过'
      application.updatedAt = now
      addEvent(state, { subjectType: 'interview', subjectId: interview.id, action: 'conclude', fromStatus, toStatus: interview.status, actorId, metadata: { outcome, ...(directCompletion ? { completionMode: 'direct' } : {}) } })
      return interview
    })
  }

  async correctInterviewConclusion(id: string, outcome: 'continue' | 'offer' | 'reject' | 'cancelled', reason: string, actorId = 'user-demo'): Promise<InterviewRecord> {
    const normalizedReason = clean(reason)
    if (!normalizedReason || normalizedReason.length > 1000) throw new RecruitingWorkflowError('INTERVIEW_CORRECTION_REASON_REQUIRED', '请填写不超过 1000 个字符的更正原因', 400)
    if (this.repository) return this.mapRepositoryInterview(await this.repository.correctInterviewConclusion(id, outcome, normalizedReason, actorId))
    if (!['continue', 'offer', 'reject', 'cancelled'].includes(outcome)) throw new RecruitingWorkflowError('INVALID_INTERVIEW_OUTCOME', '无效的面试结论', 400)
    return this.store.transaction((state) => {
      const interview = state.interviews.find((item) => item.id === id || item.code === id)
      if (!interview) throw new RecruitingNotFoundError(`未找到面试：${id}`)
      validateInterviewOutcome(interview, outcome)
      const application = applicationOrThrow(state, interview.applicationId)
      const previous = [...state.workflowEvents].reverse().find((event) => event.subjectType === 'interview' && event.subjectId === interview.id && ['conclude', 'correct_conclusion'].includes(event.action))
      const previousOutcome = previous?.metadata?.outcome
      if (!previousOutcome || !['continue', 'offer', 'reject', 'cancelled'].includes(String(previousOutcome))) throw new RecruitingWorkflowError('INTERVIEW_NOT_CONCLUDED', '该面试尚无可更正的结论', 409)
      if (previousOutcome === outcome) throw new RecruitingWorkflowError('INTERVIEW_CONCLUSION_UNCHANGED', '新结论与当前结论相同', 400)
      const stage = interview.stage === 'final' || interview.round >= 2 ? 'final' : 'initial'
      const downstream = state.interviews.some(item => item.applicationId === application.id && item.round > interview.round
        && (item.status === 'completed' || state.interviewFeedback.some(feedback => feedback.interviewId === item.id)))
      if (downstream || state.offers.some(item => item.applicationId === application.id) || state.onboarding.some(item => item.applicationId === application.id)) {
        throw new RecruitingWorkflowError('INTERVIEW_CONCLUSION_HAS_DOWNSTREAM', '后续面试、Offer 或入职流程已建立，不能直接更正；请先处理后续流程记录', 409)
      }
      const autoCreatedFinalInterviewIds = new Set(state.workflowEvents
        .filter(event => event.subjectType === 'application' && event.subjectId === application.id && event.action === 'advance_to_final_interview')
        .map(event => event.metadata?.interviewId)
        .filter((interviewId): interviewId is string => typeof interviewId === 'string'))
      if (stage === 'initial' && previousOutcome === 'continue' && outcome !== 'continue') {
        for (const next of state.interviews.filter(item => autoCreatedFinalInterviewIds.has(item.id) && item.applicationId === application.id && item.round > interview.round && item.status === 'scheduled')) next.status = 'cancelled'
      }
      if (stage === 'initial' && previousOutcome !== 'continue' && outcome === 'continue') {
        const next = state.interviews.find(item => autoCreatedFinalInterviewIds.has(item.id) && item.applicationId === application.id && item.round > interview.round && item.status === 'cancelled')
        if (next) next.status = 'scheduled'
        else {
          const now = LocalRecruitingStore.timestamp()
          state.interviews.push({ id: randomUUID(), code: `INT-${state.nextInterviewNumber++}`, applicationId: application.id, round: 2, stage: 'final', type: interview.type, title: '第二轮复试', status: 'scheduled', participants: interview.participants.map(person => ({ ...person })), createdAt: now, updatedAt: now })
        }
      }
      const now = LocalRecruitingStore.timestamp()
      const fromStatus = interview.status
      interview.status = outcome === 'cancelled' ? 'cancelled' : 'completed'
      interview.updatedAt = now
      application.status = outcome === 'offer' ? 'offer_approval' : outcome === 'reject' ? 'rejected' : 'interviewing'
      if (outcome === 'reject') application.rejectionReason = '面试未通过'
      else delete application.rejectionReason
      application.updatedAt = now
      addEvent(state, { subjectType: 'interview', subjectId: interview.id, action: 'correct_conclusion', actorId, fromStatus: String(previousOutcome), toStatus: interview.status, reason: normalizedReason, metadata: { previousOutcome, outcome } })
      return interview
    })
  }

  async assignInterviewResponsibilities(id: string, input: unknown, actorId: string): Promise<InterviewRecord> {
    if (this.repository) return this.mapRepositoryInterview(await this.repository.assignInterviewResponsibilities(id,input,actorId))
    return this.store.transaction(state => {
      const current = state.interviews.find(row => row.id === id || row.code === id)
      if (!current) throw new RecruitingNotFoundError('未找到面试')
      if (current.status === 'cancelled') throw new RecruitingWorkflowError('VALIDATION_ERROR','已取消的面试不能重新分配',400)
      const participants = normalizeInterviewParticipants(input,current.stage ?? (current.round >= 2 ? 'final' : 'initial'))
      if (!participants.some(person => person.lead)) throw new RecruitingWorkflowError('VALIDATION_ERROR','请选择面试负责人并分配评分表',400)
      current.participants = participants; current.updatedAt = new Date().toISOString()
      return current
    })
  }

  async interviewResponsibilities(applicationId: string, userId: string, admin = false) {
    const interviews = (await this.listInterviews(applicationId)).filter(row => row.status !== 'cancelled').sort((a,b) => b.round-a.round || b.createdAt.localeCompare(a.createdAt))
    return (['initial','final'] as const).map(stage => {
      const participants = interviews.find(row => (row.stage ?? (row.round >= 2 ? 'final' : 'initial')) === stage)?.participants ?? []
      return { stage, lead: admin || participants.some(person => person.userId === userId && person.lead),
        sheetTypes: admin ? stage === 'initial' ? ['hr_screen','hiring_department'] : ['business','hr','boss'] : participants.filter(person => person.userId === userId && person.role === 'interviewer').flatMap(person => person.sheetTypes ?? []) }
    })
  }

  async assertInterviewResponsibility(applicationId: string, stage: 'initial' | 'final', userId: string, sheetType?: string): Promise<void> {
    const interviews = (await this.listInterviews(applicationId)).filter(row => row.status !== 'cancelled' && (row.stage ?? (row.round >= 2 ? 'final' : 'initial')) === stage)
      .sort((a, b) => b.round - a.round || b.createdAt.localeCompare(a.createdAt))
    const participants = interviews[0]?.participants ?? []
    const assigned = participants.filter(person => person.role === 'interviewer' && (sheetType ? person.sheetTypes?.includes(sheetType as import('./interview-responsibilities.js').AssignedSheetType) : person.lead))
    if (!assigned.some(person => person.userId === userId)) throw new RecruitingWorkflowError('INTERVIEW_RESPONSIBILITY_REQUIRED', '此事项未分配给你，请联系面试负责人或企业管理员', 403)
  }

  async getDashboardSummary(departmentId?: string, loadReviews?: (interviewIds: string[]) => Promise<DashboardInterviewReview[]>, input: { from?: string | undefined; to?: string | undefined; timeZone?: string | undefined; userId?: string; todoScope?: 'mine' | 'enterprise' | 'unassigned'; ownership?: {activeUserIds:string[];fallbackUserId?:string | undefined} | undefined } = {}): Promise<DashboardSummary> {
    const period = parseDashboardPeriod(input)
    const state = await this.stateView(departmentId)
    let activity: DashboardActivity | undefined
    if (period) {
      const events = this.repository ? await this.repository.listDashboardActivityEvents(period.to) : state.workflowEvents
      activity = dashboardActivity({ ...state, workflowEvents: events as RecruitingStoreState['workflowEvents'] }, period)
    }
    const reviews = loadReviews ? await loadReviews(state.interviews.filter(row => row.status !== 'cancelled').map(row => row.id)) : []
    // Todos represent outstanding work, not activity during the selected reporting period.
    const todos = buildDashboardTodos(state, reviews, input.userId ? { userId: input.userId, scope: input.todoScope ?? 'mine' } : undefined, input.ownership)
    const applications = state.applications
    const count = (statuses: string[]) => applications.filter((item) => statuses.includes(item.status)).length
    const counts = activity ? [activity.counts.applications, activity.counts.screened, activity.counts.interviews, activity.counts.offers, activity.counts.onboarded] : [applications.length, count(['human_review', 'interviewing', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['interviewing', 'offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['offer_approval', 'offer_sent', 'offer_accepted', 'onboarding_archived']), count(['onboarding_archived'])]
    const funnel = ['收到申请', '通过筛选', '进入面试', '发出 Offer', '已入职'].map((stage, index) => ({ stage, count: counts[index]!, conversionRate: activity || index === 0 ? null : counts[index - 1] ? Math.round(counts[index]! / counts[index - 1]! * 10000) / 100 : 0 }))
    const metrics: DashboardSummary['metrics'] = [
      { label: '简历数量', value: activity?.counts.resumes ?? state.resumes.length, detail: period ? '所选时段上传的简历数' : '已上传的简历总数' },
      { label: '通过筛选', value: counts[1]!, detail: activity ? '所选时段通过筛选的人数' : (funnel[1]!.conversionRate ?? 0) + '% 转化率' },
      { label: '进入面试', value: counts[2]!, detail: activity ? '所选时段进入面试的人数' : (funnel[2]!.conversionRate ?? 0) + '% 转化率' },
      { label: '发出 Offer', value: counts[3]!, detail: activity ? '所选时段实际发出 Offer 的人数' : (funnel[3]!.conversionRate ?? 0) + '% 转化率' },
    ]
    const pendingApprovals = state.recruitmentRequests
      .filter((request) => request.status === 'pending_approval' && todos.some(todo => todo.id === `request-${request.id}`))
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const pendingInterviews = state.interviews
      .filter((interview) => interview.status === 'scheduled' && !!interview.scheduledStartAt)
      .map((interview) => {
        const application = state.applications.find((item) => item.id === interview.applicationId)
        const candidate = application ? state.candidates.find((item) => item.id === application.candidateId) : undefined
        const job = application ? state.jobs.find((item) => item.id === application.jobId) : undefined
        return { ...interview, application: application!, candidateName: candidate?.fullName || '未知候选人', jobTitle: job?.title || '未知岗位' }
      })
      .filter((interview) => todos.some(todo => todo.id === `complete-${interview.id}`))
      .sort((a, b) => (a.scheduledStartAt ?? a.updatedAt).localeCompare(b.scheduledStartAt ?? b.updatedAt))
    const failedTasks = state.analysisTasks
      .filter((task) => task.status === 'failed' && todos.some(todo => todo.id === `analysis-${task.id}`))
      .slice()
      .sort((a, b) => b.availableAt.localeCompare(a.availableAt))
    return { generatedAt: LocalRecruitingStore.timestamp(), ...(activity ? { activity } : {}), todos, metrics, funnel, pendingApprovals, pendingInterviews, failedTasks }
  }

  async getReports(departmentId?: string, filters: ReportFilters = {}): Promise<RecruitingReport & { filterOptions: ReturnType<typeof reportFilterOptions> }> {
    const scoped = await this.stateView(departmentId)
    let state: RecruitingStoreState
    try { state = filterReportState(scoped, filters) } catch (cause) { throw new RecruitingWorkflowError('REPORT_FILTER_INVALID', cause instanceof Error ? cause.message : '报表筛选条件无效', 400) }
    const applications = state.applications
    const count = (statuses: string[]) => applications.filter((item) => statuses.includes(item.status)).length
    const offeredApplicationIds = new Set(state.offers.filter((item) => item.sentAt || ['sent', 'accepted', 'declined', 'expired'].includes(item.status)).map((item) => item.applicationId))
    const hasSentOffer = (item: ApplicationRecord) => offeredApplicationIds.has(item.id) || ['offer_sent', 'offer_accepted', 'offer_declined', 'offer_expired', 'onboarding_archived'].includes(item.status)
    const hasInterview = (item: ApplicationRecord) => hasSentOffer(item) || ['interviewing', 'offer_approval'].includes(item.status) || state.interviews.some((interview) => interview.applicationId === item.id)
    const hasScreened = (item: ApplicationRecord) => hasInterview(item) || item.status === 'human_review'
    const counts = [applications.length, applications.filter(hasScreened).length, applications.filter(hasInterview).length, applications.filter(hasSentOffer).length, count(['onboarding_archived'])]
    const stages = ['收到申请', '通过筛选', '进入面试', '发出 Offer', '已入职']
    const funnel = stages.map((stage, index) => ({ stage, count: counts[index]!, conversionRate: index === 0 ? null : counts[index - 1] ? Math.round(counts[index]! / counts[index - 1]! * 10000) / 100 : 0 }))
    const statusStats: RecruitingReport['statusStats'] = []
    const statuses = (entity: string, values: string[], records: Array<{ status: string }>) => values.forEach((status) => { const value = records.filter((item) => item.status === status).length; if (value) statusStats.push({ entity, status, count: value }) })
    statuses('招聘需求', ['draft', 'pending_approval', 'approved', 'rejected', 'closed'], state.recruitmentRequests); statuses('岗位', ['draft', 'ready', 'published', 'paused', 'closed'], state.jobs); statuses('申请', ['pending_analysis','analysis_queued','human_review','interviewing','offer_approval','offer_sent','offer_accepted','onboarding_archived','rejected','offer_declined','offer_cancelled','offer_expired'], applications)
    const jobFilling = state.jobs.map((job) => { const cohortFilled = applications.filter((item) => item.jobId === job.id && item.status === 'onboarding_archived').length; const filledCount = Object.values(filters).some(Boolean) ? cohortFilled : Math.max(job.filledCount, cohortFilled); return { jobId: job.id, code: job.code, title: job.title, headcount: job.headcount, filledCount, openCount: Math.max(job.headcount - filledCount, 0), fillRate: job.headcount ? Math.round(filledCount / job.headcount * 10000) / 100 : 0 } })
    const channelMap = new Map<string, RecruitingReport['channels'][number]>()
    applications.forEach((application) => { const candidate = state.candidates.find((item) => item.id === application.candidateId); const channel = reportChannel(application.source || candidate?.source); const row = channelMap.get(channel) ?? { channel, applications: 0, screened: 0, interviewed: 0, offers: 0, hired: 0, conversionRate: 0 }; row.applications++; if (hasScreened(application)) row.screened++; if (hasInterview(application)) row.interviewed++; if (hasSentOffer(application)) row.offers++; if (application.status === 'onboarding_archived') row.hired++; row.conversionRate = Math.round(row.hired / row.applications * 10000) / 100; channelMap.set(channel, row) })
    const hiredApplications = applications.filter((item) => item.status === 'onboarding_archived')
    const hireDurations = hiredApplications.map((item) => Math.max(0, (Date.parse(item.updatedAt) - Date.parse(item.appliedAt)) / 86400000)).sort((a, b) => a - b)
    const middle = Math.floor(hireDurations.length / 2)
    const median = hireDurations.length ? (hireDurations.length % 2 ? hireDurations[middle]! : (hireDurations[middle - 1]! + hireDurations[middle]!) / 2) : null
    const recruitmentCycle = { averageDaysToHire: hireDurations.length ? Math.round(hireDurations.reduce((sum, value) => sum + value, 0) / hireDurations.length * 10) / 10 : null, medianDaysToHire: median === null ? null : Math.round(median * 10) / 10, hiredCount: hiredApplications.length }
    const completedInterviewIds = new Set(state.interviews.filter((item) => item.status === 'completed').map((item) => item.id))
    const expectedFeedbackKeys = new Set(state.interviews.filter((item) => completedInterviewIds.has(item.id)).flatMap((item) => item.participants.filter((participant) => participant.role === 'interviewer').map((participant) => `${item.id}:${participant.userId}`)))
    const expectedFeedback = expectedFeedbackKeys.size
    const lockedFeedback = new Set(state.interviewFeedback.filter((item) => expectedFeedbackKeys.has(`${item.interviewId}:${item.interviewerId}`) && item.status === 'locked').map((item) => `${item.interviewId}:${item.interviewerId}`)).size
    const feedbackCompletion = { expected: expectedFeedback, locked: lockedFeedback, completionRate: expectedFeedback ? Math.round(lockedFeedback / expectedFeedback * 10000) / 100 : null }
    const sentOffers = state.offers.filter((item) => item.sentAt || ['sent', 'accepted', 'declined', 'expired'].includes(item.status)).length
    const acceptedOffers = state.offers.filter((item) => item.status === 'accepted').length
    const offerAcceptance = { sent: sentOffers, accepted: acceptedOffers, acceptanceRate: sentOffers ? Math.round(acceptedOffers / sentOffers * 10000) / 100 : null }
    return { filterOptions: reportFilterOptions(scoped), generatedAt: LocalRecruitingStore.timestamp(), summary: [{ label: '收到申请', value: counts[0]!, detail: '全部申请记录' }, { label: '通过筛选', value: counts[1]!, detail: `${funnel[1]!.conversionRate}% 转化率` }, { label: '进入面试', value: counts[2]!, detail: `${funnel[2]!.conversionRate}% 转化率` }, { label: '发出 Offer', value: counts[3]!, detail: `${funnel[3]!.conversionRate}% 转化率` }], funnel, statusStats, jobFilling, channels: [...channelMap.values()].sort((a, b) => b.applications - a.applications), recruitmentCycle, feedbackCompletion, offerAcceptance }
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

  private resolveApplicationResume(applicationId: string, candidate: Awaited<ReturnType<RecruitingService['getCandidate']>>) {
    const owned = new Map(candidate.resumes.map(resume => [resume.id, resume]))
    const tasks = new Map(candidate.analysisTasks.filter(task => owned.has(task.resumeId)).map(task => [task.id, task]))
    const resultApplication = (result: AnalysisResultRecord) => result.applicationId
      ?? (tasks.get(result.analysisTaskId)?.resumeId === result.resumeId ? tasks.get(result.analysisTaskId)?.applicationId : undefined)
      ?? owned.get(result.resumeId)?.applicationId
    const associations = [
      ...candidate.resumes.filter(resume => resume.applicationId === applicationId).map(resume => ({ resumeId: resume.id, createdAt: resume.createdAt })),
      ...candidate.analysisTasks.filter(task => task.applicationId === applicationId && owned.has(task.resumeId)),
      ...candidate.analysisResults.filter(result => resultApplication(result) === applicationId && owned.has(result.resumeId))
        .map(result => ({ resumeId: result.resumeId, createdAt: tasks.get(result.analysisTaskId)?.createdAt ?? result.createdAt })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.resumeId.localeCompare(a.resumeId))
    // Reused files keep their original applicationId; tasks/results carry the new association.
    const resume = associations.length ? owned.get(associations[0]!.resumeId) : [...candidate.resumes]
      .filter(item => !item.applicationId
        && !candidate.analysisTasks.some(task => task.resumeId === item.id && task.applicationId)
        && !candidate.analysisResults.some(result => result.resumeId === item.id && result.applicationId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
    const results = resume ? candidate.analysisResults.filter(result => result.resumeId === resume.id
      && (resultApplication(result) === applicationId || !resultApplication(result))) : []
    const latest = results.sort((a, b) => Number(resultApplication(b) === applicationId) - Number(resultApplication(a) === applicationId)
      || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
    return { resume, latest }
  }

  async getApplicationResume(applicationId: string): Promise<Omit<ResumeRecord, 'storageKey'> | null> {
    const application = this.repository ? await this.repository.getApplication(applicationId) : applicationOrThrow(await this.store.read(), applicationId)
    const candidate = await this.getCandidate(application.candidateId)
    const { resume } = this.resolveApplicationResume(application.id, candidate)
    if (!resume) return null
    const { storageKey: _storageKey, ...metadata } = resume
    return metadata
  }

  async getResumeDocument(candidateId: string, resumeId: string) {
    const resume = this.repository
      ? await this.repository.getResume(resumeId)
      : resumeOrThrow(await this.store.read(), resumeId)
    if (resume.candidateId !== candidateId) throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历与候选人不一致', 404)
    requireCleanResume(resume.scanStatus)
    const content = await this.getResumeObject(resume.storageKey)
    let previewHtml: string | undefined
    if (resume.originalFilename.toLowerCase().endsWith('.docx')) {
      // Conversion failure must not prevent downloading the original bytes.
      try { previewHtml = (await mammoth.convertToHtml({ buffer: content })).value } catch { /* Download remains available. */ }
    }
    return { originalFilename: resume.originalFilename, mimeType: resume.mimeType, content: content.toString('base64'), ...(previewHtml ? { previewHtml } : {}) }
  }

  /** Queue a fresh parse for an already-uploaded resume without changing the source file. */
  async reanalyzeResume(candidateId: string, resumeId: string, actorId = 'user-demo'): Promise<AnalysisTaskRecord> {
    if (this.repository) {
      const resume = await this.repository.getResume(resumeId)
      if (resume.candidateId !== candidateId) throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历与候选人不一致')
      requireCleanResume(resume.scanStatus)
      const tasks = await this.repository.listAnalysisTasks()
      const active = tasks.find((task) => task.resumeId === resumeId && (task.applicationId ?? null) === (resume.applicationId ?? null) && ['queued', 'processing'].includes(task.status))
      if (active) return mapRepositoryAnalysisTask(active)
      // Reject broken job ownership before enqueueing; the Worker also checks
      // queued tasks and configuration changed after this preflight.
      if (resume.applicationId) {
        const application = await this.repository.getApplication(resume.applicationId)
        if (application.candidateId !== candidateId) throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历、候选人与申请不一致', 400)
        await this.repository.assertJobAnalysisContextScope(application.jobId)
      }
      const created = await this.repository.createAnalysisTask({
        resumeId,
        ...(resume.applicationId ? { applicationId: resume.applicationId } : {}),
        idempotencyKey: `resume-reanalysis:${resumeId}:${randomUUID()}`,
      })
      await this.repository.appendWorkflowEvent({
        subjectType: 'candidate',
        subjectId: candidateId,
        action: 'resume_reanalysis_requested',
        actorId,
      })
      return {
        id: created.id,
        resumeId: created.resumeId,
        ...(created.applicationId ? { applicationId: created.applicationId } : {}),
        status: created.status as AnalysisTaskRecord['status'],
        attempts: created.attempts,
        idempotencyKey: created.idempotencyKey,
        availableAt: created.availableAt,
        createdAt: created.createdAt,
      }
    }

    return this.store.transaction((state) => {
      const candidate = candidateOrThrow(state, candidateId)
      const resume = resumeOrThrow(state, resumeId)
      if (resume.candidateId !== candidate.id) throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历与候选人不一致')
      requireCleanResume(resume.scanStatus)
      const active = state.analysisTasks.find((task) => task.resumeId === resumeId && (task.applicationId ?? null) === (resume.applicationId ?? null) && ['queued', 'processing'].includes(task.status))
      if (active) return active
      const timestamp = LocalRecruitingStore.timestamp()
      const task: AnalysisTaskRecord = {
        id: randomUUID(),
        resumeId,
        ...(resume.applicationId ? { applicationId: resume.applicationId } : {}),
        status: 'queued',
        attempts: 0,
        idempotencyKey: `resume-reanalysis:${resumeId}:${randomUUID()}`,
        availableAt: timestamp,
        createdAt: timestamp,
      }
      state.analysisTasks.push(task)
      addEvent(state, { subjectType: 'candidate', subjectId: candidateId, action: 'resume_reanalysis_requested', actorId })
      return task
    })
  }

  /** Reuse the immutable resume file, but bind the new task/result to the target application. */
  async analyzeResumeForApplication(candidateId: string, resumeId: string, applicationId: string, actorId = 'user-demo'): Promise<AnalysisTaskRecord> {
    const validate = (resume: { candidateId: string; scanStatus: string }, application: { candidateId: string; status: string }) => {
      if (resume.candidateId !== candidateId || application.candidateId !== candidateId) {
        throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历、候选人与申请不一致', 400)
      }
      requireCleanResume(resume.scanStatus)
      if (!['pending_analysis', 'analysis_queued', 'human_review'].includes(application.status)) {
        throw new RecruitingWorkflowError('APPLICATION_ANALYSIS_INVALID', '当前申请已进入后续流程，不能重新进行简历分析', 409)
      }
    }
    if (this.repository) {
      const resume = await this.repository.getResume(resumeId)
      const application = await this.repository.getApplication(applicationId)
      validate(resume, application)
      const tasks = await this.repository.listAnalysisTasks()
      const active = tasks.find((task) => task.applicationId === applicationId && ['queued', 'processing'].includes(task.status))
      if (active) {
        if (active.resumeId !== resumeId) throw new RecruitingWorkflowError('ANALYSIS_TASK_BUSY', '此申请正在分析另一份简历，请等待完成', 409)
        return mapRepositoryAnalysisTask(active)
      }
      await this.repository.assertJobAnalysisContextScope(application.jobId)
      const created = await this.repository.createAnalysisTask({ resumeId, applicationId, idempotencyKey: `resume-application:${resumeId}:${applicationId}:${randomUUID()}` })
      await this.repository.appendWorkflowEvent({ subjectType: 'application', subjectId: applicationId, action: 'resume_analysis_requested', actorId, metadata: { resumeId, reused: true } })
      return { ...created, applicationId, status: created.status as AnalysisTaskRecord['status'] }
    }
    return this.store.transaction((state) => {
      const candidate = candidateOrThrow(state, candidateId)
      const resume = resumeOrThrow(state, resumeId)
      const application = applicationOrThrow(state, applicationId)
      validate(resume, application)
      const active = state.analysisTasks.find((task) => task.applicationId === applicationId && ['queued', 'processing'].includes(task.status))
      if (active) {
        if (active.resumeId !== resumeId) throw new RecruitingWorkflowError('ANALYSIS_TASK_BUSY', '此申请正在分析另一份简历，请等待完成', 409)
        return active
      }
      const timestamp = LocalRecruitingStore.timestamp()
      const task: AnalysisTaskRecord = { id: randomUUID(), resumeId, applicationId, status: 'queued', attempts: 0, idempotencyKey: `resume-application:${resumeId}:${applicationId}:${randomUUID()}`, availableAt: timestamp, createdAt: timestamp }
      state.analysisTasks.push(task)
      addEvent(state, { subjectType: 'application', subjectId: application.id, action: 'resume_analysis_requested', actorId, metadata: { resumeId, candidateId: candidate.id, reused: true } })
      return task
    })
  }

  private validateResumeContent(input: CreateResumeInput) {
    const candidateId = required(input.candidateId, '候选人')
    const rawContent = required(input.content, '简历内容')
    const filename = required(input.originalFilename, '文件名')
    const mimeType = clean(input.mimeType) || 'application/octet-stream'
    const encoding = input.encoding === 'base64' ? 'base64' : 'utf8'
    const payload = encoding === 'base64' ? Buffer.from(rawContent, 'base64') : Buffer.from(rawContent, 'utf8')
    if (payload.length > 10 * 1024 * 1024) throw new RecruitingWorkflowError('RESUME_TOO_LARGE', '简历文件不能超过 10 MB', 413)
    let validatedUpload: ReturnType<typeof validateResumeUpload>
    try {
      validatedUpload = validateResumeUpload({ filename, mimeType, content: payload })
    } catch (error) {
      throw new RecruitingWorkflowError('VALIDATION_ERROR', error instanceof Error ? error.message : '简历文件不安全', 400)
    }
    return { candidateId, filename, mimeType, payload, validatedUpload }
  }

  async prepareResumeUpload(input: CreateResumeInput): Promise<PreparedResumeUpload> {
    if (!this.repository) throw new Error('分阶段上传仅支持数据库仓储')
    const { candidateId, filename, mimeType, payload, validatedUpload } = this.validateResumeContent(input)
    await this.repository.getCandidate(candidateId)
    if (input.applicationId) {
      const application = await this.repository.getApplication(input.applicationId)
      if (application.candidateId !== candidateId) throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历与申请的候选人不一致')
    }
    const id = randomUUID()
    const storageKey = id + '.' + validatedUpload.extension
    const locationId = this.objectStorage.locationId ?? null
    const attempt = await this.repository.registerResumeWrite(candidateId, storageKey, locationId, validatedUpload.contentHash)
    const plan: PreparedResumeUpload = {
      input: { id, candidateId, ...(input.applicationId ? { applicationId: input.applicationId } : {}), storageKey,
        originalFilename: filename, mimeType, sizeBytes: payload.length, contentHash: validatedUpload.contentHash, scanStatus: initialResumeScanStatus() },
      attempt, locationId, acknowledged: false,
      write: async () => { await this.putResumeObject(storageKey, payload, mimeType); plan.acknowledged = true },
    }
    return plan
  }

  async completeResumeUpload(plan: PreparedResumeUpload, checkpoint?: ResumeUploadCheckpoint): Promise<{ resume: ResumeRecord; task: AnalysisTaskRecord }> {
    if (!this.repository) throw new Error('分阶段上传仅支持数据库仓储')
    if (!plan.acknowledged) throw new Error('对象写入尚未确认，不能绑定简历')
    const { resume: saved, task: queued } = await this.repository.createResumeWithAnalysisTask(plan.input, plan, checkpoint)
    return { resume: { id: saved.id, candidateId: saved.candidateId, ...(saved.applicationId ? { applicationId: saved.applicationId } : {}), storageKey: saved.storageKey, originalFilename: saved.originalFilename, mimeType: saved.mimeType, sizeBytes: saved.sizeBytes, contentHash: saved.contentHash ?? plan.input.contentHash, scanStatus: saved.scanStatus as ResumeRecord['scanStatus'], createdAt: saved.createdAt }, task: { id: queued.id, resumeId: queued.resumeId, ...(queued.applicationId ? { applicationId: queued.applicationId } : {}), status: queued.status as AnalysisTaskRecord['status'], attempts: queued.attempts, idempotencyKey: queued.idempotencyKey, availableAt: queued.availableAt, createdAt: queued.createdAt } }
  }

  async failResumeUpload(plan: PreparedResumeUpload): Promise<void> {
    if (!this.repository) throw new Error('分阶段上传仅支持数据库仓储')
    // A lost COMMIT response must be reconciled against persisted references.
    await this.repository.recordResumeWriteFailure(plan.attempt, plan.acknowledged)
  }

  async createResume(input: CreateResumeInput, actorId = 'user-demo'): Promise<{ resume: ResumeRecord; task: AnalysisTaskRecord }> {
    if (this.repository) {
      const plan = await this.prepareResumeUpload(input)
      try { await plan.write(); return await this.completeResumeUpload(plan) }
      catch (error) {
        await this.failResumeUpload(plan).catch(() => console.warn('简历上传失败后的文件已保留，待数据库恢复后核对清理'))
        throw error
      }
    }
    const { candidateId, filename, mimeType, payload, validatedUpload } = this.validateResumeContent(input)
    const localId = randomUUID()
    const localStorageKey = `${localId}.${validatedUpload.extension}`
    await this.putResumeObject(localStorageKey, payload, mimeType)
    try { return await this.store.transaction(async (state) => {
      const candidate = candidateOrThrow(state, candidateId)
      let application: ApplicationRecord | undefined
      if (input.applicationId) {
        application = applicationOrThrow(state, input.applicationId)
        if (application.candidateId !== candidate.id) throw new RecruitingWorkflowError('RESUME_CANDIDATE_MISMATCH', '简历与申请的候选人不一致')
      }
      const id = localId
      const hash = validatedUpload.contentHash
      const storageKey = localStorageKey
      const timestamp = LocalRecruitingStore.timestamp()
      const resume: ResumeRecord = { id, candidateId: candidate.id, ...(application ? { applicationId: application.id } : {}), storageKey, originalFilename: filename, mimeType, sizeBytes: payload.length, contentHash: hash, scanStatus: initialResumeScanStatus(), createdAt: timestamp }
      const task: AnalysisTaskRecord = { id: randomUUID(), resumeId: resume.id, ...(application ? { applicationId: application.id } : {}), status: 'queued', attempts: 0, idempotencyKey: `resume-analysis:${resume.id}:${hash}`, availableAt: timestamp, createdAt: timestamp }
      state.resumes.push(resume)
      state.analysisTasks.push(task)
      try {
        const text = await this.extractText(payload, filename, mimeType)
        const report = buildRuleBasedReport({ resume: { documentId: resume.id, fileName: filename, mimeType, text, source: 'upload' }, job: buildJobRequirements(undefined) as Parameters<typeof buildRuleBasedReport>[0]['job'], subject: { resumeId: resume.id } })
        const patch = extractedCandidatePatch(candidate, report.extraction as ExtractedCandidateProfile, text)
        if (patch.fullName) candidate.fullName = patch.fullName
        if (patch.email) candidate.email = patch.email
        if (patch.phone) candidate.phone = patch.phone
        if (Object.keys(patch).length) candidate.updatedAt = timestamp
      } catch {
        // Background analysis remains the source of truth; this local pass only prevents placeholder identity.
      }
      return { resume, task }
    }) } catch (error) { await this.objectStorage.delete(localStorageKey).catch(() => undefined); throw error }
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

  async reviewAnalysisResult(id: string, input: ReviewAnalysisResultInput, actorId = 'user-demo'): Promise<AnalysisResultRecord> {
    if (this.repository) {
      if (!['accepted', 'needs_correction'].includes(input.status)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '复核状态必须是 accepted 或 needs_correction', 400)
      const current = await this.repository.getAnalysisResult(id)
      applyAnalysisEdits(current.result, input, actorId)
      const saved = await this.repository.reviewAnalysisResult(id, input.status, current.result)
      const resume = await this.repository.getResume(current.resumeId)
      await this.repository.appendWorkflowEvent({
        subjectType: 'candidate',
        subjectId: resume.candidateId,
        action: 'analysis_result_edited',
        actorId,
        ...(input.comment ? { reason: clean(input.comment) } : {}),
      })
      return mapRepositoryAnalysisResult(saved)
    }
    return this.store.transaction((state) => {
      const result = state.analysisResults.find((item) => item.id === id)
      if (!result) throw new RecruitingNotFoundError(`未找到分析结果：${id}`)
      if (!['accepted', 'needs_correction'].includes(input.status)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '复核状态必须是 accepted 或 needs_correction', 400)
      applyAnalysisEdits(result.result, input, actorId)
      result.humanReviewStatus = input.status
      const resume = state.resumes.find((item) => item.id === result.resumeId)
      if (resume) {
        addEvent(state, {
          subjectType: 'candidate',
          subjectId: resume.candidateId,
          action: 'analysis_result_edited',
          actorId,
          ...(input.comment ? { reason: clean(input.comment) } : {}),
        })
      }
      return result
    })
  }

  async updateResumeReview(id: string, input: ResumeReviewInput, actorId = 'user-demo'): Promise<AnalysisResultRecord> {
    if (this.repository) return mapRepositoryAnalysisResult(await this.repository.updateResumeReview(id, input, actorId))
    return this.store.transaction((state) => {
      const result = state.analysisResults.find((item) => item.id === id)
      if (!result) throw new RecruitingNotFoundError(`未找到分析结果：${id}`)
      if (!result.applicationId) throw new RecruitingWorkflowError('APPLICATION_REQUIRED', '请先关联应聘岗位，再处理 AI 筛选结果', 409)
      const application = applicationOrThrow(state, result.applicationId)
      const latest = state.analysisResults.filter((item) => item.applicationId === application.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
      if (latest?.id !== id) throw new RecruitingWorkflowError('ANALYSIS_RESULT_STALE', '分析结果已更新，请刷新后重新处理', 409)
      if (state.analysisTasks.some((task) => task.applicationId === application.id && ['queued', 'processing'].includes(task.status))) throw new RecruitingWorkflowError('ANALYSIS_TASK_BUSY', '简历正在重新解析，请完成后再处理', 409)
      const updated = applyResumeReview(id, result.result, application.status, input, actorId)
      const previousStatus = application.status
      result.result = updated.report
      result.humanReviewStatus = 'accepted'
      application.status = updated.nextStatus as ApplicationRecord['status']
      application.score = updated.summary.finalScore ?? updated.summary.aiScore!
      application.updatedAt = LocalRecruitingStore.timestamp()
      const reason = (updated.report.humanDecision as { reason?: string } | undefined)?.reason
      if (application.status === 'rejected' && reason) application.rejectionReason = reason
      addEvent(state, { subjectType: 'candidate', subjectId: application.candidateId, action: 'resume_review_updated', actorId,
        ...(input.comment ? { reason: input.comment.trim() } : {}),
        metadata: { resultId: id, applicationId: application.id, aiScore: updated.summary.aiScore, humanScore: updated.summary.humanScore, finalScore: updated.summary.finalScore, decision: updated.summary.decision, talentPool: updated.summary.talentPool },
      })
      if (previousStatus !== application.status) addEvent(state, { subjectType: 'application', subjectId: application.id, action: 'status_changed', actorId, fromStatus: previousStatus, toStatus: application.status, reason: reason ?? '保存 AI 简历筛选结果' })
      return result
    })
  }

  async processAnalysisTask(taskId: string): Promise<AnalysisTaskRecord> {
    if (this.repository) {
      let task: RepositoryAnalysisTask
      try { task = await this.repository.getAnalysisTask(taskId) } catch (error) { if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'REPOSITORY_NOT_FOUND') throw new RecruitingNotFoundError(`未找到分析任务：${taskId}`); throw error }
      if (task.status === 'completed') return mapRepositoryAnalysisTask(task)
      if (task.status === 'processing') throw new RecruitingWorkflowError('ANALYSIS_TASK_BUSY', '分析任务正在处理中', 409)
      const resume = await this.repository.getResume(task.resumeId)
      requireCleanResume(resume.scanStatus)
      const scoringApplication = task.applicationId ? await this.repository.getApplication(task.applicationId) : undefined
      if (scoringApplication && await this.repository.hasActiveResumeScoringSkill(scoringApplication.jobId)) {
        throw new RecruitingWorkflowError('SCORING_SKILL_WORKER_REQUIRED', '该岗位已配置 AI 评分 Skill，任务将由 AI Worker 执行，不能使用内联默认规则评分', 409)
      }
      // Job scoring is owned by the AI Worker, not the synchronous keyword parser.
      if (scoringApplication) {
        const job = await this.getJobForAnalysis(scoringApplication.jobId)
        if (buildJobRequirements(job, job.id).requirements.length) return mapRepositoryAnalysisTask(task)
      }
      const startedAt = new Date().toISOString()
      const processing = await this.repository.updateAnalysisTask(taskId, { status: 'processing', attempts: task.attempts + 1, startedAt, lastError: null })
      try {
        const application = processing.applicationId ? await this.repository.getApplication(processing.applicationId) : undefined
        const job = application ? await this.getJobForAnalysis(application.jobId) : undefined
        const resumeBytes = await this.getResumeObject(resume.storageKey)
        const content = await this.extractText(resumeBytes, resume.originalFilename, resume.mimeType)
        const report = buildRuleBasedReport({ resume: { documentId: resume.id, fileName: resume.originalFilename, mimeType: resume.mimeType, text: content, source: 'upload' }, job: buildJobRequirements(job, job?.id) as Parameters<typeof buildRuleBasedReport>[0]['job'], subject: { resumeId: resume.id, ...(processing.applicationId ? { applicationId: processing.applicationId } : {}), ...(job ? { jobId: job.id } : {}) } })
        const currentCandidate = await this.repository.getCandidate(resume.candidateId)
        const candidatePatch = extractedCandidatePatch({
          id: currentCandidate.id,
          code: currentCandidate.businessId,
          fullName: currentCandidate.name,
          nameManuallyEdited: currentCandidate.nameManuallyEdited === true,
          ...(currentCandidate.email ? { email: currentCandidate.email } : {}),
          ...(currentCandidate.phone ? { phone: currentCandidate.phone } : {}),
          status: 'active',
          createdAt: currentCandidate.createdAt,
          updatedAt: currentCandidate.updatedAt,
        }, report.extraction as ExtractedCandidateProfile, content)
        if (Object.keys(candidatePatch).length) {
          await this.repository.updateCandidate(currentCandidate.id, {
            nameManuallyEdited: false,
            ...(candidatePatch.fullName ? { name: candidatePatch.fullName } : {}),
            ...(candidatePatch.email ? { email: candidatePatch.email } : {}),
            ...(candidatePatch.phone ? { phone: candidatePatch.phone } : {}),
          })
          await this.repository.appendWorkflowEvent({ subjectType: 'candidate', subjectId: currentCandidate.id, action: 'profile_parsed' })
        }
        await this.repository.createAnalysisResult({ analysisTaskId: processing.id, resumeId: resume.id, ...(processing.applicationId ? { applicationId: processing.applicationId } : {}), result: report as unknown as Record<string, unknown>, analyzerVersion: 'resume-intelligence-rule-based-0.3.0', inputHash: resume.contentHash })
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
      requireCleanResume(resume.scanStatus)
      const application = task.applicationId ? applicationOrThrow(state, task.applicationId) : undefined
      const job = application ? confirmedJobForAnalysis(jobOrThrow(state, application.jobId), state) : undefined
      task.status = 'processing'; task.attempts += 1; task.startedAt = LocalRecruitingStore.timestamp(); delete task.lastError
      try {
        const resumeBytes = await this.getResumeObject(resume.storageKey)
        const content = await this.extractText(resumeBytes, resume.originalFilename, resume.mimeType)
        const report = buildRuleBasedReport({ resume: { documentId: resume.id, fileName: resume.originalFilename, mimeType: resume.mimeType, text: content, source: 'upload' }, job: buildJobRequirements(job, job?.id) as Parameters<typeof buildRuleBasedReport>[0]['job'], subject: { resumeId: resume.id, ...(task.applicationId ? { applicationId: task.applicationId } : {}), ...(job ? { jobId: job.id } : {}) } })
        const candidate = candidateOrThrow(state, resume.candidateId)
        const candidatePatch = extractedCandidatePatch(candidate, report.extraction as ExtractedCandidateProfile, content)
        if (Object.keys(candidatePatch).length) {
          if (candidatePatch.fullName) candidate.fullName = candidatePatch.fullName
          if (candidatePatch.email) candidate.email = candidatePatch.email
          if (candidatePatch.phone) candidate.phone = candidatePatch.phone
          candidate.updatedAt = LocalRecruitingStore.timestamp()
          addEvent(state, { subjectType: 'candidate', subjectId: candidate.id, action: 'profile_parsed', actorId: 'resume-analysis' })
        }
        const result: AnalysisResultRecord = { id: randomUUID(), analysisTaskId: task.id, resumeId: resume.id, ...(task.applicationId ? { applicationId: task.applicationId } : {}), result: report as unknown as Record<string, unknown>, analyzerVersion: 'resume-intelligence-rule-based-0.3.0', inputHash: resume.contentHash, humanReviewStatus: 'pending', createdAt: LocalRecruitingStore.timestamp() }
        state.analysisResults = state.analysisResults.filter((item) => item.analysisTaskId !== task.id)
        state.analysisResults.push(result)
        if (application) {
          const score = (result.result.assessment as { score?: number | null } | undefined)?.score
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
  async listOfferTemplates(): Promise<RepositoryOfferTemplate[]> {
    if (!this.repository) return []
    return (await this.repository.listOfferTemplates()).map((item) => this.mapRepositoryOfferTemplate(item))
  }
  async createOfferTemplate(input: OfferTemplateInput, actorId = 'user-demo'): Promise<RepositoryOfferTemplate> {
    if (!this.repository) throw new RecruitingWorkflowError('OFFER_TEMPLATE_STORAGE_UNAVAILABLE', 'Offer 模板需要 PostgreSQL 数据库支持', 503)
    const name = required(input.name, '模板名称')
    const filename = required(input.filename, '模板文件名')
    const content = typeof input.content === 'string' ? input.content : ''
    if (name.length > 200) throw new RecruitingWorkflowError('VALIDATION_ERROR', '模板名称不能超过 200 个字符', 400)
    if (!/\.(?:md|html?|txt)$/iu.test(filename)) throw new RecruitingWorkflowError('VALIDATION_ERROR', 'Offer 模板文件必须为 .md、.html、.htm 或 .txt 格式', 400)
    if (content.length > 50_000) throw new RecruitingWorkflowError('VALIDATION_ERROR', 'Offer 模板内容不能超过 50000 个字符', 400)
    if (input.isDefault === true && input.isActive === false) throw new RecruitingWorkflowError('VALIDATION_ERROR', '默认 Offer 模板必须保持启用', 400)
    return this.mapRepositoryOfferTemplate(await this.repository.createOfferTemplate({ name, filename, content, isActive: input.isActive !== false, isDefault: input.isDefault === true, createdById: actorId }))
  }
  async updateOfferTemplate(id: string, input: OfferTemplatePatch): Promise<RepositoryOfferTemplate> {
    if (!this.repository) throw new RecruitingWorkflowError('OFFER_TEMPLATE_STORAGE_UNAVAILABLE', 'Offer 模板需要 PostgreSQL 数据库支持', 503)
    const patch: OfferTemplatePatch = {}
    if (input.name !== undefined) {
      const name = required(input.name, '模板名称')
      if (name.length > 200) throw new RecruitingWorkflowError('VALIDATION_ERROR', '模板名称不能超过 200 个字符', 400)
      patch.name = name
    }
    if (input.filename !== undefined) {
      const filename = required(input.filename, '模板文件名')
      if (!/\.(?:md|html?|txt)$/iu.test(filename)) throw new RecruitingWorkflowError('VALIDATION_ERROR', 'Offer 模板文件必须为 .md、.html、.htm 或 .txt 格式', 400)
      patch.filename = filename
    }
    if (input.content !== undefined) {
      if (typeof input.content !== 'string') throw new RecruitingWorkflowError('VALIDATION_ERROR', '模板内容必须为文本', 400)
      if (input.content.length > 50_000) throw new RecruitingWorkflowError('VALIDATION_ERROR', 'Offer 模板内容不能超过 50000 个字符', 400)
      patch.content = input.content
    }
    if (input.isActive !== undefined) patch.isActive = input.isActive === true
    if (input.isDefault !== undefined) patch.isDefault = input.isDefault === true
    if (patch.isActive === false && patch.isDefault === true) throw new RecruitingWorkflowError('VALIDATION_ERROR', '默认 Offer 模板必须保持启用', 400)
    return this.mapRepositoryOfferTemplate(await this.repository.updateOfferTemplate(required(id, 'Offer 模板'), patch))
  }
  async deleteOfferTemplate(id: string): Promise<void> {
    if (!this.repository) throw new RecruitingWorkflowError('OFFER_TEMPLATE_STORAGE_UNAVAILABLE', 'Offer 模板需要 PostgreSQL 数据库支持', 503)
    await this.repository.deleteOfferTemplate(required(id, 'Offer 模板'))
  }
  async getOffer(id:string) {
    const state = await this.stateView()
    const offer = state.offers.find(item => item.id === id || item.code === id)
    if (!offer) throw new RecruitingNotFoundError('未找到 Offer：' + id)
    const versions = state.offerVersions.filter(item => item.offerId === offer.id).sort((a, b) => b.version - a.version)
    const onboarding = state.onboarding.find(item => item.offerId === offer.id)
    const events = this.repository
      ? await this.repository.listWorkflowEvents({ subjectType: 'offer', subjectId: offer.id, allForSubject: true })
      : state.workflowEvents.filter(item => item.subjectType === 'offer' && item.subjectId === offer.id)
    const lastEmail = lastOfferEmail(events)
    return { ...offer, versions, confirmation: offerConfirmation(offer, versions, events), ...(lastEmail ? { lastEmail } : {}), ...(onboarding ? { onboarding } : {}) }
  }
  async getOfferEmailContext(id: string): Promise<{ offerCode: string; candidateName: string; candidateEmail: string; positionTitle: string; department: string; startDate?: string; reportingLocation?: string; invoiceTitle?: string; taxNumber?: string; templateFields?: OfferTemplateFields; employmentType: string; baseSalary: number; probationSalary?: number; bonus?: number; benefits: string[]; materials: string[] }> {
    const state = await this.stateView()
    const offer = state.offers.find((item) => item.id === id) ?? state.offers.find((item) => item.code === id)
    if (!offer) throw new RecruitingNotFoundError(`未找到 Offer：${id}`)
    const application = state.applications.find((item) => item.id === offer.applicationId)
    if (!application) throw new RecruitingNotFoundError(`未找到 Offer 对应的申请：${offer.applicationId}`)
    const candidate = state.candidates.find((item) => item.id === application.candidateId)
    if (!candidate) throw new RecruitingNotFoundError(`未找到 Offer 对应的候选人：${application.candidateId}`)
    const job = state.jobs.find((item) => item.id === application.jobId)
    const version = state.offerVersions.find((item) => item.id === offer.currentVersionId) ?? state.offerVersions.filter((item) => item.offerId === offer.id).sort((a, b) => b.version - a.version)[0]
    if (!version) throw new RecruitingWorkflowError('OFFER_VERSION_REQUIRED', 'Offer 缺少当前版本', 409)
    return {
      offerCode: offer.code,
      candidateName: candidate.fullName,
      candidateEmail: candidate.email ?? '',
      positionTitle: version.positionTitle,
      department: job?.department ?? version.departmentId,
      ...(version.startDate ? { startDate: version.startDate } : {}),
      ...(version.reportingLocation ? { reportingLocation: version.reportingLocation } : {}),
      ...(version.invoiceTitle ? { invoiceTitle: version.invoiceTitle } : {}),
      ...(version.taxNumber ? { taxNumber: version.taxNumber } : {}),
      employmentType: version.employmentType,
      templateFields: version.templateFields ?? {},
      baseSalary: version.compensation.baseSalary.amount,
      ...(version.compensation.probationSalary ? { probationSalary: version.compensation.probationSalary.amount } : {}),
      ...(version.compensation.bonus ? { bonus: version.compensation.bonus.amount } : {}),
      benefits: version.benefits,
      materials: version.materials,
    }
  }
  async listOnboarding(departmentId?: string): Promise<OnboardingRecord[]> { const state = await this.stateView(departmentId); return state.onboarding }
  async getOnboarding(id: string): Promise<OnboardingRecord> {
    if (this.repository) return this.mapRepositoryOnboarding(await this.repository.getOnboarding(id))
    const state = await this.store.read()
    const item = state.onboarding.find((record) => record.id === id)
    if (!item) throw new RecruitingNotFoundError(`未找到入职归档：${id}`)
    return item
  }
  async listOnboardingWorkbench(departmentId?: string): Promise<OnboardingWorkbenchItem[]> {
    const state = await this.stateView(departmentId)
    const applicationMap = new Map(state.applications.map((item) => [item.id, item]))
    const candidateMap = new Map(state.candidates.map((item) => [item.id, item]))
    const jobMap = new Map(state.jobs.map((item) => [item.id, item]))
    const offerMap = new Map(state.offers.map((item) => [item.id, item]))
    return state.onboarding.map((onboarding) => {
      const application = applicationMap.get(onboarding.applicationId)
      const candidate = application ? candidateMap.get(application.candidateId) : undefined
      const job = application ? jobMap.get(application.jobId) : undefined
      const offer = offerMap.get(onboarding.offerId)
      return buildOnboardingWorkbenchItem({
        onboarding,
        tasks: state.onboardingTasks.filter((item) => item.onboardingId === onboarding.id),
        materials: state.onboardingMaterials.filter((item) => item.onboardingId === onboarding.id),
        reminders: state.onboardingReminders.filter((item) => item.onboardingId === onboarding.id),
        integrations: state.onboardingIntegrations.filter((item) => item.onboardingId === onboarding.id),
        candidateName: candidate?.fullName ?? '未知候选人',
        jobTitle: job?.title ?? '未知岗位',
        offerCode: offer?.code ?? onboarding.offerId,
        department: job?.department ?? job?.departmentId ?? '',
      })
    }).sort((left, right) => (left.onboarding.plannedStartDate ?? '9999-12-31').localeCompare(right.onboarding.plannedStartDate ?? '9999-12-31') || right.onboarding.updatedAt.localeCompare(left.onboarding.updatedAt))
  }
  async listOnboardingReport(departmentId?: string): Promise<OnboardingReport> {
    return buildOnboardingReport(await this.listOnboardingWorkbench(departmentId))
  }
  async updateOnboarding(id: string, input: UpdateOnboardingInput, actorId = 'user-demo'): Promise<OnboardingRecord> {
    validateOnboardingScheduleInput(input)
    if (this.repository) {
      const current = await this.repository.getOnboarding(id)
      if (!isOnboardingEditable(current.status as OnboardingRecord['status'])) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录已进入终态，不能编辑', 409)
      const patched = await this.repository.updateOnboarding(current.id, Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value])))
      await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: current.id, action: 'update', actorId })
      return this.mapRepositoryOnboarding(patched)
    }
    return this.store.transaction((state) => {
      const item = state.onboarding.find((record) => record.id === id)
      if (!item) throw new RecruitingNotFoundError(`未找到入职归档：${id}`)
      if (!isOnboardingEditable(item.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录已进入终态，不能编辑', 409)
      const mutableItem = item as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(input)) {
        if (value === null) delete mutableItem[key]
        else mutableItem[key] = typeof value === 'string' ? clean(value) : value
      }
      item.updatedAt = LocalRecruitingStore.timestamp()
      addEvent(state, { subjectType: 'onboarding', subjectId: item.id, action: 'update', actorId })
      return item
    })
  }
  async listOnboardingTasks(onboardingId: string): Promise<OnboardingTaskRecord[]> {
    const onboarding = await this.getOnboarding(onboardingId)
    if (this.repository) return (await this.repository.listOnboardingTasks(onboardingId)).map((item) => this.mapRepositoryOnboardingTask(item))
    return this.store.transaction((state) => {
      const existing = state.onboardingTasks.filter((item) => item.onboardingId === onboardingId)
      const knownDefaults = new Set(existing.map((item) => item.templateKey ?? `${item.category}\u0000${item.title}`))
      const timestamp = LocalRecruitingStore.timestamp()
      for (const task of defaultOnboardingTasks()) {
        if (knownDefaults.has(task.templateKey ?? `${task.category}\u0000${task.title}`)) continue
        state.onboardingTasks.push({ id: randomUUID(), onboardingId, status: 'pending', createdAt: timestamp, updatedAt: timestamp, ...task })
      }
      return state.onboardingTasks.filter((item) => item.onboardingId === onboardingId)
    })
  }
  async createOnboardingTask(onboardingId: string, input: CreateOnboardingTaskInput, actorId = 'user-demo'): Promise<OnboardingTaskRecord> {
    const title = required(input.title, '任务标题')
    validateOnboardingTaskInput(input)
    const onboarding = await this.getOnboarding(onboardingId)
    if (!isOnboardingEditable(onboarding.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录已进入终态，不能新增任务', 409)
    const base = {
      onboardingId,
      title,
      category: input.category,
      isRequired: input.isRequired !== false,
      ...(input.ownerRole !== undefined ? { ownerRole: input.ownerRole } : {}),
      ...(input.templateKey !== undefined ? { templateKey: optionalClean(input.templateKey) ?? null } : {}),
      ...(input.ownerName !== undefined ? { ownerName: optionalClean(input.ownerName) ?? null } : {}),
      ...(input.dueDate !== undefined ? { dueDate: optionalClean(input.dueDate) ?? null } : {}),
      ...(input.notes !== undefined ? { notes: optionalClean(input.notes) ?? null } : {}),
    }
    if (this.repository) {
      const item = await this.repository.createOnboardingTask(base)
      await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: onboardingId, action: 'task_create', actorId })
      return this.mapRepositoryOnboardingTask(item)
    }
    return this.store.transaction((state) => {
      const now = LocalRecruitingStore.timestamp()
      const item: OnboardingTaskRecord = {
        id: randomUUID(), onboardingId, title, category: input.category, status: 'pending', isRequired: input.isRequired !== false,
        ...(input.ownerRole != null ? { ownerRole: input.ownerRole } : {}),
        ...(optionalClean(input.templateKey) ? { templateKey: optionalClean(input.templateKey)! } : {}),
        ...(optionalClean(input.ownerName) ? { ownerName: optionalClean(input.ownerName)! } : {}),
        ...(optionalClean(input.dueDate) ? { dueDate: optionalClean(input.dueDate)! } : {}),
        ...(optionalClean(input.notes) ? { notes: optionalClean(input.notes)! } : {}),
        createdAt: now, updatedAt: now,
      }
      state.onboardingTasks.push(item)
      addEvent(state, { subjectType: 'onboarding', subjectId: onboardingId, action: 'task_create', actorId })
      return item
    })
  }
  async updateOnboardingTask(onboardingId: string, taskId: string, input: UpdateOnboardingTaskInput, actorId = 'user-demo'): Promise<OnboardingTaskRecord> {
    validateOnboardingTaskInput(input)
    const onboarding = await this.getOnboarding(onboardingId)
    if (!isOnboardingEditable(onboarding.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录已进入终态，不能修改任务', 409)
    const completedAt = input.status === 'completed' ? LocalRecruitingStore.timestamp() : input.status !== undefined ? null : undefined
    const blockedReason = input.status === 'blocked' ? required(input.blockedReason, '阻塞原因') : input.status !== undefined ? null : input.blockedReason !== undefined ? optionalClean(input.blockedReason) ?? null : undefined
    const patch = {
      ...(input.title !== undefined ? { title: required(input.title, '任务标题') } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
      ...(input.ownerRole !== undefined ? { ownerRole: input.ownerRole } : {}),
      ...(input.templateKey !== undefined ? { templateKey: optionalClean(input.templateKey) ?? null } : {}),
      ...(input.ownerName !== undefined ? { ownerName: optionalClean(input.ownerName) ?? null } : {}),
      ...(input.dueDate !== undefined ? { dueDate: optionalClean(input.dueDate) ?? null } : {}),
      ...(input.notes !== undefined ? { notes: optionalClean(input.notes) ?? null } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    }
    if (this.repository) {
      const item = await this.repository.updateOnboardingTask(onboardingId, taskId, patch)
      await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: onboardingId, action: 'task_update', actorId })
      return this.mapRepositoryOnboardingTask(item)
    }
    return this.store.transaction((state) => {
      const item = state.onboardingTasks.find((task) => task.id === taskId && task.onboardingId === onboardingId)
      if (!item) throw new RecruitingNotFoundError(`未找到入职任务：${taskId}`)
      const mutable = item as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete mutable[key]
        else mutable[key] = typeof value === 'string' ? clean(value) : value
      }
      item.updatedAt = LocalRecruitingStore.timestamp()
      addEvent(state, { subjectType: 'onboarding', subjectId: onboardingId, action: 'task_update', actorId })
      return item
    })
  }
  async listOnboardingMaterials(onboardingId: string): Promise<OnboardingMaterialRecord[]> {
    await this.getOnboarding(onboardingId)
    if (this.repository) return (await this.repository.listOnboardingMaterials(onboardingId)).map((item) => this.mapRepositoryOnboardingMaterial(item))
    const state = await this.store.read()
    return state.onboardingMaterials.filter((item) => item.onboardingId === onboardingId)
  }
  async createOnboardingMaterial(onboardingId: string, input: CreateOnboardingMaterialInput, actorId = 'user-demo'): Promise<OnboardingMaterialRecord> {
    const onboarding = await this.getOnboarding(onboardingId)
    if (!isOnboardingEditable(onboarding.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录已进入终态，不能新增材料', 409)
    const code = clean(input.code).toLowerCase()
    if (!/^[a-z0-9_]+$/.test(code)) throw new RecruitingWorkflowError('ONBOARDING_MATERIAL_CODE_INVALID', '材料编码只能包含小写字母、数字和下划线', 400)
    const label = required(input.label, '材料名称')
    const existing = await this.listOnboardingMaterials(onboardingId)
    if (existing.some((item) => item.code === code)) throw new RecruitingWorkflowError('ONBOARDING_MATERIAL_EXISTS', '该材料已存在', 409)
    if (this.repository) {
      const item = await this.repository.createOnboardingMaterial({ onboardingId, code, label, isRequired: input.isRequired !== false, ...(input.notes !== undefined ? { notes: optionalClean(input.notes) ?? null } : {}) }, actorId)
      return this.mapRepositoryOnboardingMaterial(item)
    }
    return this.store.transaction((state) => {
      const current = state.onboarding.find((item) => item.id === onboardingId)
      if (!current) throw new RecruitingNotFoundError('未找到入职记录')
      if (!isOnboardingEditable(current.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录不允许修改材料', 409)
      if (state.onboardingMaterials.some((item) => item.onboardingId === onboardingId && item.code === code)) throw new RecruitingWorkflowError('ONBOARDING_MATERIAL_EXISTS', '该材料已存在', 409)
      const now = LocalRecruitingStore.timestamp()
      const item: OnboardingMaterialRecord = { id: randomUUID(), onboardingId, code, label, status: 'pending', isRequired: input.isRequired !== false, ...(optionalClean(input.notes) ? { notes: optionalClean(input.notes)! } : {}), createdAt: now, updatedAt: now }
      state.onboardingMaterials.push(item)
      addEvent(state, { subjectType: 'onboarding', subjectId: onboardingId, action: 'material_create', actorId })
      return item
    })
  }
  async updateOnboardingMaterial(onboardingId: string, materialId: string, input: UpdateOnboardingMaterialInput, actorId = 'user-demo'): Promise<OnboardingMaterialRecord> {
    if (input.status !== undefined && !['pending', 'collected', 'verified', 'waived'].includes(input.status)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '材料状态无效', 400)
    const onboarding = await this.getOnboarding(onboardingId)
    if (!isOnboardingEditable(onboarding.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录已进入终态，不能修改材料', 409)
    const now = LocalRecruitingStore.timestamp()
    const patch = {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
      ...(input.notes !== undefined ? { notes: optionalClean(input.notes) ?? null } : {}),
      ...(input.status === 'pending' ? { collectedAt: null, verifiedAt: null, verifiedByUserId: null, waivedAt: null } : {}),
      ...(input.status === 'collected' ? { collectedAt: now, verifiedAt: null, verifiedByUserId: null, waivedAt: null } : {}),
      ...(input.status === 'verified' ? { collectedAt: now, verifiedAt: now, verifiedByUserId: actorId, waivedAt: null } : {}),
      ...(input.status === 'waived' ? { waivedAt: now, verifiedAt: null, verifiedByUserId: null } : {}),
    }
    const action = input.status === 'collected' ? 'material_collect' : input.status === 'verified' ? 'material_verify' : input.status === 'waived' ? 'material_waive' : 'material_update'
    if (this.repository) {
      const item = await this.repository.updateOnboardingMaterial(onboardingId, materialId, patch, actorId, action)
      return this.mapRepositoryOnboardingMaterial(item)
    }
    return this.store.transaction((state) => {
      const current = state.onboarding.find((item) => item.id === onboardingId)
      if (!current) throw new RecruitingNotFoundError('未找到入职记录')
      if (!isOnboardingEditable(current.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录不允许修改材料', 409)
      const item = state.onboardingMaterials.find((material) => material.id === materialId && material.onboardingId === onboardingId)
      if (!item) throw new RecruitingNotFoundError(`未找到入职材料：${materialId}`)
      const mutable = item as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete mutable[key]
        else mutable[key] = value
      }
      item.updatedAt = now
      addEvent(state, { subjectType: 'onboarding', subjectId: onboardingId, action, actorId })
      return item
    })
  }
  async listOnboardingReminders(onboardingId: string): Promise<OnboardingReminderRecord[]> {
    await this.getOnboarding(onboardingId)
    if (this.repository) return (await this.repository.listOnboardingReminders(onboardingId)).map((item) => this.mapRepositoryOnboardingReminder(item))
    const state = await this.store.read()
    return state.onboardingReminders.filter((item) => item.onboardingId === onboardingId)
  }
  async refreshOnboardingReminders(onboardingId: string, actorId = 'user-demo'): Promise<OnboardingReminderRecord[]> {
    const onboarding = await this.getOnboarding(onboardingId)
    if (!isOnboardingEditable(onboarding.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录已进入终态，不能刷新提醒', 409)
    if (!onboarding.plannedStartDate || !isIsoDate(onboarding.plannedStartDate)) throw new RecruitingWorkflowError('ONBOARDING_SCHEDULE_DATE_REQUIRED', '请先设置计划入职日期', 400)
    const schedule = buildOnboardingReminderSchedule(onboarding.plannedStartDate)
    if (this.repository) {
      for (const reminder of schedule) await this.repository.createOnboardingReminder({ onboardingId, ...reminder, channel: 'in_app' })
      await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: onboardingId, action: 'reminders_refresh', actorId })
      return (await this.repository.listOnboardingReminders(onboardingId)).map((item) => this.mapRepositoryOnboardingReminder(item))
    }
    return this.store.transaction((state) => {
      const now = LocalRecruitingStore.timestamp()
      for (const reminder of schedule) {
        const existing = state.onboardingReminders.find((item) => item.onboardingId === onboardingId && item.milestone === reminder.milestone && item.audience === reminder.audience && item.channel === 'in_app')
        if (existing) {
          existing.scheduledAt = reminder.scheduledAt
          existing.updatedAt = now
        } else {
          state.onboardingReminders.push({ id: randomUUID(), onboardingId, ...reminder, channel: 'in_app', status: 'scheduled', createdAt: now, updatedAt: now })
        }
      }
      addEvent(state, { subjectType: 'onboarding', subjectId: onboardingId, action: 'reminders_refresh', actorId })
      return state.onboardingReminders.filter((item) => item.onboardingId === onboardingId)
    })
  }
  async listOnboardingIntegrations(onboardingId: string): Promise<OnboardingIntegrationRecord[]> {
    await this.getOnboarding(onboardingId)
    if (this.repository) return (await this.repository.listOnboardingIntegrations(onboardingId)).map((item) => this.mapRepositoryOnboardingIntegration(item))
    const state = await this.store.read()
    return state.onboardingIntegrations.filter((item) => item.onboardingId === onboardingId)
  }
  async updateOnboardingIntegration(onboardingId: string, integrationId: string, input: UpdateOnboardingIntegrationInput, actorId = 'user-demo'): Promise<OnboardingIntegrationRecord> {
    if (input.status !== undefined && !['not_configured', 'pending', 'syncing', 'ready', 'failed'].includes(input.status)) throw new RecruitingWorkflowError('VALIDATION_ERROR', '集成状态无效', 400)
    const onboarding = await this.getOnboarding(onboardingId)
    if (!isOnboardingEditable(onboarding.status)) throw new RecruitingWorkflowError('ONBOARDING_NOT_EDITABLE', '当前入职记录已进入终态，不能修改系统集成', 409)
    const now = LocalRecruitingStore.timestamp()
    const lastError = input.status === 'failed' ? required(input.lastError, '集成失败原因') : input.lastError !== undefined ? optionalClean(input.lastError) ?? null : undefined
    const patch = {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.externalReference !== undefined ? { externalReference: optionalClean(input.externalReference) ?? null } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(input.status && input.status !== 'not_configured' ? { lastAttemptAt: now } : {}),
      ...(input.status === 'ready' ? { lastSuccessAt: now, lastError: null } : {}),
    }
    if (this.repository) {
      const item = await this.repository.updateOnboardingIntegration(onboardingId, integrationId, patch)
      await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: onboardingId, action: 'integration_update', actorId, ...(input.status ? { metadata: { provider: item.provider, status: input.status } } : {}) })
      return this.mapRepositoryOnboardingIntegration(item)
    }
    return this.store.transaction((state) => {
      const item = state.onboardingIntegrations.find((integration) => integration.id === integrationId && integration.onboardingId === onboardingId)
      if (!item) throw new RecruitingNotFoundError(`未找到入职系统集成：${integrationId}`)
      const mutable = item as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete mutable[key]
        else mutable[key] = value
      }
      item.updatedAt = now
      addEvent(state, { subjectType: 'onboarding', subjectId: onboardingId, action: 'integration_update', actorId, ...(input.status ? { metadata: { provider: item.provider, status: input.status } } : {}) })
      return item
    })
  }
  async onboardingAction(id: string, action: string, reason?: unknown, actorId = 'user-demo'): Promise<OnboardingRecord> {
    const allowed: Record<string, OnboardingRecord['status'][]> = {
      prepare: ['pending'],
      schedule: ['preparing'],
      complete: ['scheduled'],
      no_show: ['scheduled'],
      cancel: ['pending', 'preparing', 'scheduled'],
    }
    const nextStatus: Record<string, OnboardingRecord['status']> = {
      prepare: 'preparing',
      schedule: 'scheduled',
      complete: 'completed',
      no_show: 'no_show',
      cancel: 'cancelled',
    }
    if (this.repository) {
      const current = this.mapRepositoryOnboarding(await this.repository.getOnboarding(id))
      const from = current.status
      if (!allowed[action] || !allowed[action]!.includes(from)) throw new RecruitingWorkflowError('ONBOARDING_INVALID_TRANSITION', `入职归档状态 ${from} 不允许执行 ${action}`, 409)
      if (action === 'schedule') {
        const missing = missingSchedulingFields(current)
        if (missing.length) throw new RecruitingWorkflowError('ONBOARDING_SCHEDULE_INCOMPLETE', `安排报到前请补充：${missing.join('、')}`, 400)
      }
      if (action === 'complete') {
        const tasks = (await this.repository.listOnboardingTasks(current.id)).map((item) => this.mapRepositoryOnboardingTask(item))
        const materials = (await this.repository.listOnboardingMaterials(current.id)).map((item) => this.mapRepositoryOnboardingMaterial(item))
        const incompleteTasks = tasks.filter((task) => task.isRequired && !['completed', 'not_required'].includes(task.status))
        const incompleteMaterials = materials.filter((material) => material.isRequired && !['verified', 'waived'].includes(material.status))
        if (incompleteTasks.length || incompleteMaterials.length) throw new RecruitingWorkflowError('ONBOARDING_COMPLETION_BLOCKED', `仍有 ${incompleteTasks.length} 项必选任务、${incompleteMaterials.length} 项必选材料未完成`, 409)
      }
      const validatedReason = action === 'cancel' || action === 'no_show' ? validateOnboardingReason(action, reason) : undefined
      const timestamp = LocalRecruitingStore.timestamp()
      const patch: {
        status: OnboardingRecord['status']
        archivedAt?: string
        actualArrivalAt?: string
        cancellationReasonCode?: string
        cancellationNotes?: string
        cancelledAt?: string
        noShowReasonCode?: string
        noShowNotes?: string
        noShowAt?: string
      } = {
        status: nextStatus[action]!,
        ...(action === 'complete' ? { archivedAt: timestamp, actualArrivalAt: timestamp } : {}),
        ...(action === 'cancel' ? { cancelledAt: timestamp, ...(validatedReason?.reasonCode ? { cancellationReasonCode: validatedReason.reasonCode } : {}), ...(validatedReason?.notes ? { cancellationNotes: validatedReason.notes } : {}) } : {}),
        ...(action === 'no_show' ? { noShowAt: timestamp, ...(validatedReason?.reasonCode ? { noShowReasonCode: validatedReason.reasonCode } : {}), ...(validatedReason?.notes ? { noShowNotes: validatedReason.notes } : {}) } : {}),
      }
      const patched = await this.repository.updateOnboarding(current.id, patch)
      if (action === 'complete') {
        const application = await this.repository.getApplication(current.applicationId)
        if (application.status !== 'onboarding_archived') await this.repository.updateApplicationStatus(application.id, 'onboarding_archived')
        await this.repository.appendWorkflowEvent({ subjectType: 'application', subjectId: application.id, action: 'status_changed', fromStatus: application.status, toStatus: 'onboarding_archived', actorId })
      }
      await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: current.id, action, fromStatus: from, toStatus: patched.status, actorId, ...(validatedReason?.auditReason ? { reason: validatedReason.auditReason } : {}) })
      if (action === 'schedule') await this.refreshOnboardingReminders(current.id, actorId)
      return this.mapRepositoryOnboarding(patched)
    }
    return this.store.transaction((state) => {
      const item = state.onboarding.find((record) => record.id === id)
      if (!item) throw new RecruitingNotFoundError(`未找到入职归档：${id}`)
      const from = item.status
      if (!allowed[action] || !allowed[action]!.includes(from)) throw new RecruitingWorkflowError('ONBOARDING_INVALID_TRANSITION', `入职归档状态 ${from} 不允许执行 ${action}`, 409)
      if (action === 'schedule') {
        const missing = missingSchedulingFields(item)
        if (missing.length) throw new RecruitingWorkflowError('ONBOARDING_SCHEDULE_INCOMPLETE', `安排报到前请补充：${missing.join('、')}`, 400)
      }
      if (action === 'complete') {
        const incompleteTasks = state.onboardingTasks.filter((task) => task.onboardingId === item.id && task.isRequired && !['completed', 'not_required'].includes(task.status))
        const incompleteMaterials = state.onboardingMaterials.filter((material) => material.onboardingId === item.id && material.isRequired && !['verified', 'waived'].includes(material.status))
        if (incompleteTasks.length || incompleteMaterials.length) throw new RecruitingWorkflowError('ONBOARDING_COMPLETION_BLOCKED', `仍有 ${incompleteTasks.length} 项必选任务、${incompleteMaterials.length} 项必选材料未完成`, 409)
      }
      const validatedReason = action === 'cancel' || action === 'no_show' ? validateOnboardingReason(action, reason) : undefined
      const now = LocalRecruitingStore.timestamp()
      item.status = nextStatus[action]!
      item.updatedAt = now
      if (action === 'complete') {
        item.actualArrivalAt = now
        item.archivedAt = now
        const app = state.applications.find((record) => record.id === item.applicationId)
        if (app) {
          const applicationFrom = app.status
          app.status = 'onboarding_archived'
          app.updatedAt = now
          addEvent(state, { subjectType: 'application', subjectId: app.id, action: 'status_changed', fromStatus: applicationFrom, toStatus: 'onboarding_archived', actorId })
        }
      }
      if (action === 'cancel') {
        item.cancelledAt = now
        if (validatedReason?.reasonCode) item.cancellationReasonCode = validatedReason.reasonCode as NonNullable<OnboardingRecord['cancellationReasonCode']>
        if (validatedReason?.notes) item.cancellationNotes = validatedReason.notes
      }
      if (action === 'no_show') {
        item.noShowAt = now
        if (validatedReason?.reasonCode) item.noShowReasonCode = validatedReason.reasonCode as NonNullable<OnboardingRecord['noShowReasonCode']>
        if (validatedReason?.notes) item.noShowNotes = validatedReason.notes
      }
      addEvent(state, { subjectType: 'onboarding', subjectId: item.id, action, fromStatus: from, toStatus: item.status, actorId, ...(validatedReason?.auditReason ? { reason: validatedReason.auditReason } : {}) })
      if (action === 'schedule' && item.plannedStartDate) {
        const timestamp = LocalRecruitingStore.timestamp()
        for (const reminder of buildOnboardingReminderSchedule(item.plannedStartDate)) {
          const existing = state.onboardingReminders.find((entry) => entry.onboardingId === item.id && entry.milestone === reminder.milestone && entry.audience === reminder.audience && entry.channel === 'in_app')
          if (existing) {
            existing.scheduledAt = reminder.scheduledAt
            existing.updatedAt = timestamp
          } else {
            state.onboardingReminders.push({ id: randomUUID(), onboardingId: item.id, ...reminder, channel: 'in_app', status: 'scheduled', createdAt: timestamp, updatedAt: timestamp })
          }
        }
        addEvent(state, { subjectType: 'onboarding', subjectId: item.id, action: 'reminders_refresh', actorId })
      }
      return item
    })
  }
  async createOffer(input: CreateOfferInput, actorId = 'user-demo'): Promise<OfferRecord> {
    const templateFields = normalizeOfferTemplateFields(input.templateFields)
    const invoiceTitle = normalizeOfferInvoiceField(input.invoiceTitle, '发票抬头', 200)
    const taxNumber = normalizeOfferInvoiceField(input.taxNumber, '企业税号', 100)
    if (this.repository) {
      const application = await this.repository.getApplication(required(input.applicationId, '申请'))
      if (!['interviewing', 'offer_approval', 'offer_cancelled'].includes(application.status)) throw new RecruitingWorkflowError('OFFER_APPLICATION_INVALID', '当前申请不允许创建 Offer')
      const offer = await this.repository.createOffer({ applicationId: application.id, status: 'draft', approvalStatus: 'pending' })
      const compensation = { baseSalary: input.baseSalary, ...(input.probationSalary ? { probationSalary: input.probationSalary } : {}), ...(input.bonus ? { bonus: input.bonus } : {}), ...(input.equity ? { equity: input.equity } : {}) }
      const version = await this.repository.createOfferVersion({ offerId: offer.id, positionTitle: required(input.positionTitle, '职位名称'), departmentId: required(input.departmentId, '部门'), employmentType: required(input.employmentType, '用工类型'), startDate: input.startDate ?? null, reportingLocation: input.reportingLocation?.trim() || null, invoiceTitle: invoiceTitle || null, taxNumber: taxNumber || null, templateFields: templateFields ?? {}, compensation: compensation as unknown as Record<string, unknown>, benefits: input.benefits ?? [], materials: input.materials ?? [], content: required(input.content, 'Offer 内容') })
      const updated = await this.repository.updateOffer(offer.id, { currentVersionId: version.id })
      await this.repository.appendWorkflowEvent({ subjectType: 'offer', subjectId: offer.id, action: 'create', toStatus: 'draft', actorId })
      return this.mapRepositoryOffer(updated)
    }
    return this.store.transaction(state=>{ const app=applicationOrThrow(state,required(input.applicationId,'申请')); if(!isLocalOfferEligible(app, state)) throw new RecruitingWorkflowError('OFFER_APPLICATION_INVALID','只有第二轮复试已确认通过的申请才能创建 Offer', 409); const t=LocalRecruitingStore.timestamp(); const offer:OfferRecord={id:randomUUID(),code:`OFF-${state.nextOfferNumber++}`,applicationId:app.id,status:'draft',approval:{status:'pending',approver:'待审批'},version:1,createdAt:t,updatedAt:t}; const v:OfferVersionRecord={id:randomUUID(),offerId:offer.id,version:1,positionTitle:required(input.positionTitle,'职位名称'),departmentId:required(input.departmentId,'部门'),employmentType:required(input.employmentType,'用工类型'),...(input.startDate?{startDate:input.startDate}:{}),...(input.reportingLocation?.trim()?{reportingLocation:input.reportingLocation.trim()}:{}),invoiceTitle:invoiceTitle??'',taxNumber:taxNumber??'',templateFields:templateFields??{},compensation:{baseSalary:input.baseSalary,...(input.probationSalary?{probationSalary:input.probationSalary}:{}),...(input.bonus?{bonus:input.bonus}:{}),...(input.equity?{equity:input.equity}:{})},benefits:input.benefits??[],materials:input.materials??[],content:required(input.content,'Offer 内容'),createdAt:t}; state.offers.push(offer); state.offerVersions.push(v); offer.currentVersionId=v.id; addEvent(state,{subjectType:"offer",subjectId:offer.id,action:"create",toStatus:"draft",actorId}); return offer }) }
  async updateOffer(id:string,input:Partial<CreateOfferInput>, actorId = 'user-demo', expectedVersion?: number):Promise<OfferRecord>{
    const templateFields = normalizeOfferTemplateFields(input.templateFields)
    const invoiceTitle = normalizeOfferInvoiceField(input.invoiceTitle, '发票抬头', 200)
    const taxNumber = normalizeOfferInvoiceField(input.taxNumber, '企业税号', 100)
    if (this.repository) {
      const offer = await this.repository.getOffer(id)
      if (expectedVersion !== undefined && offer.version !== expectedVersion) throw new RecruitingWorkflowError('OFFER_VERSION_CONFLICT', 'Offer 已有变更，请刷新后重新编辑')
      if (!['draft', 'sent', 'cancelled', 'accepted'].includes(offer.status)) throw new RecruitingWorkflowError('OFFER_IMMUTABLE', '当前状态的 Offer 不允许修改')
      if (offer.status !== 'accepted' && await this.repository.getOnboardingByOfferId(offer.id)) throw new RecruitingWorkflowError('OFFER_IMMUTABLE', '已进入入职流程的 Offer 不允许修改')
      const versions = await this.repository.listOfferVersions(offer.id)
      const previous = versions.find(version => version.id === offer.currentVersionId) ?? versions[0]
      if (!previous) throw new RecruitingNotFoundError('Offer 还没有版本记录')
      const priorCompensation = previous.compensation as { baseSalary?: { amount: number; currency: string }; probationSalary?: { amount: number; currency: string }; bonus?: { amount: number; currency: string }; equity?: string }
      const startDate = input.startDate !== undefined ? input.startDate : previous.startDate
      const reportingLocation = input.reportingLocation !== undefined ? input.reportingLocation.trim() : previous.reportingLocation
      const equity = input.equity !== undefined ? input.equity : priorCompensation.equity
      const bonus = input.bonus !== undefined ? input.bonus : priorCompensation.bonus
      const baseSalary = input.baseSalary ?? priorCompensation.baseSalary
      if (!baseSalary) throw new RecruitingWorkflowError('OFFER_BASE_SALARY_REQUIRED', 'Offer 缺少基本薪资', 400)
      const probationSalary = input.probationSalary !== undefined ? input.probationSalary : priorCompensation.probationSalary
      const compensation = { baseSalary, ...(probationSalary ? { probationSalary } : {}), ...(bonus ? { bonus } : {}), ...(equity ? { equity } : {}) }
      return this.mapRepositoryOffer(await this.repository.reviseOffer({ offerId: offer.id, positionTitle: input.positionTitle?.trim() || previous.positionTitle, departmentId: input.departmentId?.trim() || previous.departmentId, employmentType: input.employmentType || previous.employmentType, startDate: startDate ?? null, reportingLocation: reportingLocation || null, invoiceTitle: invoiceTitle !== undefined ? invoiceTitle || null : previous.invoiceTitle, taxNumber: taxNumber !== undefined ? taxNumber || null : previous.taxNumber, templateFields: templateFields === undefined ? previous.templateFields ?? {} : { ...previous.templateFields, ...templateFields }, compensation: compensation as unknown as Record<string, unknown>, benefits: input.benefits ?? previous.benefits, materials: input.materials ?? previous.materials, content: input.content?.trim() || previous.content }, previous.id, offer.version, actorId))
    }
    return this.store.transaction(state=>{const o=state.offers.find(x=>x.id===id);if(!o)throw new RecruitingNotFoundError(`未找到 Offer：${id}`);if(expectedVersion!==undefined&&o.version!==expectedVersion)throw new RecruitingWorkflowError('OFFER_VERSION_CONFLICT','Offer 已有变更，请刷新后重新编辑');if(!['draft','sent','cancelled','accepted'].includes(o.status))throw new RecruitingWorkflowError('OFFER_IMMUTABLE','当前状态的 Offer 不允许修改');if(o.status!=='accepted'&&state.onboarding.some((item)=>item.offerId===id))throw new RecruitingWorkflowError('OFFER_IMMUTABLE','已进入入职流程的 Offer 不允许修改');const fromStatus=o.status;const old=state.offerVersions.filter(x=>x.offerId===id).sort((a,b)=>b.version-a.version)[0]!;const startDate=input.startDate!==undefined?input.startDate:old.startDate;const reportingLocation=input.reportingLocation!==undefined?input.reportingLocation.trim():old.reportingLocation;const equity=input.equity!==undefined?input.equity:old.compensation.equity;const bonus=input.bonus!==undefined?input.bonus:old.compensation.bonus;const baseSalary=input.baseSalary??old.compensation.baseSalary;const probationSalary=input.probationSalary!==undefined?input.probationSalary:old.compensation.probationSalary;const compensation:{baseSalary:{amount:number;currency:string};probationSalary?:{amount:number;currency:string};bonus?:{amount:number;currency:string};equity?:string}={baseSalary,...(probationSalary?{probationSalary}:{}),...(bonus?{bonus}:{}),...(equity?{equity}:{})};const v:OfferVersionRecord={...old,id:randomUUID(),version:old.version+1,positionTitle:input.positionTitle?.trim()||old.positionTitle,departmentId:input.departmentId?.trim()||old.departmentId,employmentType:input.employmentType||old.employmentType,...(startDate?{startDate}:{}),...(reportingLocation?{reportingLocation}:{}),invoiceTitle:invoiceTitle!==undefined?invoiceTitle:old.invoiceTitle??'',taxNumber:taxNumber!==undefined?taxNumber:old.taxNumber??'',templateFields:templateFields===undefined?old.templateFields??{}:{...old.templateFields,...templateFields},compensation,benefits:input.benefits??old.benefits,materials:input.materials??old.materials,content:input.content?.trim()||old.content,createdAt:LocalRecruitingStore.timestamp()};if(!startDate)delete v.startDate;if(!reportingLocation)delete v.reportingLocation;state.offerVersions.push(v);o.currentVersionId=v.id;o.version++;o.updatedAt=LocalRecruitingStore.timestamp();addEvent(state,{subjectType:'offer',subjectId:o.id,action:'revise',fromStatus,toStatus:fromStatus,actorId,metadata:{previousVersionId:old.id,versionId:v.id}});return o})}
  async offerAction(id:string,action:string,reason?:unknown,actorId = 'user-demo',expiresAt?:string, expectedVersionId?:string, metadata?:Record<string,unknown>):Promise<OfferRecord|OnboardingRecord>{
    if (expiresAt !== undefined && (!['send', 'resend', 'resend_cancelled'].includes(action) || !Number.isFinite(Date.parse(expiresAt)))) throw new RecruitingWorkflowError('OFFER_EXPIRY_INVALID', '有效期日期无效', 400)
    if (this.repository) {
      const offer = await this.repository.getOffer(id)
      const from = offer.status
      if (expectedVersionId && offer.currentVersionId !== expectedVersionId) throw new RecruitingWorkflowError('OFFER_VERSION_CONFLICT', 'Offer 已有新版本，请刷新并重新预览')
      if (action === 'confirm_revision' && !expectedVersionId) throw new RecruitingWorkflowError('OFFER_VERSION_REQUIRED', '请指定候选人确认的版本', 400)
      const timestamp = LocalRecruitingStore.timestamp()
      if (action === 'archive_onboarding') {
        const versions = await this.repository.listOfferVersions(offer.id)
        const currentVersion = versions.find((version) => version.id === offer.currentVersionId)
          ?? [...versions].sort((left, right) => right.version - left.version)[0]
        let existing = await this.repository.getOnboardingByOfferId(offer.id)
        if (!existing && from !== 'accepted') throw new RecruitingWorkflowError('OFFER_INVALID_TRANSITION', `Offer 状态 ${from} 不允许执行 ${action}`)
        let created = false
        if (!existing) {
          existing = await this.repository.createOnboarding({
            applicationId: offer.applicationId,
            offerId: offer.id,
            status: 'pending',
            ...(currentVersion?.startDate ? { plannedStartDate: currentVersion.startDate } : {}),
          })
          created = true
        } else if (!existing.plannedStartDate && currentVersion?.startDate) {
          existing = await this.repository.updateOnboarding(existing.id, { plannedStartDate: currentVersion.startDate })
        }
        const onboarding = this.mapRepositoryOnboarding(existing)
        const tasks = await this.repository.listOnboardingTasks(onboarding.id)
        const existingTaskKeys = new Set(tasks.map((task) => task.templateKey ?? `${task.category}\u0000${task.title}`))
        for (const task of defaultOnboardingTasks()) {
          const key = task.templateKey ?? `${task.category}\u0000${task.title}`
          if (!existingTaskKeys.has(key)) await this.repository.createOnboardingTask({ onboardingId: onboarding.id, ...task })
        }
        const materialLabels = currentVersion?.materials.length ? currentVersion.materials : defaultOnboardingMaterials
        const materials = await this.repository.listOnboardingMaterials(onboarding.id)
        const existingMaterialCodes = new Set(materials.map((material) => material.code))
        for (const material of onboardingMaterialTemplates(materialLabels)) {
          if (!existingMaterialCodes.has(material.code)) await this.repository.createOnboardingMaterial({ onboardingId: onboarding.id, ...material })
        }
        const integrations = await this.repository.listOnboardingIntegrations(onboarding.id)
        const existingProviders = new Set(integrations.map((integration) => integration.provider))
        for (const provider of defaultOnboardingIntegrationProviders) {
          if (!existingProviders.has(provider)) await this.repository.createOnboardingIntegration({ onboardingId: onboarding.id, provider })
        }
        if (onboarding.plannedStartDate) {
          const reminders = await this.repository.listOnboardingReminders(onboarding.id)
          for (const reminder of buildOnboardingReminderSchedule(onboarding.plannedStartDate)) {
            if (!reminders.some((item) => item.milestone === reminder.milestone && item.audience === reminder.audience && item.channel === 'in_app')) {
              await this.repository.createOnboardingReminder({ onboardingId: onboarding.id, ...reminder, channel: 'in_app' })
            }
          }
        }
        if (created) await this.repository.appendWorkflowEvent({ subjectType: 'onboarding', subjectId: onboarding.id, action, fromStatus: 'accepted', toStatus: 'pending', actorId })
        return onboarding
      }
      const transition = transitionOfferWorkflow(from, action, reason)
      const result = await this.repository.transitionOffer(offer.id, {
        action,
        fromStatus: transition.fromOfferStatus,
        toStatus: transition.offerStatus,
        applicationStatus: transition.applicationStatus,
        ...(expectedVersionId ? { expectedVersionId } : {}),
        ...(metadata ? { metadata } : {}),
        actorId,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(transition.reason ? { reason: transition.reason } : {}),
      })
      return this.mapRepositoryOffer(result.offer)
    }
    return this.store.transaction((state) => {
      const offer = state.offers.find((record) => record.id === id)
      if (!offer) throw new RecruitingNotFoundError(`未找到 Offer：${id}`)
      const timestamp = LocalRecruitingStore.timestamp()
      const from = offer.status
      if (expectedVersionId && offer.currentVersionId !== expectedVersionId) throw new RecruitingWorkflowError('OFFER_VERSION_CONFLICT', 'Offer 已有新版本，请刷新并重新预览')
      if (action === 'confirm_revision' && !expectedVersionId) throw new RecruitingWorkflowError('OFFER_VERSION_REQUIRED', '请指定候选人确认的版本', 400)
      if (action === 'archive_onboarding') {
        const versions = state.offerVersions.filter((version) => version.offerId === offer.id)
        const currentVersion = versions.find((version) => version.id === offer.currentVersionId)
          ?? [...versions].sort((left, right) => right.version - left.version)[0]
        let onboarding = state.onboarding.find((record) => record.offerId === offer.id)
        if (!onboarding && from !== 'accepted') throw new RecruitingWorkflowError('OFFER_INVALID_TRANSITION', `Offer 状态 ${from} 不允许执行 ${action}`)
        let created = false
        if (!onboarding) {
          onboarding = {
            id: randomUUID(),
            applicationId: offer.applicationId,
            offerId: offer.id,
            status: 'pending',
            ...(currentVersion?.startDate ? { plannedStartDate: currentVersion.startDate } : {}),
            createdAt: timestamp,
            updatedAt: timestamp,
          }
          state.onboarding.push(onboarding)
          created = true
        } else if (!onboarding.plannedStartDate && currentVersion?.startDate) {
          onboarding.plannedStartDate = currentVersion.startDate
          onboarding.updatedAt = timestamp
        }
        const existingTaskKeys = new Set(state.onboardingTasks.filter((task) => task.onboardingId === onboarding!.id).map((task) => task.templateKey ?? `${task.category}\u0000${task.title}`))
        for (const task of defaultOnboardingTasks()) {
          const key = task.templateKey ?? `${task.category}\u0000${task.title}`
          if (!existingTaskKeys.has(key)) state.onboardingTasks.push({ id: randomUUID(), onboardingId: onboarding.id, status: 'pending', createdAt: timestamp, updatedAt: timestamp, ...task })
        }
        const materialLabels = currentVersion?.materials.length ? currentVersion.materials : defaultOnboardingMaterials
        const existingMaterialCodes = new Set(state.onboardingMaterials.filter((material) => material.onboardingId === onboarding!.id).map((material) => material.code))
        for (const material of onboardingMaterialTemplates(materialLabels)) {
          if (!existingMaterialCodes.has(material.code)) state.onboardingMaterials.push({ id: randomUUID(), onboardingId: onboarding.id, status: 'pending', ...material, createdAt: timestamp, updatedAt: timestamp })
        }
        const existingProviders = new Set(state.onboardingIntegrations.filter((integration) => integration.onboardingId === onboarding!.id).map((integration) => integration.provider))
        for (const provider of defaultOnboardingIntegrationProviders) {
          if (!existingProviders.has(provider)) state.onboardingIntegrations.push({ id: randomUUID(), onboardingId: onboarding.id, provider, status: 'not_configured', createdAt: timestamp, updatedAt: timestamp })
        }
        if (onboarding.plannedStartDate) {
          for (const reminder of buildOnboardingReminderSchedule(onboarding.plannedStartDate)) {
            const existing = state.onboardingReminders.some((item) => item.onboardingId === onboarding!.id && item.milestone === reminder.milestone && item.audience === reminder.audience && item.channel === 'in_app')
            if (!existing) state.onboardingReminders.push({ id: randomUUID(), onboardingId: onboarding.id, ...reminder, channel: 'in_app', status: 'scheduled', createdAt: timestamp, updatedAt: timestamp })
          }
        }
        if (created) addEvent(state, { subjectType: 'onboarding', subjectId: onboarding.id, action, fromStatus: 'accepted', toStatus: 'pending', actorId })
        return onboarding
      }
      const transition = transitionOfferWorkflow(from, action, reason)
      const application = state.applications.find((record) => record.id === offer.applicationId)
      if (!application) throw new RecruitingNotFoundError(`未找到 Offer 关联的申请：${offer.applicationId}`)
      const fromApplicationStatus = application.status
      offer.status = transition.offerStatus
      if (from !== 'accepted') {
        application.status = transition.applicationStatus
        application.updatedAt = timestamp
      }
      if ((action === 'send' || action === 'resend' || action === 'resend_cancelled') && !offer.sentAt) offer.sentAt = timestamp
      if (action === 'accept' || action === 'decline') offer.respondedAt = timestamp
      if (action === 'expire') offer.expiresAt = offer.expiresAt ?? timestamp
      if (expiresAt !== undefined) offer.expiresAt = expiresAt
      offer.version++
      offer.updatedAt = timestamp
      addEvent(state, { subjectType: 'offer', subjectId: offer.id, action, fromStatus: from, toStatus: offer.status, actorId, metadata: { ...metadata, versionId: offer.currentVersionId }, ...(transition.reason ? { reason: transition.reason } : {}) })
      if (from !== 'accepted') addEvent(state, { subjectType: 'application', subjectId: application.id, action: 'status_changed', fromStatus: fromApplicationStatus, toStatus: application.status, actorId })
      return offer
    })
  }
  async listWorkflowEvents(filter?: { subjectType?: WorkflowEventRecord['subjectType']; candidateId?: string; departmentId?: string; limit?: number }): Promise<Array<WorkflowEventRecord & { subjectLabel: string }>> {
    const state = await this.stateView()
    const limit = Math.max(1, Math.min(filter?.limit ?? 200, 500))
    const subjectType = filter?.subjectType
    const sourceEvents: WorkflowEventRecord[] = this.repository && filter?.candidateId
      ? (await this.repository.listWorkflowEvents({ candidateId: filter.candidateId, ...(filter.departmentId ? { departmentId: filter.departmentId } : {}), ...(subjectType ? { subjectType } : {}), limit })).map((event) => ({
        id: event.id,
        subjectType: event.subjectType as WorkflowEventRecord['subjectType'],
        subjectId: event.subjectId,
        action: event.action,
        ...(event.fromStatus ? { fromStatus: event.fromStatus } : {}),
        ...(event.toStatus ? { toStatus: event.toStatus } : {}),
        actorId: event.actorId ?? '',
        ...(event.actorName ? { actorName: event.actorName } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        createdAt: event.createdAt,
      }))
      : state.workflowEvents
    const candidateApplications = filter?.candidateId
      ? state.applications.filter((application) => application.candidateId === filter.candidateId && (!filter.departmentId || state.jobs.some((job) => job.id === application.jobId && job.departmentId === filter.departmentId)))
      : []
    const applicationIds = new Set(candidateApplications.map((application) => application.id))
    const relatedInterviewIds = new Set(state.interviews.filter((interview) => applicationIds.has(interview.applicationId)).map((interview) => interview.id))
    const relatedOfferIds = new Set(state.offers.filter((offer) => applicationIds.has(offer.applicationId)).map((offer) => offer.id))
    const relatedOnboardingIds = new Set(state.onboarding.filter((record) => applicationIds.has(record.applicationId)).map((record) => record.id))
    return sourceEvents
      .filter((event) => !subjectType || event.subjectType === subjectType)
      .filter((event) => !filter?.candidateId || (
        (event.subjectType === 'candidate' && event.subjectId === filter.candidateId && candidateApplications.length > 0)
        || (event.subjectType === 'application' && applicationIds.has(event.subjectId))
        || (event.subjectType === 'interview' && relatedInterviewIds.has(event.subjectId))
        || (event.subjectType === 'offer' && relatedOfferIds.has(event.subjectId))
        || (event.subjectType === 'onboarding' && relatedOnboardingIds.has(event.subjectId))
      ))
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




