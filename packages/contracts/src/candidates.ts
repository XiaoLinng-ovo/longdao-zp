import type { BaseDTO, EntityId, FileReference, ISODateTime, VersionedDTO } from './common.js'
import {
  AnalysisResultStatus,
  AnalysisTaskStatus,
  AnalysisTaskType,
  ApplicationStatus,
  CandidateStatus,
  HumanReviewStatus,
  ResumeStatus,
  Recommendation,
  VirusScanStatus,
} from './status.js'

export interface CandidateDTO extends VersionedDTO {
  fullName: string
  email?: string
  phone?: string
  location?: string
  source?: string
  status: CandidateStatus
  consentStatus: 'unknown' | 'pending' | 'granted' | 'withdrawn'
}

export interface ApplicationDTO extends VersionedDTO {
  candidateId: EntityId
  jobId: EntityId
  status: ApplicationStatus
  source?: string
  recruiterId?: EntityId
  appliedAt: ISODateTime
  resumeId?: EntityId
  rejectionReason?: string
  withdrawnAt?: ISODateTime
}

export interface ResumeDTO extends VersionedDTO {
  candidateId: EntityId
  /** Optional because a resume may be reused across applications. */
  applicationId?: EntityId
  file: FileReference
  status: ResumeStatus
  virusScanStatus: VirusScanStatus
  quarantinedAt?: ISODateTime
  scannedAt?: ISODateTime
  extractedTextHash?: string
}

export interface AnalysisTaskDTO extends VersionedDTO {
  resumeId: EntityId
  applicationId: EntityId
  type: AnalysisTaskType
  status: AnalysisTaskStatus
  attempt: number
  maxAttempts: number
  queuedAt: ISODateTime
  startedAt?: ISODateTime
  finishedAt?: ISODateTime
  lastErrorCode?: string
  lastErrorMessage?: string
  idempotencyKey: string
}

export interface EvidenceItem {
  id: EntityId
  requirementId?: EntityId
  sourceText: string
  normalizedValue?: string
  relevance: 'supporting' | 'conflicting' | 'neutral'
  confidence: number
}

export interface ResumeProfile {
  headline?: string
  summary?: string
  totalExperienceYears?: number
  locations?: string[]
}

export interface EducationItem {
  institution?: string
  degree?: string
  fieldOfStudy?: string
  startDate?: string
  endDate?: string
}

export interface ExperienceItem {
  employer?: string
  title?: string
  startDate?: string
  endDate?: string
  description?: string
  skills?: string[]
}

export interface ResumeExtraction {
  profile: ResumeProfile
  education: EducationItem[]
  experience: ExperienceItem[]
  skills: string[]
  languages?: string[]
  certifications?: string[]
  evidence: EvidenceItem[]
  warnings: string[]
}

export interface MatchDimensions {
  hardRequirement: number
  experience: number
  skills: number
  education?: number
  potential?: number
}

export interface MatchAssessment {
  score: number
  recommendation: Recommendation
  dimensions: MatchDimensions
  matchedRequirements: EvidenceItem[]
  conflicts: EvidenceItem[]
  strengths: string[]
  risks: string[]
  interviewQuestions: string[]
  confidence: number
}

export interface AnalysisResultDTO extends VersionedDTO {
  taskId: EntityId
  resumeId: EntityId
  applicationId: EntityId
  status: AnalysisResultStatus
  extraction: ResumeExtraction
  assessment: MatchAssessment
  modelProvider: string
  modelName: string
  promptVersion: string
  parserVersion: string
  analyzerVersion: string
  inputHash: string
  humanReviewStatus: HumanReviewStatus
  humanReviewedBy?: EntityId
  humanReviewedAt?: ISODateTime
  humanReviewComment?: string
}


