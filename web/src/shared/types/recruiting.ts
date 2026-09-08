export type Status = 'active'|'pending'|'approved'|'rejected'|'draft'|'scheduled'|'completed'|'sent'|'accepted'|'declined'|'published'|'paused'|'configured'|'disabled'
export interface Metric { label:string; value:string|number; trend?:string; tone?:'teal'|'blue'|'amber'|'red' }
export interface Requisition { id:string; title:string; department:string; headcount:number; budget:string; approver:string; status:Status; updatedAt:string }
export interface Job { id:string; title:string; department:string; status:Status; channels:string[]; updatedAt:string }
export interface Candidate { id:string; name:string; job:string; score:number; aiStatus:Status; applicationStatus:Status; updatedAt:string }
export interface Interview { id:string; candidate:string; job:string; round:string; scheduledAt:string; interviewers:string[]; feedbackStatus:Status }
export interface Offer { id:string; candidate:string; job:string; approvalStatus:Status; deliveryStatus:Status; response:Status; updatedAt:string }
export interface Report { label:string; value:string|number; detail:string }
export interface AdminCheck { category:string; owner:string; status:Status; detail:string }
export interface DemoRecruitingData { metrics:readonly Metric[]; requisitions:readonly Requisition[]; jobs:readonly Job[]; candidates:readonly Candidate[]; interviews:readonly Interview[]; offers:readonly Offer[]; reports:readonly Report[]; adminChecks:readonly AdminCheck[] }
