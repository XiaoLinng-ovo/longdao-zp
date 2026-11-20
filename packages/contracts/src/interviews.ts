import type { BaseDTO, EntityId, ISODateTime, VersionedDTO } from './common.js'
import { InterviewFeedbackStatus, InterviewStatus } from './status.js'

export type InterviewType = 'phone_screen' | 'technical' | 'behavioral' | 'case_study' | 'onsite' | 'other'

export interface InterviewParticipant {
  userId: EntityId
  role: 'interviewer' | 'coordinator' | 'observer'
  required: boolean
}

export interface ScorecardCriterion {
  id: EntityId
  name: string
  description?: string
  weight?: number
  scaleMin: number
  scaleMax: number
}

export interface ScorecardVersionDTO extends VersionedDTO {
  name: string
  criteria: ScorecardCriterion[]
}

export interface InterviewDTO extends VersionedDTO {
  applicationId: EntityId
  round: number
  type: InterviewType
  title: string
  status: InterviewStatus
  scheduledStartAt?: ISODateTime
  scheduledEndAt?: ISODateTime
  timezone?: string
  location?: string
  meetingUrl?: string
  participants: InterviewParticipant[]
  scorecardVersionId?: EntityId
}

export interface InterviewFeedbackDTO extends VersionedDTO {
  interviewId: EntityId
  interviewerId: EntityId
  status: InterviewFeedbackStatus
  overallScore?: number
  recommendation?: 'strong_yes' | 'yes' | 'mixed' | 'no' | 'strong_no'
  ratings: Record<EntityId, number>
  strengths?: string[]
  concerns?: string[]
  notes?: string
  submittedAt?: ISODateTime
  lockedAt?: ISODateTime
}

export interface InterviewTimelineDTO extends BaseDTO {
  applicationId: EntityId
  interviews: InterviewDTO[]
  feedback: InterviewFeedbackDTO[]
}

