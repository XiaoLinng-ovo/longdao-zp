import { RecruitingWorkflowError } from './workflow.js'

export type InterviewOutcome = 'continue' | 'offer' | 'reject'
export interface InterviewResult {
  outcome: InterviewOutcome | null
  aiScore: number | null
  aiScoreStatus: string
}

export function interviewOutcome(value: unknown): InterviewOutcome | null {
  return value === 'continue' || value === 'offer' || value === 'reject' ? value : null
}

export function summaryScore(status: unknown, report: unknown): number | null {
  if (status !== 'ready' || !report || typeof report !== 'object') return null
  const summary = report as { version?: unknown; overallScore?: unknown }
  return summary.version === 'whole-dialogue-v2' && typeof summary.overallScore === 'number'
    && Number.isFinite(summary.overallScore) && summary.overallScore >= 0 && summary.overallScore <= 100
    ? summary.overallScore : null
}

export function validateDirectInterviewOutcome(interview: { stage?: string; round: number }, outcome: InterviewOutcome): void {
  const final = interview.stage === 'final' || interview.round >= 2
  if (!['continue', 'offer', 'reject'].includes(outcome) || (final ? outcome === 'continue' : outcome === 'offer')) {
    throw new RecruitingWorkflowError('INVALID_INTERVIEW_OUTCOME', final ? '复试请选择通过进入 Offer 或未通过' : '初试请选择进入下一轮或未通过', 400)
  }
}
