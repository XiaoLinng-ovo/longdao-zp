import { describe, expect, it } from 'vitest'
import type { Candidate } from '../../../shared/types/recruiting'
import { aiResumeScore, canStartInitialInterview } from './ai-screening'
const candidate = (overrides: Partial<Candidate> = {}) => ({
  id: 'candidate-1', applicationId: 'application-1', rawApplicationStatus: 'human_review',
  aiStatus: 'completed', analysisStatus: 'completed', score: 99, scoreAvailable: true,
  resumeReview: { resultId: 'result-1', aiScore: 80, humanScore: 0, finalScore: 48, talentPool: false, history: [], evidence: [], strengths: [], risks: [] },
  ...overrides,
} as Candidate)

describe('AI screening guard', () => {
  it.each([0, 79.99, 80, 100])('only uses real AI score %s regardless of old weighted score', score => {
    const row = candidate(); row.resumeReview!.aiScore = score
    expect(aiResumeScore(row)).toBe(score)
    expect(canStartInitialInterview(row)).toBe(true)
  })
  it.each([undefined, -1, 101, NaN, Infinity])('does not replace invalid AI score %s with a legacy total', score => {
    const row = candidate(); row.resumeReview!.aiScore = score
    expect(aiResumeScore(row)).toBeUndefined()
    expect(canStartInitialInterview(row)).toBe(false)
  })
  it.each(['queued', 'processing', 'failed'] as const)('does not allow historical score while task is %s', analysisStatus => {
    const row = candidate({ analysisStatus })
    expect(aiResumeScore(row)).toBeUndefined()
    expect(canStartInitialInterview(row)).toBe(false)
  })
  it('requires a completed AI analysis and an active application', () => {
    expect(canStartInitialInterview(candidate({ aiStatus: 'pending' }))).toBe(false)
    expect(canStartInitialInterview(candidate({ applicationId: undefined }))).toBe(false)
    for (const rawApplicationStatus of ['interviewing', 'rejected', 'offer', 'hired']) {
      expect(canStartInitialInterview(candidate({ rawApplicationStatus }))).toBe(false)
    }
  })
})
