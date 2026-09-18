import { apiClient } from '../../../shared/api'
import type { Interview } from '../../../shared/types/recruiting'

export type InterviewType = 'phone_screen' | 'technical' | 'behavioral' | 'case_study' | 'onsite' | 'other'
export type FeedbackRecommendation = 'strong_yes' | 'yes' | 'mixed' | 'no' | 'strong_no'

export interface ApiInterview {
  id: string
  code: string
  applicationId: string
  round: number
  type: InterviewType
  title: string
  status: 'scheduled' | 'completed' | 'cancelled'
  scheduledStartAt?: string
  scheduledEndAt?: string
  timezone?: string
  location?: string
  meetingUrl?: string
  participants: Array<{ userId: string; name?: string; role: 'interviewer' | 'coordinator' | 'observer'; required: boolean }>
  feedbackStatus: 'draft' | 'submitted' | 'locked' | 'pending'
  application: { id: string; code: string; candidateId: string; jobId: string; status: string }
  createdAt: string
  updatedAt: string
}

export interface ApiCandidate { id: string; code: string; fullName: string }
export interface ApiJob { id: string; title: string }
export interface ApiApplication { id: string; code: string; candidateId: string; jobId: string; status: string; candidateName?: string; jobTitle?: string }

export interface CreateInterviewInput {
  applicationId: string
  round?: number
  type?: InterviewType
  title: string
  scheduledStartAt?: string
  scheduledEndAt?: string
  timezone?: string
  location?: string
  meetingUrl?: string
  participants: Array<{ userId: string; name?: string; role?: 'interviewer' | 'coordinator' | 'observer'; required?: boolean }>
}

export interface SubmitFeedbackInput {
  interviewerId: string
  overallScore?: number
  recommendation?: FeedbackRecommendation
  ratings?: Record<string, number>
  strengths?: string[]
  concerns?: string[]
  notes?: string
}

export interface InterviewView {
  id: string
  entityId: string
  candidate: string
  job: string
  round: string
  scheduledAt: string
  interviewers: string[]
  feedbackStatus: Interview['feedbackStatus']
  status: string
  applicationId: string
}

export const INTERVIEW_TYPE_LABEL: Record<InterviewType, string> = {
  phone_screen: '电话初筛',
  technical: '技术面试',
  behavioral: '行为面试',
  case_study: '案例分析',
  onsite: '现场面试',
  other: '其他',
}

export const RECOMMENDATION_LABEL: Record<FeedbackRecommendation, string> = {
  strong_yes: '强烈推荐录用',
  yes: '推荐录用',
  mixed: '待定',
  no: '不推荐',
  strong_no: '强烈不推荐',
}

function toViewModel(row: ApiInterview, candidates: Map<string, string>, jobs: Map<string, string>): InterviewView {
  const app = row.application
  return {
    id: row.code || row.id,
    entityId: row.id,
    candidate: candidates.get(app.candidateId) || app.candidateId,
    job: jobs.get(app.jobId) || app.jobId,
    round: `${row.round} 轮`,
    scheduledAt: row.scheduledStartAt ? new Date(row.scheduledStartAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '待安排',
    interviewers: row.participants.map((p) => p.name || p.userId),
    feedbackStatus: (row.feedbackStatus === 'locked' || row.status === 'completed' ? 'completed' : row.feedbackStatus === 'submitted' ? 'submitted' : 'scheduled') as Interview['feedbackStatus'],
    status: row.status,
    applicationId: row.applicationId,
  }
}

export async function loadInterviews(): Promise<InterviewView[]> {
  const [interviewsRes, candidatesRes, jobsRes] = await Promise.all([
    apiClient.getJson<ApiInterview[]>('/interviews'),
    apiClient.getJson<ApiCandidate[]>('/candidates'),
    apiClient.getJson<ApiJob[]>('/jobs'),
  ])
  const candidates = new Map(candidatesRes.data.map((c) => [c.id, c.fullName]))
  const jobs = new Map(jobsRes.data.map((j) => [j.id, j.title]))
  return interviewsRes.data.map((row) => toViewModel(row, candidates, jobs))
}

export async function loadApplicationsForSchedule(): Promise<ApiApplication[]> {
  const [applicationResponse, candidateResponse, jobResponse] = await Promise.all([
    apiClient.getJson<ApiApplication[]>('/applications'),
    apiClient.getJson<ApiCandidate[]>('/candidates'),
    apiClient.getJson<ApiJob[]>('/jobs'),
  ])
  const candidateMap = new Map(candidateResponse.data.map((candidate) => [candidate.id, candidate]))
  const jobMap = new Map(jobResponse.data.map((job) => [job.id, job]))
  return applicationResponse.data.map((application) => ({
    ...application,
    candidateName: candidateMap.get(application.candidateId)?.fullName || candidateMap.get(application.candidateId)?.code,
    jobTitle: jobMap.get(application.jobId)?.title || jobMap.get(application.jobId)?.id || application.jobId,
  }))
}

export interface ApiInterviewDetail extends ApiInterview {
  feedback: Array<{
    id: string
    interviewId: string
    interviewerId: string
    status: 'draft' | 'submitted' | 'locked'
    overallScore?: number
    recommendation?: FeedbackRecommendation
    ratings: Record<string, number>
    strengths: string[]
    concerns: string[]
    notes?: string
    submittedAt?: string
    lockedAt?: string
  }>
}

export async function getInterview(id: string): Promise<ApiInterviewDetail> {
  return (await apiClient.getJson<ApiInterviewDetail>(`/interviews/${id}`)).data
}

export async function createInterview(input: CreateInterviewInput): Promise<ApiInterview> {
  return (await apiClient.postJson<ApiInterview>('/interviews', input)).data
}

export async function submitFeedback(id: string, input: SubmitFeedbackInput): Promise<unknown> {
  return (await apiClient.postJson(`/interviews/${id}/feedback`, input)).data
}

export async function lockFeedback(id: string, interviewerId: string): Promise<unknown> {
  return (await apiClient.postJson(`/interviews/${id}/lock-feedback`, { interviewerId })).data
}

export async function concludeInterview(id: string, outcome: 'continue' | 'offer' | 'reject'): Promise<unknown> {
  return (await apiClient.postJson(`/interviews/${id}/conclude`, { outcome })).data
}

export interface LiveInterviewSegment { id: string; sessionId: string; speakerId: string; role: 'interviewer' | 'candidate' | 'unknown'; confidence: number; text: string; startMs: number; endMs: number; status: string }
export interface LiveInterviewSession { id: string; interviewId: string; status: string; externalStatus: string; startedAt: string; endedAt?: string; createdBy: string }
export interface LiveInterviewView { session: LiveInterviewSession; segments: LiveInterviewSegment[] }
export async function createLiveInterviewSession(interviewId: string): Promise<LiveInterviewSession> { return (await apiClient.postJson<LiveInterviewSession>(`/interviews/${interviewId}/live-sessions`, {})).data }
export async function loadLiveInterviewSession(sessionId: string): Promise<LiveInterviewView> { return (await apiClient.getJson<LiveInterviewView>(`/interview-live-sessions/${sessionId}`)).data }
export async function uploadLiveInterviewChunk(sessionId: string, audioBase64: string, contentType: string): Promise<LiveInterviewSegment[]> { return (await apiClient.postJson<LiveInterviewSegment[]>(`/interview-live-sessions/${sessionId}/segments`, { audioBase64, contentType })).data }
export async function endLiveInterviewSession(sessionId: string): Promise<LiveInterviewSession> { return (await apiClient.postJson<LiveInterviewSession>(`/interview-live-sessions/${sessionId}/end`, {})).data }
export async function correctLiveSegmentRole(segmentId: string, role: 'interviewer' | 'candidate'): Promise<LiveInterviewSegment> { return (await apiClient.postJson<LiveInterviewSegment>(`/interview-live-segments/${segmentId}/role`, { role })).data }
export interface LiveAnswerAnalysis { summary: string; evidence: string[]; scores: Array<{ dimension: string; score: number; rationale: string }>; concerns: string[]; confidence: number; nextQuestion: string; advisoryOnly: true; applicationStatusMutation: 'none' }
export async function analyzeLiveSegment(segmentId: string, question: string): Promise<LiveAnswerAnalysis> { return (await apiClient.postJson<LiveAnswerAnalysis>(`/interview-live-segments/${segmentId}/analyze`, { question, priorContext: [] })).data }
