import { describe, expect, it } from 'vitest'
import { ApiNetworkError, ApiResponseError } from '../../../shared/api/errors'
import type { LiveInterviewSegment } from '../api'
import { analysisEligibility, analysisNeedsReview, retryableAnalysisError } from './analysis-eligibility'
import { buildUtterances } from './utterance-state'

const row = (id: string, role: LiveInterviewSegment['role'], startMs: number, endMs: number): LiveInterviewSegment => ({
  id, sessionId: 'session', speakerId: role, role, confidence: role === 'unknown' ? .35 : .9,
  text: '完整的发言内容。', startMs, endMs, status: 'transcribed', audioSource: 'meeting',
})
const check = (segments: LiveInterviewSegment[], id = 'answer') => {
  const utterance = buildUtterances(segments, 60_000, 15_000).find(item => item.sourceIds.includes(id))!
  return analysisEligibility(utterance, segments)
}

describe('live analysis eligibility', () => {
  it('allows a confirmed answer with an earlier actual question', () => {
    expect(check([row('question', 'interviewer', 0, 1000), row('answer', 'candidate', 2000, 4000)]).reason).toBe('')
  })
  it.each(['unknown', 'interviewer', 'candidate'] as const)('holds overlapping %s audio without discarding either source', role => {
    const segments = [row('answer', 'candidate', 2000, 4000), { ...row('other', role, 3000, 5000), audioSource: 'microphone' as const }]
    expect(check(segments).reason).toContain('重叠')
    expect(segments).toHaveLength(2)
  })
  it('holds low-confidence speech and accepts the same segment after role confirmation', () => {
    const segment = { ...row('answer', 'candidate', 2000, 4000), confidence: .35 }
    expect(check([segment]).reason).toContain('说话人待确认')
    expect(check([{ ...segment, confidence: 1, speakerConfirmed: true }]).reason).toBe('')
  })
  it('keeps overlap blocked after a role-only correction', () => {
    const segments = [row('answer', 'candidate', 2000, 4000), row('other', 'unknown', 3000, 5000)]
    expect(check(segments).reason).toBeTruthy()
    segments[1] = { ...segments[1]!, role: 'candidate', confidence: 1, speakerConfirmed: true }
    expect(check(segments).reason).toContain('重叠')
  })
  it('ignores other interviews and adjacent nonoverlapping turns', () => {
    const answer = row('answer', 'candidate', 2000, 4000)
    const other = { ...row('other', 'unknown', 1000, 5000), sessionId: 'another-session' }
    expect(check([row('question', 'interviewer', 0, 2000), answer, other]).reason).toBe('')
  })
  it('blocks an answer suffix whose full server-side turn has an earlier overlap', () => {
    const segments = [row('unknown', 'unknown', 0, 500), row('early', 'candidate', 200, 1000),
      { ...row('answer', 'candidate', 1200, 2200), speakerId: 'another-candidate-identity' }]
    expect(check(segments).reason).toContain('关联回答')
  })
  it('changes the revision for relevant corrections but not unrelated future uploads', () => {
    const answer = row('answer', 'candidate', 2000, 4000)
    const revision = check([answer]).revision
    expect(check([answer, row('later', 'candidate', 40_000, 41_000)]).revision).toBe(revision)
    expect(check([{ ...answer, speakerConfirmed: true }]).revision).not.toBe(revision)
    expect(check([answer, row('overlap', 'unknown', 3000, 5000)]).revision).not.toBe(revision)
  })
})

describe('analysis error classification', () => {
  it('retries only recoverable network and service failures', () => {
    expect(retryableAnalysisError(new ApiNetworkError('network'))).toBe(true)
    for (const status of [429, 502, 503]) expect(retryableAnalysisError(new ApiResponseError('temporary', { status }))).toBe(true)
    for (const status of [400, 401, 403, 409]) expect(retryableAnalysisError(new ApiResponseError('blocked', { status }))).toBe(false)
    expect(retryableAnalysisError(new ApiNetworkError('cancelled', { retryable: false }))).toBe(false)
    expect(retryableAnalysisError(new ApiResponseError('configure model', { code: 'AI_NOT_CONFIGURED', status: 503 }))).toBe(false)
    expect(retryableAnalysisError(new Error('unexpected'))).toBe(false)
  })
  it.each(['ANALYSIS_OVERLAPPING_SPEECH', 'ANALYSIS_CONTEXT_UNCONFIRMED', 'ANALYSIS_SEGMENTS_INVALID', 'CANDIDATE_ROLE_UNCONFIRMED', 'INVALID_INPUT'])(
    'recognizes new and legacy review errors: %s', code => {
      const error = new ApiResponseError('needs review', { code, status: 409 })
      expect(analysisNeedsReview(error)).toBe(true)
      expect(retryableAnalysisError(error)).toBe(false)
    })
})
