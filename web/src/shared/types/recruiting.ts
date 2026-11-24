export type Status = 'active'|'pending'|'approved'|'rejected'|'draft'|'scheduled'|'completed'|'sent'|'accepted'|'declined'|'published'|'paused'|'ready'|'closed'|'configured'|'disabled'|'pending_analysis'|'analysis_queued'|'human_review'|'interviewing'|'offer_approval'|'offer_sent'|'offer_accepted'|'onboarding_archived'|'offer_declined'|'offer_cancelled'|'offer_expired'|'interview'
export type JobStatus = 'draft'|'ready'|'published'|'paused'|'closed'
export interface JobSpecRequirement { label:string; description?:string; required?:boolean; weight?:number }
export interface JobSpec { version?:number; title?:string; summary?:string; responsibilities?:string[]; requirements?:JobSpecRequirement[]; skills?:string[]; confirmed:boolean; confirmedAt?:string }
export interface JobDescription { version?:number; language?:string; content?:string; generatedBy?:'human'|'ai_assisted'; confirmed:boolean; confirmedAt?:string }
export interface Metric { label:string; value:string|number; trend?:string; tone?:'teal'|'blue'|'amber'|'red' }
export interface Requisition { id:string; entityId?:string; title:string; department:string; headcount:number; budget:string; approver:string; status:Status|string; updatedAt:string }
export interface Job { id:string; entityId?:string; title:string; department:string; status:JobStatus|string; channels:string[]; updatedAt:string }
export interface JobDetail extends Job { recruitmentRequestId?:string; headcount?:number; filledCount?:number; employmentType?:string; workMode?:string; location?:string; spec?:JobSpec; jd?:JobDescription }
export interface ResumeScoreSummary {
  analysisEngine?: string
  modelName?: string
  scoringSkill?: { id: string; name: string; content: string; updatedAt: string }
  scoringExplanation?: string
  resultId: string
  aiScore?: number
  humanScore?: number
  finalScore?: number
  comment?: string
  decision?: 'passed' | 'eliminated'
  talentPool: boolean
  history: Array<{ humanScore: number; finalScore: number; comment: string; actorId: string; updatedAt: string }>
  evidence: Array<{ label: string; rationale: string; sourceTexts: string[]; score?: number; outcome: 'matched' | 'partial' | 'conflict' | 'missing' }>
  strengths: string[]
  risks: string[]
}
export interface CandidateInterviewProgress { id: string; round: number; stage: 'initial' | 'final'; status: 'scheduled' | 'completed'; scheduledStartAt?: string }
export interface Candidate { interviewProgress?: CandidateInterviewProgress; applicationRows?: Candidate[]; email?: string; phone?: string; applicationId?: string; rawApplicationStatus?: string; resumeReview?: ResumeScoreSummary; id:string; entityId?:string; name:string; job:string; score:number; scoreAvailable?:boolean; source?:string; company?:string; skills?:string[]; aiStatus:Status; analysisStatus?:Status|string; analysisProgress?:number; analysisAttempts?:number; analysisError?:string; applicationStatus:Status; updatedAt:string; updatedAtTimestamp?:string; tags?:string[] }
export interface Interview { id:string; candidate:string; job:string; round:string; scheduledAt:string; interviewers:string[]; feedbackStatus:Status }
export interface Offer { id:string; candidate:string; job:string; approvalStatus:Status; deliveryStatus:Status; response:Status; updatedAt:string }
export interface Report { label:string; value:string|number; detail:string }
export interface AdminCheck { category:string; owner:string; status:Status; detail:string }
export interface DemoRecruitingData { metrics:readonly Metric[]; requisitions:readonly Requisition[]; jobs:readonly Job[]; candidates:readonly Candidate[]; interviews:readonly Interview[]; offers:readonly Offer[]; reports:readonly Report[]; adminChecks:readonly AdminCheck[] }

