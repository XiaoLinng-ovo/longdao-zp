import { apiClient } from '../../../shared/api'

export interface SummaryEvidence { pairId?: string; turnId?: string; quote: string }
export interface SummaryFinding { text: string; evidence: SummaryEvidence[] }
export interface SummaryDimension extends SummaryFinding { name: string; score: number }
export interface ActualInterviewPair {
  id: string; question: string; answer: string; questionSegmentIds: string[]; answerSegmentIds: string[]
  startMs: number; endMs: number; kind: 'assessment' | 'logistics' | 'unreviewed'
}
export interface TranscriptTurn { id: string; segmentIds: string[]; role: 'interviewer' | 'candidate' | 'unknown'; text: string; startMs: number; endMs: number; kind?: ActualInterviewPair['kind'] }
export interface InterviewSummaryReport {
  version: 'actual-dialogue-v1' | 'whole-dialogue-v2'; generatedAt: string; model: string | null; overallScore: number | null; summary: string
  dimensions: SummaryDimension[]; strengths: SummaryFinding[]; concerns: SummaryFinding[]; unassessed: string[]; warnings: string[]
  pairs: ActualInterviewPair[]; transcript: TranscriptTurn[]; advisoryOnly: true; applicationStatusMutation: 'none'
}
export interface InterviewSummaryView {
  sessionId: string; status: 'none' | 'pending' | 'generating' | 'ready' | 'failed'
  report: InterviewSummaryReport | null; error: string | null; revision: number
}
export async function loadInterviewSummary(interviewId: string): Promise<InterviewSummaryView | null> {
  return (await apiClient.getJson<InterviewSummaryView | null>(`/interviews/${interviewId}/summary`)).data
}
export async function requestInterviewSummary(interviewId: string): Promise<InterviewSummaryView> {
  return (await apiClient.postJson<InterviewSummaryView>(`/interviews/${interviewId}/summary`, {})).data
}
