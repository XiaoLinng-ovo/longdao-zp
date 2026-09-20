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
export interface ApiJob { id: string; code: string; title: string }
export interface ApiApplication { id: string; code?: string; candidateId: string; jobId: string; status: string; candidateName?: string; jobTitle?: string }
export interface ScheduleCandidate { id: string; code: string; fullName: string; email?: string }
export interface ScheduleJob { id: string; code: string; title: string }
export interface InterviewScheduleData { candidates: ScheduleCandidate[]; jobs: ScheduleJob[]; applications: ApiApplication[] }

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
  interviewerIds: string[]
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

export const PARTICIPANT_ROLE_LABEL: Record<string, string> = {
  interviewer: '面试官',
  coordinator: '协调人',
  observer: '观察员',
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
    interviewerIds: row.participants.filter((p) => p.role === 'interviewer').map((p) => p.userId),
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

export async function loadInterviewScheduleData(): Promise<InterviewScheduleData> {
  const [applicationResponse, candidateResponse, jobResponse] = await Promise.all([
    apiClient.getJson<ApiApplication[]>('/applications'),
    apiClient.getJson<ApiCandidate[]>('/candidates'),
    apiClient.getJson<ApiJob[]>('/jobs'),
  ])
  return {
    candidates: candidateResponse.data.map((candidate) => ({ id: candidate.id, code: candidate.code, fullName: candidate.fullName })),
    jobs: jobResponse.data.map((job) => ({ id: job.id, code: job.code, title: job.title })),
    applications: applicationResponse.data,
  }
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

export interface GeneratedInterviewQuestion {
  category: 'technical' | 'behavioral' | 'experience' | 'job_specific'
  difficulty: 'easy' | 'medium' | 'hard'
  question: string
  rationale: string
  groundedIn: string[]
  scoringRubric: Array<{ criterion: string; points: number }>
}

export interface InterviewQuestionSet {
  questions: GeneratedInterviewQuestion[]
  engine: 'llm' | 'local_fallback'
  advisoryOnly: true
  applicationStatusMutation: 'none'
}

export async function generateInterviewQuestions(id: string, questionCount = 5): Promise<InterviewQuestionSet> {
  return (await apiClient.postJson<InterviewQuestionSet>(`/interviews/${id}/questions`, { questionCount })).data
}

export interface LiveAnswerAnalysis { summary: string; evidence: string[]; scores: Array<{ dimension: string; score: number; rationale: string }>; concerns: string[]; confidence: number; nextQuestion: string; advisoryOnly: true; applicationStatusMutation: 'none' }
export interface LiveInterviewSegment { id: string; sessionId: string; speakerId: string; role: 'interviewer' | 'candidate' | 'unknown'; confidence: number; text: string; startMs: number; endMs: number; status: string; analysis?: LiveAnswerAnalysis }
export interface LiveInterviewSession { id: string; interviewId: string; status: string; externalStatus: string; startedAt: string; endedAt?: string; createdBy: string; currentQuestion: string }
export interface LiveInterviewView { session: LiveInterviewSession; segments: LiveInterviewSegment[] }
export async function createLiveInterviewSession(interviewId: string): Promise<LiveInterviewSession> { return (await apiClient.postJson<LiveInterviewSession>(`/interviews/${interviewId}/live-sessions`, {})).data }
export async function findActiveLiveInterviewSession(interviewId: string): Promise<LiveInterviewView | null> { return (await apiClient.getJson<LiveInterviewView | null>(`/interviews/${interviewId}/live-sessions`)).data }
export async function loadLiveInterviewSession(sessionId: string): Promise<LiveInterviewView> { return (await apiClient.getJson<LiveInterviewView>(`/interview-live-sessions/${sessionId}`)).data }
export async function uploadLiveInterviewChunk(sessionId: string, audioBase64: string, contentType: string, chunkOffsetMs: number): Promise<LiveInterviewSegment[]> { return (await apiClient.postJson<LiveInterviewSegment[]>(`/interview-live-sessions/${sessionId}/segments`, { audioBase64, contentType, chunkOffsetMs })).data }
export async function addManualLiveSegment(sessionId: string, text: string, role: 'candidate' | 'interviewer', startMs: number, endMs: number): Promise<LiveInterviewSegment> { return (await apiClient.postJson<LiveInterviewSegment[]>(`/interview-live-sessions/${sessionId}/segments`, { text, role, startMs, endMs })).data[0]! }
export async function endLiveInterviewSession(sessionId: string): Promise<LiveInterviewSession> { return (await apiClient.postJson<LiveInterviewSession>(`/interview-live-sessions/${sessionId}/end`, {})).data }
export async function updateLiveInterviewQuestion(sessionId: string, question: string, source: 'manual' | 'ai_adopted' = 'manual', segmentId?: string): Promise<LiveInterviewSession> { return (await apiClient.postJson<LiveInterviewSession>(`/interview-live-sessions/${sessionId}/question`, { question, source, ...(segmentId ? { segmentId } : {}) })).data }
export async function correctLiveSegmentRole(segmentId: string, role: 'interviewer' | 'candidate', segmentIds: string[] = [segmentId]): Promise<LiveInterviewSegment[]> { return (await apiClient.postJson<LiveInterviewSegment[]>(`/interview-live-segments/${segmentId}/role`, { role, segmentIds })).data }
export async function analyzeLiveSegment(segmentId: string, question: string, segmentIds: string[] = [segmentId], priorContext: string[] = []): Promise<LiveAnswerAnalysis> { return (await apiClient.postJson<LiveAnswerAnalysis>(`/interview-live-segments/${segmentId}/analyze`, { question, segmentIds, priorContext })).data }
