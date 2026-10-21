import { describe, expect, it } from 'vitest'
import type { LiveAnswerAnalysis, LiveInterviewSegment } from '../api'
import { buildLiveSummary } from './live-summary'

export const speech = (id: string, role: LiveInterviewSegment['role'], startMs: number, text = id): LiveInterviewSegment => ({
  id, sessionId: 's', speakerId: role, role, confidence: .9, text, startMs, endMs: startMs + 1000, status: 'transcribed',
})
const analysis: LiveAnswerAnalysis = { summary: '有原文依据', evidence: ['a'], scores: [], concerns: [], confidence: .8, nextQuestion: '', advisoryOnly: true, applicationStatusMutation: 'none' }

describe('live actual interview summary', () => {
  it('orders every question and answer by recording time, without mutating source records', () => {
    const input = [speech('a2', 'candidate', 9000), speech('q', 'interviewer', 0), speech('q2', 'interviewer', 6000), speech('a', 'candidate', 3000)]
    const result = buildLiveSummary(input)
    expect(result.pairs.map(pair => [pair.question, pair.answer])).toEqual([['q', 'a'], ['q2', 'a2']])
    expect(input[0]!.id).toBe('a2')
    expect(result.unpaired).toHaveLength(0)
  })
  it('extends a recorded answer while retaining earlier questions and their analyses', () => {
    const rows = [speech('q', 'interviewer', 0), speech('a', 'candidate', 3000)]
    const first = buildLiveSummary(rows, { a: analysis })
    const result = buildLiveSummary([...rows, speech('a-more', 'candidate', 4100), speech('q2', 'interviewer', 8000)])
    expect(first.pairs[0]!.analyses).toEqual([analysis])
    expect(result.pairs[0]!.answer).toBe('a\na-more')
    expect(result.pairs[0]!.answerSegmentIds).toEqual(['a', 'a-more'])
    expect(result.pairs[1]!.answer).toBe('')
    expect(rows[1]!.text).toBe('a')
  })
  it('never pairs across unknown speech or a new question, and keeps uncertain text', () => {
    const rows = [speech('q', 'interviewer', 0), speech('mixed', 'unknown', 3000), speech('a', 'candidate', 5000), speech('q2', 'interviewer', 9000), speech('a2', 'candidate', 12000)]
    const result = buildLiveSummary(rows, { mixed: analysis, a: analysis })
    expect(result.pairs.map(pair => pair.answer)).toEqual(['', 'a2'])
    expect(result.unpaired.map(turn => turn.text)).toEqual(['mixed', 'a'])
    expect(result.unpaired[0]!.analyses).toEqual([])
    expect(result.unpaired[1]!.analyses).toEqual([analysis])
  })
  it('does not assign overlapping answers or low confidence speech to a question', () => {
    const result = buildLiveSummary([speech('q', 'interviewer', 0), speech('overlap', 'candidate', 500), { ...speech('uncertain', 'candidate', 3000), confidence: .4 }], { uncertain: analysis })
    expect(result.pairs[0]!.answer).toBe('')
    expect(result.unpaired.map(turn => turn.role)).toEqual(['candidate', 'unknown'])
    expect(result.unpaired[1]!.analyses).toEqual([])
  })
  it('restores saved candidate analyses and prefers a fresh response', () => {
    const rows = [speech('q', 'interviewer', 0), { ...speech('a', 'candidate', 3000), analysis }]
    expect(buildLiveSummary(rows).pairs[0]!.analyses).toEqual([analysis])
    const updated = { ...analysis, summary: '更新后的分析' }
    expect(buildLiveSummary(rows, { a: updated }).pairs[0]!.analyses).toEqual([updated])
  })
})
