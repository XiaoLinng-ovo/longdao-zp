import type { Pool, QueryResultRow } from 'pg'

export interface RepositoryQueryExecutor {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>
}

export interface RepositoryClient extends RepositoryQueryExecutor {
  release(): void
}

export interface RepositoryPool extends RepositoryQueryExecutor {
  connect(): Promise<RepositoryClient>
  end(): Promise<void>
}

export type RepositoryStatus = string

export interface IdMapping {
  /** Database primary key. This value is always a UUID. */
  id: string
  /** Stable business number stored in the *_no column. */
  businessId: string
  /** Compatibility key used by the legacy seed state. */
  legacyId: string
}

export interface RecruitmentRequestRecord extends IdMapping {
  code: string
  title: string
  departmentId: string | null
  departmentName: string | null
  requestedById: string | null
  requesterName: string | null
  requesterEmail: string | null
  hiringManagerId: string | null
  headcount: number
  budgetMin: number | null
  budgetMax: number | null
  employmentType: string | null
  workMode: string | null
  location: string | null
  reason: string
  status: RepositoryStatus
  version: number
  createdAt: string
  updatedAt: string
}

export interface JobRecord extends IdMapping {
  code: string
  recruitmentRequestId: string | null
  recruitmentRequestBusinessId: string | null
  departmentId: string
  departmentName: string | null
  title: string
  status: RepositoryStatus
  headcount: number
  employmentType: string | null
  workMode: string | null
  location: string | null
  createdById: string | null
  createdAt: string
  updatedAt: string
}

export interface CandidateRecord extends IdMapping {
  code: string
  name: string
  email: string | null
  phone: string | null
  location: string | null
  source: string | null
  consentStatus: RepositoryStatus
  createdAt: string
  updatedAt: string
}

export interface ApplicationRecord extends IdMapping {
  code: string
  candidateId: string
  candidateBusinessId: string | null
  jobId: string
  jobBusinessId: string | null
  status: RepositoryStatus
  recruiterId: string | null
  source: string | null
  appliedAt: string
  rejectedReason: string | null
  withdrawnAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RecruitmentRequestCreateInput {
  id?: string
  businessId?: string
  requestNo?: string
  title: string
  departmentId?: string | null
  requestedById?: string | null
  hiringManagerId?: string | null
  headcount: number
  budgetMin?: number | null
  budgetMax?: number | null
  employmentType?: string | null
  workMode?: string | null
  location?: string | null
  reason?: string
  status?: string
  version?: number
}

export type RecruitmentRequestUpdateInput = Partial<Omit<RecruitmentRequestCreateInput, 'id' | 'businessId' | 'requestNo'>>

export interface JobCreateInput {
  id?: string
  businessId?: string
  jobNo?: string
  recruitmentRequestId?: string | null
  departmentId: string
  title: string
  status?: string
  headcount: number
  employmentType?: string | null
  workMode?: string | null
  location?: string | null
  createdById?: string | null
}

export type JobUpdateInput = Partial<Omit<JobCreateInput, 'id' | 'businessId' | 'jobNo' | 'recruitmentRequestId'>>

export interface CandidateCreateInput {
  id?: string
  businessId?: string
  candidateNo?: string
  name: string
  email?: string | null
  phone?: string | null
  location?: string | null
  source?: string | null
  consentStatus?: string
}

export type CandidateUpdateInput = Partial<Omit<CandidateCreateInput, 'id' | 'businessId' | 'candidateNo'>>

export interface ApplicationCreateInput {
  id?: string
  businessId?: string
  applicationNo?: string
  candidateId: string
  jobId: string
  status?: string
  recruiterId?: string | null
  source?: string | null
  appliedAt?: string
}

export type ApplicationUpdateInput = Partial<Pick<ApplicationCreateInput, 'status' | 'recruiterId' | 'source'>> & {
  rejectedReason?: string | null
  withdrawnAt?: string | null
}

export interface ResumeRecord {
  id: string; candidateId: string; applicationId: string | null; storageKey: string; originalFilename: string; mimeType: string; sizeBytes: number; scanStatus: string; contentHash: string | null; createdAt: string
}

export interface ResumeCreateInput { id?: string; candidateId: string; applicationId?: string | null; storageKey: string; originalFilename: string; mimeType: string; sizeBytes: number; contentHash: string; scanStatus?: string }

export interface RecruitmentApprovalInstanceRecord {
  id: string
  entityType: 'recruitment_request'
  entityId: string
  version: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  createdAt: string
  updatedAt: string
}

export interface RecruitmentApprovalStepRecord {
  id: string
  instanceId: string
  order: number
  name: string
  approverRole: string
  status: 'pending' | 'approved' | 'rejected'
  actedAt?: string
}

export interface RecruitmentApprovalAuditRecord {
  id: string
  instanceId: string
  stepId: string
  actorId: string
  action: 'approve' | 'reject'
  comment?: string
  createdAt: string
}

export interface AnalysisTaskRecord {
  id: string
  resumeId: string
  applicationId: string | null
  status: string
  attempts: number
  idempotencyKey: string
  lastError: string | null
  availableAt: string
  startedAt: string | null
  completedAt: string | null
  createdAt: string
}

export interface AnalysisResultRecord {
  id: string
  analysisTaskId: string
  resumeId: string
  applicationId: string | null
  result: Record<string, unknown>
  analyzerVersion: string | null
  inputHash: string | null
  humanReviewStatus: string
  createdAt: string
}

export interface RepositoryOptions {
  /** Used when a legacy id has no corresponding row in a *_no column. */
  generatedBusinessId?: (prefix: string) => string
}

export interface TransactionCallback<T> {
  (client: RepositoryClient): Promise<T> | T
}

export type PgPool = Pool

// ===== 岗位说明书 / JD 版本（job_spec_versions / job_description_versions）=====
export interface JobSpecVersionDbRecord {
  id: string
  jobId: string
  version: number
  content: Record<string, unknown>
  createdById: string | null
  createdAt: string
  confirmedAt: string | null
}

export interface JobDescriptionVersionDbRecord {
  id: string
  jobId: string
  version: number
  title: string
  content: string
  status: string
  createdById: string | null
  createdAt: string
  confirmedAt: string | null
}

export interface JobSpecVersionCreateInput {
  id?: string
  jobId: string
  version?: number
  content: Record<string, unknown>
  createdById?: string | null
  confirmedAt?: string | null
}

export interface JobDescriptionVersionCreateInput {
  id?: string
  jobId: string
  version?: number
  title?: string
  content: string
  status?: string
  createdById?: string | null
}

// ===== 面试（interviews / interview_feedback）=====
export interface InterviewParticipantDbRecord {
  userId: string
  name?: string
  role: string
  required: boolean
}

export interface InterviewDbRecord {
  id: string
  businessId: string
  applicationId: string
  round: number
  type: string
  title: string
  status: string
  scheduledStartAt: string | null
  scheduledEndAt: string | null
  timezone: string | null
  location: string | null
  meetingUrl: string | null
  participants: InterviewParticipantDbRecord[]
  createdAt: string
  updatedAt: string
}

export interface InterviewCreateInput {
  id?: string
  businessId?: string
  applicationId: string
  round?: number
  type?: string
  title: string
  status?: string
  scheduledStartAt?: string | null
  scheduledEndAt?: string | null
  timezone?: string | null
  location?: string | null
  meetingUrl?: string | null
  participants?: InterviewParticipantDbRecord[]
}

export interface InterviewUpdateInput {
  round?: number
  type?: string
  title?: string
  status?: string
  scheduledStartAt?: string | null
  scheduledEndAt?: string | null
  timezone?: string | null
  location?: string | null
  meetingUrl?: string | null
  participants?: InterviewParticipantDbRecord[]
}

export interface InterviewFeedbackDbRecord {
  id: string
  interviewId: string
  interviewerId: string
  status: string
  overallScore: number | null
  recommendation: string | null
  ratings: Record<string, number>
  strengths: string[]
  concerns: string[]
  notes: string | null
  submittedAt: string | null
  lockedAt: string | null
}

export interface InterviewFeedbackUpdateInput {
  status?: string
  overallScore?: number | null
  recommendation?: string | null
  ratings?: Record<string, number>
  strengths?: string[]
  concerns?: string[]
  notes?: string | null
  submittedAt?: string | null
  lockedAt?: string | null
}

export interface InterviewFeedbackUpsertInput {
  id?: string
  interviewId: string
  interviewerId: string
  status?: string
  overallScore?: number | null
  recommendation?: string | null
  ratings?: Record<string, number>
  strengths?: string[]
  concerns?: string[]
  notes?: string | null
  submittedAt?: string | null
  lockedAt?: string | null
}

// ===== Offer（offers / offer_versions）=====
export interface OfferDbRecord {
  id: string
  businessId: string
  applicationId: string
  status: string
  currentVersionId: string | null
  approvalStatus: string
  sentAt: string | null
  respondedAt: string | null
  expiresAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface OfferVersionDbRecord {
  id: string
  offerId: string
  version: number
  positionTitle: string
  departmentId: string
  employmentType: string
  startDate: string | null
  compensation: Record<string, unknown>
  benefits: string[]
  content: string
  createdAt: string
}

export interface OfferCreateInput {
  id?: string
  applicationId: string
  status?: string
  approvalStatus?: string
  version?: number
}

export interface OfferUpdateInput {
  status?: string
  approvalStatus?: string
  currentVersionId?: string | null
  sentAt?: string | null
  respondedAt?: string | null
  expiresAt?: string | null
  version?: number
}

export interface OfferVersionCreateInput {
  id?: string
  offerId: string
  version?: number
  positionTitle: string
  departmentId: string
  employmentType: string
  startDate?: string | null
  compensation: Record<string, unknown>
  benefits?: string[]
  content: string
}

// ===== 入职归档（onboarding_records）=====
export interface OnboardingDbRecord {
  id: string
  applicationId: string
  offerId: string
  plannedStartDate: string | null
  status: string
  notes: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface OnboardingCreateInput {
  id?: string
  applicationId: string
  offerId: string
  plannedStartDate?: string | null
  status?: string
  notes?: string | null
}

export interface OnboardingUpdateInput {
  plannedStartDate?: string | null
  status?: string
  notes?: string | null
  archivedAt?: string | null
}

// ===== 流程事件（workflow_events）=====
export interface WorkflowEventDbRecord {
  id: string
  subjectType: string
  subjectId: string
  action: string
  fromStatus: string | null
  toStatus: string | null
  actorId: string | null
  actorName: string | null
  reason: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export interface WorkflowEventCreateInput {
  id?: string
  subjectType: string
  subjectId: string
  action: string
  fromStatus?: string | null
  toStatus?: string | null
  actorId?: string | null
  reason?: string | null
  metadata?: Record<string, unknown>
}

export interface WorkflowEventFilter {
  subjectType?: string
  subjectId?: string
  limit?: number
}
