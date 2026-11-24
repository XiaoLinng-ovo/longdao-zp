import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LiveSegment } from './live-session-repository.js'
import { selectUtteranceSegments } from './utterance-segments.js'

const first: LiveSegment = { id: 'a', sessionId: 's', speakerId: 'voice_a', role: 'candidate', confidence: 1,
  speakerConfirmed: true, text: '回答', startMs: 0, endMs: 1000, status: 'transcribed', audioSource: 'microphone' }
const second: LiveSegment = { ...first, id: 'b', speakerId: 'voice_b', startMs: 2000, endMs: 3000 }

describe('utterance segment selection', () => {
  it('selects confirmed adjacent speech chronologically, with fallback for a single unconfirmed segment', () => {
    assert.deepEqual(selectUtteranceSegments([second, first], 'a', ['b', 'a', 'a']), [first, second])
    const unknown = { ...first, role: 'unknown' as const, speakerConfirmed: false }
    assert.deepEqual(selectUtteranceSegments([unknown], 'a', []), [unknown])
  })

  it('does not merge across sources, sessions, speakers, unknown speech, overlap or a long silence', () => {
    const invalidRows: LiveSegment[][] = [
      [first, { ...second, speakerConfirmed: false }],
      [first, { ...second, role: 'interviewer' }],
      [first, { ...second, role: 'unknown' }],
      [first, { ...second, audioSource: 'meeting' }],
      [first, { ...second, sessionId: 'other' }],
      [first, { ...second, confidence: .4 }],
      [first, { ...second, startMs: 500 }],
      [first, { ...second, startMs: 17000, endMs: 18000 }],
      [first, { ...first, id: 'middle', startMs: 1000, endMs: 1500 }, second],
    ]
    for (const rows of invalidRows) assert.throws(() => selectUtteranceSegments(rows, 'a', ['a', 'b']), { code: 'INVALID_UTTERANCE_SEGMENTS', status: 400 })
  })

  it('requires a valid primary id and existing ids within the 100-fragment limit', () => {
    for (const ids of [['b'], ['a', 'missing'], Array.from({ length: 101 }, (_, i) => i ? `id-${i}` : 'a')]) {
      assert.throws(() => selectUtteranceSegments([first, second], 'a', ids), { status: 400 })
    }
  })
})
