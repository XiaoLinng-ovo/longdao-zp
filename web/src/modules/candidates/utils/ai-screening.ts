import type { Candidate } from '../../../shared/types/recruiting'

export const AI_SCREENING_THRESHOLD = 80
export const screeningStatuses = ['pending_analysis', 'analysis_queued', 'human_review']
export function aiResumeScore(row: Candidate): number | undefined {
  if (['queued', 'processing', 'failed'].includes(row.analysisStatus || '') || row.aiStatus !== 'completed') return undefined
  const value = row.resumeReview ? row.resumeReview.aiScore : row.scoreAvailable !== false ? row.score : undefined
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined
}
export function canStartInitialInterview(row: Candidate): boolean {
  const score = aiResumeScore(row)
  return !!row.applicationId && score !== undefined && screeningStatuses.includes(row.rawApplicationStatus || '')
}

export function canArrangeInitialInterview(row: Candidate): boolean {
  return !!row.applicationId && !row.interviewProgress
    && (row.rawApplicationStatus === 'interviewing' || canStartInitialInterview(row))
}

export function interviewProgressLabel(row: Candidate): string {
  const progress = row.interviewProgress
  if (progress) return `${progress.stage === 'final' ? '复试' : '初试'}${progress.status === 'completed' ? '已完成' : '已安排'}`
  return row.rawApplicationStatus === 'interviewing' ? '已通过 · 待安排初试' : ''
}
