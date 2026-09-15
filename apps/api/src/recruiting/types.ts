export type RecruitmentRequestStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'withdrawn' | 'converted' | 'closed' | 'cancelled'
export type JobStatus = 'draft' | 'ready' | 'published' | 'paused' | 'closed'
export type CandidateStatus = 'active' | 'archived' | 'do_not_contact'
export type ApplicationStatus = 'pending_analysis' | 'analysis_queued' | 'human_review' | 'interviewing' | 'offer_approval' | 'offer_sent' | 'offer_accepted' | 'onboarding_archived' | 'rejected' | 'offer_declined' | 'offer_cancelled' | 'offer_expired'
export type ResumeScanStatus = 'quarantined' | 'local_unscanned' | 'clean' | 'infected' | 'failed'
export type AnalysisTaskStatus = 'queued' | 'processing' | 'completed' | 'failed'
export type OfferStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'declined' | 'cancelled' | 'expired'
export type OnboardingStatus = 'pending' | 'scheduled' | 'completed' | 'cancelled'
export type InterviewType = 'phone_screen' | 'technical' | 'behavioral' | 'case_study' | 'onsite' | 'other'
export type InterviewStatus = 'scheduled' | 'completed' | 'cancelled'
export type InterviewFeedbackStatus = 'draft' | 'submitted' | 'locked'

export interface MoneyRange {
  min?: { amount: number; currency: string }
  max?: { amount: number; currency: string }
}

export interface RecruitmentRequestRecord {
  id: string
  code: string
  title: string
  departmentId: string
  department: string
  requesterId: string
  hiringManagerId?: string
  headcount: number
  employmentType: string
  workMode: string
  location?: string
  salaryRange?: MoneyRange
  justification: string
  status: RecruitmentRequestStatus
  approval: ApprovalRecord
  convertedJobIds: string[]
  version: number
  createdAt: string
  updatedAt: string
}

export interface ApprovalInstanceRecord {
  id: string
  entityType: 'recruitment_request'
  entityId: string
  version: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  createdAt: string
  updatedAt: string
}

export interface ApprovalStepRecord {
  id: string
  instanceId: string
  order: number
  name: string
  approverRole: string
  status: 'pending' | 'approved' | 'rejected'
  actedAt?: string
}

export interface ApprovalAuditRecord {
  id: string
  instanceId: string
  stepId: string
  actorId: string
  action: 'approve' | 'reject'
  comment?: string
  createdAt: string
}

export interface ApprovalRecord {
  status: 'pending' | 'approved' | 'rejected'
  approver: string
  comment?: string
  actedAt?: string
}

export interface JobSpecRecord {
  version: number
  title: string
  summary: string
  responsibilities: string[]
  requirements: Array<{ label: string; description: string; required: boolean; weight?: number }>
  skills: string[]
  confirmed: boolean
  confirmedAt?: string
}

export interface JobDescriptionRecord {
  version: number
  language: string
  content: string
  generatedBy: 'human' | 'ai_assisted'
  confirmed: boolean
  confirmedAt?: string
}

export interface JobSpecVersionRecord extends JobSpecRecord {
  jobId: string
  createdAt: string
  actorId?: string
}

export interface JobDescriptionVersionRecord extends JobDescriptionRecord {
  jobId: string
  createdAt: string
  actorId?: string
}

export interface JobRecord {
  id: string
  code: string
  title: string
  departmentId: string
  department: string
  hiringManagerId?: string
  recruitmentRequestId: string
  headcount: number
  filledCount: number
  employmentType: string
  workMode: string
  location?: string
  status: JobStatus
  channels: string[]
  spec?: JobSpecRecord
  jd?: JobDescriptionRecord
  version: number
  createdAt: string
  updatedAt: string
}

export interface CandidateRecord {
  id: string
  code: string
  fullName: string
  email?: string
  phone?: string
  source?: string
  tags?: string[]
  status: CandidateStatus
  createdAt: string
  updatedAt: string
}

export interface ApplicationRecord {
  id: string
  code: string
  candidateId: string
  jobId: string
  status: ApplicationStatus
  source?: string
  score?: number
  aiStatus: 'pending' | 'completed'
  appliedAt: string
  updatedAt: string
  rejectionReason?: string
}

export interface ResumeRecord {
  id: string
  candidateId: string
  applicationId?: string
  storageKey: string
  originalFilename: string
  mimeType: string
  sizeBytes: number
  contentHash: string
  scanStatus: ResumeScanStatus
  createdAt: string
}

export interface AnalysisTaskRecord {
  id: string
  resumeId: string
  applicationId?: string
  status: AnalysisTaskStatus
  attempts: number
  idempotencyKey: string
  lastError?: string
  availableAt: string
  startedAt?: string
  completedAt?: string
  createdAt: string
}

export interface AnalysisResultRecord {
  id: string
  analysisTaskId: string
  resumeId: string
  applicationId?: string
  result: Record<string, unknown>
  analyzerVersion: string
  inputHash: string
  humanReviewStatus: 'pending' | 'accepted' | 'needs_correction'
  createdAt: string
}

export interface OfferVersionRecord { id: string; offerId: string; version: number; positionTitle: string; departmentId: string; employmentType: string; startDate?: string; compensation: { baseSalary: { amount: number; currency: string }; bonus?: { amount: number; currency: string }; equity?: string }; benefits: string[]; content: string; createdAt: string }
export interface OfferApprovalRecord { status: 'pending' | 'approved' | 'rejected' | 'cancelled'; approver: string; comment?: string; actedAt?: string }
export interface OfferRecord { id: string; code: string; applicationId: string; status: OfferStatus; currentVersionId?: string; approval: OfferApprovalRecord; sentAt?: string; respondedAt?: string; expiresAt?: string; version: number; createdAt: string; updatedAt: string }
export interface OnboardingRecord { id: string; applicationId: string; offerId: string; plannedStartDate?: string; status: OnboardingStatus; notes?: string; archivedAt?: string; createdAt: string; updatedAt: string }
export interface InterviewParticipant { userId: string; name?: string; role: 'interviewer' | 'coordinator' | 'observer'; required: boolean }
export interface InterviewRecord { id: string; code: string; applicationId: string; round: number; type: InterviewType; title: string; status: InterviewStatus; scheduledStartAt?: string; scheduledEndAt?: string; timezone?: string; location?: string; meetingUrl?: string; participants: InterviewParticipant[]; createdAt: string; updatedAt: string }
export interface InterviewFeedbackRecord { id: string; interviewId: string; interviewerId: string; status: InterviewFeedbackStatus; overallScore?: number; recommendation?: 'strong_yes' | 'yes' | 'mixed' | 'no' | 'strong_no'; ratings: Record<string, number>; strengths: string[]; concerns: string[]; notes?: string; submittedAt?: string; lockedAt?: string }

export interface WorkflowEventRecord {
  id: string
  subjectType: 'recruitment_request' | 'job' | 'offer' | 'onboarding' | 'candidate' | 'application' | 'interview'
  subjectId: string
  action: string
  fromStatus?: string
  toStatus?: string
  actorId: string
  reason?: string
  createdAt: string
}

export interface RecruitingStoreState {
  recruitmentRequests: RecruitmentRequestRecord[]
  jobs: JobRecord[]
  candidates: CandidateRecord[]
  applications: ApplicationRecord[]
  resumes: ResumeRecord[]
  analysisTasks: AnalysisTaskRecord[]
  analysisResults: AnalysisResultRecord[]
  interviews: InterviewRecord[]
  interviewFeedback: InterviewFeedbackRecord[]
  jobSpecVersions: JobSpecVersionRecord[]
  jobDescriptionVersions: JobDescriptionVersionRecord[]
  offers: OfferRecord[]
  offerVersions: OfferVersionRecord[]
  onboarding: OnboardingRecord[]
  approvalInstances: ApprovalInstanceRecord[]
  approvalSteps: ApprovalStepRecord[]
  approvalRecords: ApprovalAuditRecord[]
  workflowEvents: WorkflowEventRecord[]
  candidateTags: string[]
  nextRequestNumber: number
  nextJobNumber: number
  nextCandidateNumber: number
  nextApplicationNumber: number
  nextInterviewNumber: number
  nextOfferNumber: number
}

