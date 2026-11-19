import type { EntityId, FileReference, ISODateTime, Money, VersionedDTO } from './common.js'
import { OfferApprovalStatus, OfferStatus } from './status.js'

export interface OfferDTO extends VersionedDTO {
  applicationId: EntityId
  status: OfferStatus
  currentVersionId?: EntityId
  approvalId?: EntityId
  sentAt?: ISODateTime
  respondedAt?: ISODateTime
  expiresAt?: ISODateTime
}

export interface OfferVersionDTO extends VersionedDTO {
  offerId: EntityId
  positionTitle: string
  departmentId: EntityId
  employmentType: 'full_time' | 'part_time' | 'contract' | 'internship'
  startDate?: string
  reportingLocation?: string
  invoiceTitle?: string
  taxNumber?: string
  templateFields?: { reportingTime?: string; reportingDate?: string; supervisorName?: string; supervisorTitle?: string; probationDuration?: string; probationSalaryMonths?: string; formalSalaryStartMonth?: string; payday?: string }
  compensation: {
    baseSalary: Money
    probationSalary?: Money
    bonus?: Money
    equity?: string
  }
  benefits?: string[]
  materials?: string[]
  content: string
  document?: FileReference
}

export interface OfferApprovalDTO extends VersionedDTO {
  offerId: EntityId
  status: OfferApprovalStatus
  approverIds: EntityId[]
  approvedBy?: EntityId[]
  rejectedBy?: EntityId
  comment?: string
  actedAt?: ISODateTime
}

export interface OnboardingRecordDTO extends VersionedDTO {
  applicationId: EntityId
  offerId: EntityId
  employeeId?: EntityId
  plannedStartDate?: string
  plannedStartTime?: string
  reportingMode?: 'onsite' | 'remote' | 'hybrid'
  reportingLocation?: string
  reportingContactName?: string
  reportingContactPhone?: string
  hrOwnerName?: string
  hiringManagerName?: string
  workCity?: string
  officeLocation?: string
  riskNotes?: string
  cancellationReasonCode?: 'candidate_declined' | 'offer_revoked' | 'schedule_changed' | 'position_closed' | 'failed_requirements' | 'other'
  cancellationNotes?: string
  cancelledAt?: ISODateTime
  noShowReasonCode?: 'candidate_unreachable' | 'personal_reason' | 'another_offer' | 'document_issue' | 'attendance_issue' | 'other'
  noShowNotes?: string
  noShowAt?: ISODateTime
  actualArrivalAt?: ISODateTime
  status: 'pending' | 'preparing' | 'scheduled' | 'completed' | 'no_show' | 'cancelled'
  notes?: string
  archivedAt?: ISODateTime
}

export interface OnboardingTaskDTO extends VersionedDTO {
  onboardingId: EntityId
  title: string
  category: 'hr' | 'it' | 'admin' | 'manager' | 'training' | 'candidate'
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'not_required'
  isRequired: boolean
  ownerRole?: 'recruiter' | 'hiring_manager' | 'admin' | 'hr_admin' | 'candidate'
  templateKey?: string
  ownerName?: string
  dueDate?: string
  notes?: string
  blockedReason?: string
  completedAt?: ISODateTime
}

export interface OnboardingMaterialDTO extends VersionedDTO {
  onboardingId: EntityId
  code: string
  label: string
  status: 'pending' | 'collected' | 'verified' | 'waived'
  isRequired: boolean
  collectedAt?: ISODateTime
  verifiedAt?: ISODateTime
  verifiedByUserId?: EntityId
  waivedAt?: ISODateTime
  notes?: string
}

export interface OnboardingReminderDTO extends VersionedDTO {
  onboardingId: EntityId
  milestone: '7_days' | '3_days' | 'day_of'
  audience: 'candidate' | 'hr' | 'manager' | 'it' | 'admin'
  channel: 'in_app' | 'email'
  status: 'scheduled' | 'sent' | 'failed' | 'skipped'
  scheduledAt: ISODateTime
  sentAt?: ISODateTime
  failedAt?: ISODateTime
  failureReason?: string
}

export interface OnboardingIntegrationDTO extends VersionedDTO {
  onboardingId: EntityId
  provider: 'oa' | 'it_service_desk' | 'access_control' | 'email_account' | 'hris'
  status: 'not_configured' | 'pending' | 'syncing' | 'ready' | 'failed'
  externalReference?: string
  lastAttemptAt?: ISODateTime
  lastSuccessAt?: ISODateTime
  lastError?: string
}

