import { describe, expect, it } from 'vitest'
import { buildUtterances } from './utterance-state'

describe('live interview utterance state', () => {
  it('finalizes the latest candidate answer after silence without waiting for another speaker', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'speaker_1', role: 'candidate', confidence: .9, text: '完整回答。', startMs: 0, endMs: 3000, status: 'transcribed' },
    ], 5000, 1600)
    expect(result[0]?.final).toBe(true)
  })

  it('keeps the latest answer open before the silence threshold', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'speaker_1', role: 'candidate', confidence: .9, text: '仍在回答', startMs: 0, endMs: 3000, status: 'transcribed' },
    ], 4200, 1600)
    expect(result[0]?.final).toBe(false)
  })

  it('merges transport segments and preserves all source ids for complete analysis', () => {
    const result = buildUtterances([
      { id: 'a', sessionId: 's', speakerId: 'speaker_1', role: 'candidate', confidence: .9, text: '第一部分，', startMs: 0, endMs: 1000, status: 'transcribed' },
      { id: 'b', sessionId: 's', speakerId: 'speaker_1', role: 'candidate', confidence: .8, text: '第二部分。', startMs: 1200, endMs: 2200, status: 'transcribed' },
    ], 4000, 1600)
    expect(result[0]?.text).toBe('第一部分，第二部分。')
    expect(result[0]?.sourceIds).toEqual(['a', 'b'])
  })
})
