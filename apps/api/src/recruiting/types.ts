export type RecruitmentRequestStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'withdrawn' | 'converted' | 'closed' | 'cancelled'
export type JobStatus = 'draft' | 'ready' | 'published' | 'paused' | 'closed'
export type CandidateStatus = 'active' | 'archived' | 'do_not_contact'
export type ApplicationStatus = 'pending_analysis' | 'analysis_queued' | 'human_review' | 'interviewing' | 'offer_approval' | 'offer_sent' | 'offer_accepted' | 'onboarding_archived' | 'rejected' | 'offer_declined' | 'offer_cancelled' | 'offer_expired'
export type ResumeScanStatus = 'quarantined' | 'local_unscanned' | 'clean' | 'infected' | 'failed'
export type AnalysisTaskStatus = 'queued' | 'processing' | 'completed' | 'failed'
export type OfferStatus = 'draft' | 'pending_approval' | 'approved' | 'sent' | 'accepted' | 'declined' | 'cancelled' | 'expired'
export type OnboardingStatus = 'pending' | 'preparing' | 'scheduled' | 'completed' | 'no_show' | 'cancelled'
export type OnboardingTaskCategory = 'hr' | 'it' | 'admin' | 'manager' | 'training' | 'candidate'
export type OnboardingTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'not_required'
export type OnboardingTaskOwnerRole = 'recruiter' | 'hiring_manager' | 'admin' | 'hr_admin' | 'candidate'
export type OnboardingCancellationReason = 'candidate_declined' | 'offer_revoked' | 'schedule_changed' | 'position_closed' | 'failed_requirements' | 'other'
export type OnboardingNoShowReason = 'candidate_unreachable' | 'personal_reason' | 'another_offer' | 'document_issue' | 'attendance_issue' | 'other'
export type OnboardingMaterialStatus = 'pending' | 'collected' | 'verified' | 'waived'
export type OnboardingReminderMilestone = '7_days' | '3_days' | 'day_of'
export type OnboardingReminderAudience = 'candidate' | 'hr' | 'manager' | 'it' | 'admin'
export type OnboardingReminderChannel = 'in_app' | 'email'
export type OnboardingReminderStatus = 'scheduled' | 'sent' | 'failed' | 'skipped'
export type OnboardingIntegrationProvider = 'oa' | 'it_service_desk' | 'access_control' | 'email_account' | 'hris'
export type OnboardingIntegrationStatus = 'not_configured' | 'pending' | 'syncing' | 'ready' | 'failed'
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
  requesterName?: string
  requesterEmail?: string
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
  provider?: string
  externalInstanceId?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface ApprovalStepRecord {
  id: string
  instanceId: string
  order: number
  name: string
  approverRole: string
  externalStepId?: string
  nodeName?: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  actedAt?: string
}

export interface ApprovalAuditRecord {
  id: string
  instanceId: string
  stepId: string
  actorId: string
  approver?: string
  action: 'approve' | 'reject' | 'progress'
  comment?: string
  createdAt: string
}

export interface ApprovalRecord {
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approver: string
  provider?: string
  externalInstanceId?: string
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
  generatedBy?: 'ai' | 'local_fallback' | 'human'
  confirmed: boolean
  confirmedAt?: string
}

export interface JobDescriptionRecord {
  version: number
  language: string
  content: string
  generatedBy: 'human' | 'ai_assisted' | 'local_fallback'
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
  nameManuallyEdited?: boolean
  email?: string
  phone?: string
  source?: string
  tags?: string[]
  status: CandidateStatus
  createdAt: string
  updatedAt: string
}

export interface ApplicationRecord {
  interviewProgress?: { id: string; round: number; stage: 'initial' | 'final'; status: 'scheduled' | 'completed'; scheduledStartAt?: string }
  analysisStatus?: AnalysisTaskStatus
  analysisProgress?: number
  analysisAttempts?: number
  analysisError?: string
  resumeReview?: import('./resume-scoring.js').ResumeScoreSummary
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

export interface OfferVersionRecord { id: string; offerId: string; version: number; positionTitle: string; departmentId: string; employmentType: string; startDate?: string; reportingLocation?: string; invoiceTitle?: string; taxNumber?: string; templateFields?: import('./offer-template-fields.js').OfferTemplateFields; compensation: { baseSalary: { amount: number; currency: string }; probationSalary?: { amount: number; currency: string }; bonus?: { amount: number; currency: string }; equity?: string }; benefits: string[]; materials: string[]; content: string; createdAt: string }
export interface OfferApprovalRecord { status: 'pending' | 'approved' | 'rejected' | 'cancelled'; approver: string; comment?: string; actedAt?: string }
export interface OfferRecord { id: string; code: string; applicationId: string; status: OfferStatus; currentVersionId?: string; approval: OfferApprovalRecord; sentAt?: string; respondedAt?: string; expiresAt?: string; version: number; createdAt: string; updatedAt: string }
export interface OnboardingRecord {
  id: string; applicationId: string; offerId: string; plannedStartDate?: string; plannedStartTime?: string
  reportingMode?: 'onsite' | 'remote' | 'hybrid'; reportingLocation?: string; reportingContactName?: string; reportingContactPhone?: string
  workCity?: string; officeLocation?: string; hrOwnerName?: string; hiringManagerName?: string; riskNotes?: string
  cancellationReasonCode?: OnboardingCancellationReason; cancellationNotes?: string; cancelledAt?: string
  noShowReasonCode?: OnboardingNoShowReason; noShowNotes?: string; noShowAt?: string
  actualArrivalAt?: string
  status: OnboardingStatus; notes?: string; archivedAt?: string; createdAt: string; updatedAt: string
}
export interface OnboardingTaskRecord {
  id: string; onboardingId: string; title: string; category: OnboardingTaskCategory; status: OnboardingTaskStatus
  isRequired: boolean; ownerRole?: OnboardingTaskOwnerRole; templateKey?: string
  ownerName?: string; dueDate?: string; notes?: string; blockedReason?: string; completedAt?: string; createdAt: string; updatedAt: string
}
export interface OnboardingMaterialRecord {
  id: string; onboardingId: string; code: string; label: string; status: OnboardingMaterialStatus; isRequired: boolean
  collectedAt?: string; verifiedAt?: string; verifiedByUserId?: string; waivedAt?: string; notes?: string; createdAt: string; updatedAt: string
}
export interface OnboardingReminderRecord {
  id: string; onboardingId: string; milestone: OnboardingReminderMilestone; audience: OnboardingReminderAudience
  channel: OnboardingReminderChannel; status: OnboardingReminderStatus; scheduledAt: string
  sentAt?: string; failedAt?: string; failureReason?: string; createdAt: string; updatedAt: string
}
export interface OnboardingIntegrationRecord {
  id: string; onboardingId: string; provider: OnboardingIntegrationProvider; status: OnboardingIntegrationStatus
  externalReference?: string; lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string; createdAt: string; updatedAt: string
}
export interface OnboardingWorkbenchItem {
  onboarding: OnboardingRecord; tasks: OnboardingTaskRecord[]; materials: OnboardingMaterialRecord[]
  reminders: OnboardingReminderRecord[]; integrations: OnboardingIntegrationRecord[]
  candidateName: string; jobTitle: string; offerCode: string; department: string
  readiness: number; requiredTasksRemaining: number; overdueTasks: number; nextDueDate?: string; highRiskReasons: string[]
}
export interface OnboardingReport {
  totals: Record<OnboardingStatus, number> & { all: number }
  arrivalRate: number | null
  averagePreparationDays: number | null
  medianPreparationDays: number | null
  requiredTaskOnTimeRate: number | null
  overdueTasks: number
  blockedTasks: number
  reasonDistribution: Array<{ code: string; label: string; count: number }>
  integrationStatus: Record<OnboardingIntegrationStatus, number>
  highRiskItems: Array<{ onboardingId: string; applicationId: string; candidateName: string; jobTitle: string; plannedStartDate?: string; reasons: string[] }>
}
export interface InterviewParticipant { userId: string; name?: string; role: 'interviewer' | 'coordinator' | 'observer'; required: boolean }
export interface InterviewRecord { id: string; code: string; applicationId: string; round: number; stage?: 'initial' | 'final'; type: InterviewType; title: string; status: InterviewStatus; scheduledStartAt?: string; scheduledEndAt?: string; timezone?: string; location?: string; meetingUrl?: string; participants: InterviewParticipant[]; createdAt: string; updatedAt: string }
export interface InterviewFeedbackRecord { id: string; interviewId: string; interviewerId: string; status: InterviewFeedbackStatus; overallScore?: number; recommendation?: 'strong_yes' | 'yes' | 'mixed' | 'no' | 'strong_no'; ratings: Record<string, number>; strengths: string[]; concerns: string[]; notes?: string; submittedAt?: string; lockedAt?: string }

export interface WorkflowEventRecord {
  metadata?: Record<string, unknown>
  id: string
  subjectType: 'recruitment_request' | 'job' | 'offer' | 'onboarding' | 'candidate' | 'application' | 'interview'
  subjectId: string
  action: string
  fromStatus?: string
  toStatus?: string
  actorId: string
  actorName?: string
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
  onboardingTasks: OnboardingTaskRecord[]
  onboardingMaterials: OnboardingMaterialRecord[]
  onboardingReminders: OnboardingReminderRecord[]
  onboardingIntegrations: OnboardingIntegrationRecord[]
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

