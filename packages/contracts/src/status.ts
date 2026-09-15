export enum RecruitmentRequestStatus {
  Draft = 'draft',
  PendingApproval = 'pending_approval',
  Approved = 'approved',
  Rejected = 'rejected',
  Withdrawn = 'withdrawn',
  Closed = 'closed',
  Converted = 'converted',
  Cancelled = 'cancelled',
}

export enum ApprovalStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
  Cancelled = 'cancelled',
}

export enum ApprovalStepStatus {
  Pending = 'pending',
  Active = 'active',
  Approved = 'approved',
  Rejected = 'rejected',
  Skipped = 'skipped',
}

export enum JobStatus {
  Draft = 'draft',
  Ready = 'ready',
  Published = 'published',
  Paused = 'paused',
  Closed = 'closed',
}

export enum CandidateStatus {
  Active = 'active',
  Archived = 'archived',
  DoNotContact = 'do_not_contact',
}

export enum ApplicationStatus {
  New = 'new',
  Screening = 'screening',
  Shortlisted = 'shortlisted',
  Interview = 'interview',
  Offer = 'offer',
  Hired = 'hired',
  Rejected = 'rejected',
  Withdrawn = 'withdrawn',
}

export enum ResumeStatus {
  Quarantined = 'quarantined',
  Scanning = 'scanning',
  Clean = 'clean',
  Rejected = 'rejected',
  Deleted = 'deleted',
}

export enum VirusScanStatus {
  Pending = 'pending',
  Clean = 'clean',
  Infected = 'infected',
  Failed = 'failed',
}

export enum AnalysisTaskStatus {
  Queued = 'queued',
  Running = 'running',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum AnalysisTaskType {
  ResumeAnalysis = 'resume_analysis',
  ResumeReanalysis = 'resume_reanalysis',
}

export enum AnalysisResultStatus {
  Draft = 'draft',
  Ready = 'ready',
  Superseded = 'superseded',
  Invalid = 'invalid',
}

export enum HumanReviewStatus {
  NotRequired = 'not_required',
  Pending = 'pending',
  InProgress = 'in_progress',
  Accepted = 'accepted',
  NeedsCorrection = 'needs_correction',
}

export enum InterviewStatus {
  Planned = 'planned',
  Scheduled = 'scheduled',
  FeedbackPending = 'feedback_pending',
  Completed = 'completed',
  Cancelled = 'cancelled',
}

export enum InterviewFeedbackStatus {
  Draft = 'draft',
  Submitted = 'submitted',
  Locked = 'locked',
  CorrectionRequested = 'correction_requested',
}

export enum OfferStatus {
  Draft = 'draft',
  PendingApproval = 'pending_approval',
  Approved = 'approved',
  Sent = 'sent',
  Accepted = 'accepted',
  Declined = 'declined',
  Expired = 'expired',
  Cancelled = 'cancelled',
}

export enum OfferApprovalStatus {
  Pending = 'pending',
  Approved = 'approved',
  Rejected = 'rejected',
  Cancelled = 'cancelled',
}

export enum Recommendation {
  StrongMatch = 'strong_match',
  Match = 'match',
  NeedsReview = 'needs_review',
  WeakMatch = 'weak_match',
}

