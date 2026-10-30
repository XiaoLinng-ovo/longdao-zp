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
  compensation: {
    baseSalary: Money
    bonus?: Money
    equity?: string
  }
  benefits?: string[]
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
  status: 'pending' | 'scheduled' | 'completed' | 'cancelled'
  notes?: string
}

