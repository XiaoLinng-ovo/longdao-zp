import type { BaseDTO, EntityId, ISODateTime, Money, VersionedDTO } from './common.js'
import { ApprovalStatus, ApprovalStepStatus, RecruitmentRequestStatus, JobStatus } from './status.js'

export type EmploymentType = 'full_time' | 'part_time' | 'contract' | 'internship'
export type WorkMode = 'onsite' | 'hybrid' | 'remote'

export interface RecruitmentRequestDTO extends VersionedDTO {
  code: string
  title: string
  departmentId: EntityId
  requesterId: EntityId
  hiringManagerId?: EntityId
  headcount: number
  employmentType: EmploymentType
  workMode: WorkMode
  location?: string
  salaryRange?: { min?: Money; max?: Money }
  justification: string
  status: RecruitmentRequestStatus
  approvalId?: EntityId
  convertedJobIds?: EntityId[]
}

export type ApprovalSubjectType = 'recruitment_request' | 'offer' | 'other'

export interface ApprovalDTO extends VersionedDTO {
  subjectType: ApprovalSubjectType
  subjectId: EntityId
  status: ApprovalStatus
  currentStepOrder?: number
  steps: ApprovalStepDTO[]
  records: ApprovalRecordDTO[]
}

export interface ApprovalStepDTO extends BaseDTO {
  approvalId: EntityId
  order: number
  name: string
  approverId: EntityId
  status: ApprovalStepStatus
  actedAt?: ISODateTime
  actedBy?: EntityId
}

export interface ApprovalRecordDTO extends BaseDTO {
  approvalId: EntityId
  stepId: EntityId
  action: 'approve' | 'reject' | 'skip' | 'cancel'
  actorId: EntityId
  comment?: string
  actedAt: ISODateTime
}

export interface JobDTO extends VersionedDTO {
  code: string
  title: string
  departmentId: EntityId
  hiringManagerId?: EntityId
  recruitmentRequestId?: EntityId
  headcount: number
  filledCount: number
  employmentType: EmploymentType
  workMode: WorkMode
  location?: string
  status: JobStatus
  currentSpecVersionId?: EntityId
  currentDescriptionVersionId?: EntityId
}

export interface JobRequirement {
  id: EntityId
  label: string
  description: string
  required: boolean
  weight?: number
}

export interface JobSpecVersionDTO extends VersionedDTO {
  jobId: EntityId
  title: string
  summary: string
  responsibilities: string[]
  requirements: JobRequirement[]
  skills: string[]
  education?: string[]
  experienceYears?: { min?: number; max?: number }
}

export interface JobDescriptionVersionDTO extends VersionedDTO {
  jobId: EntityId
  language: string
  content: string
  generatedBy?: 'human' | 'ai_assisted'
  approvedBy?: EntityId
  approvedAt?: ISODateTime
}


