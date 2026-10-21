import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionVoiceprintTracker, validSpeakerEmbedding } from './voiceprint-tracker.js'
import { mapInterviewRoles, scopeSpeakersToChunk, type SpeakerSegment } from './role-mapper.js'

function segment(speakerId: string, vector?: number[], extra: Partial<SpeakerSegment> = {}): SpeakerSegment {
  return { id: speakerId, speakerId, text: '我负责系统开发。', startMs: 0, endMs: 2000,
    speakerVerified: true, ...(vector ? { speakerEmbedding: vector } : {}), ...extra }
}

describe('session voice matching', () => {
  it('matches voices across reversed local labels and strips all vectors', () => {
    const tracker = new SessionVoiceprintTracker()
    const first = tracker.identify('s', [segment('speaker_0', [1, 0]), segment('speaker_1', [0, 1])])
    const second = tracker.identify('s', [segment('speaker_0', [0, 0.99]), segment('speaker_1', [0.99, 0.01])])
    assert.equal(first[0]?.speakerId, second[1]?.speakerId)
    assert.equal(first[1]?.speakerId, second[0]?.speakerId)
    assert.notEqual(first[0]?.speakerId, first[1]?.speakerId)
    assert.ok(first.every(row => row.speakerId.startsWith('voice_')))
    assert.ok([...first, ...second].every(row => !('speakerEmbedding' in row)))
  })

  it('matches voices within a source without transferring identity across sources', () => {
    const tracker = new SessionVoiceprintTracker()
    const input = [segment('speaker_0', [1, 0])]
    const mic = tracker.identify('s', input, 'microphone')[0]!.speakerId
    const meeting = tracker.identify('s', input, 'meeting')[0]!.speakerId
    assert.notEqual(mic, meeting)
    assert.equal(tracker.identify('s', input, 'microphone')[0]?.speakerId, mic)
    assert.equal(tracker.identify('s', input, 'meeting')[0]?.speakerId, meeting)
    assert.notEqual(tracker.identify('s', input)[0]?.speakerId, mic)
  })

  it('never merges two distinct local speakers into one existing voice', () => {
    const tracker = new SessionVoiceprintTracker()
    tracker.identify('s', [segment('speaker_0', [1, 0])])
    const rows = tracker.identify('s', [segment('speaker_0', [1, 0]), segment('speaker_1', [1, 0])])
    assert.notEqual(rows[0]?.speakerId, rows[1]?.speakerId)
  })

  it('does not guess an ambiguous match between similar profiles', () => {
    const tracker = new SessionVoiceprintTracker()
    const first = tracker.identify('s', [segment('a', [1, 0]), segment('b', [0.99, 0.1])])
    const [next] = tracker.identify('s', [segment('c', [1, 0.05])])
    assert.ok(first.every(row => row.speakerId !== next?.speakerId))
  })

  it('isolates sessions and forgets ended, expired, and evicted sessions', () => {
    let now = 0
    const tracker = new SessionVoiceprintTracker(() => now, 100, 2)
    const input = [segment('a', [1, 0])]
    const first = tracker.identify('one', input)[0]!.speakerId
    assert.notEqual(tracker.identify('two', input)[0]?.speakerId, first)
    tracker.forget('one')
    const afterForget = tracker.identify('one', input)[0]!.speakerId
    assert.notEqual(afterForget, first)
    now = 101
    assert.notEqual(tracker.identify('one', input)[0]?.speakerId, afterForget)
    const previous = tracker.identify('one', input)[0]!.speakerId
    now++
    tracker.identify('two', input)
    now++
    tracker.identify('three', input)
    assert.notEqual(tracker.identify('one', input)[0]?.speakerId, previous)
  })

  it('bounds voice profiles and never exposes invalid or mixed voice vectors', () => {
    const tracker = new SessionVoiceprintTracker()
    const rows = tracker.identify('s', Array.from({ length: 20 }, (_, i) => segment(`a${i}`, [1, 0])))
    assert.equal(rows.filter(row => row.speakerId.startsWith('voice_')).length, 16)
    for (const extra of [{ speakerMixed: true }, { speakerVerified: false }]) {
      const [row] = tracker.identify('s', [segment('unsafe', [1, 0], extra)])
      assert.equal(row?.speakerId, 'unsafe')
      assert.ok(!('speakerEmbedding' in row!))
    }
    for (const vector of [[], [0, 0], [NaN, 1], [Infinity, 1], [Number.MAX_VALUE, Number.MAX_VALUE], Array(1025).fill(1)]) {
      assert.equal(validSpeakerEmbedding(vector), false)
    }
  })

  it('assigns a local voice consistently even when only a later sentence has an embedding', () => {
    const tracker = new SessionVoiceprintTracker()
    const rows = tracker.identify('s', [segment('a'), segment('a', [1, 0])])
    assert.equal(rows[0]?.speakerId, rows[1]?.speakerId)
    assert.ok(rows[0]?.speakerId.startsWith('voice_'))
  })

  it('keeps mixed speech out of candidate scoring throughout the matching pipeline', () => {
    const tracker = new SessionVoiceprintTracker()
    const rows = tracker.identify('s', [
      segment('a', [1, 0], { text: '请介绍一下工作经历？' }),
      segment('b', [0, 1]),
      segment('a', [1, 0], { speakerMixed: true }),
    ])
    const result = mapInterviewRoles(scopeSpeakersToChunk(rows, 0), {})
    assert.deepEqual(result.map(row => row.role), ['interviewer', 'candidate', 'unknown'])
    assert.ok(result[2]!.confidence < 0.6)
    assert.ok(result.every(row => !('speakerEmbedding' in row)))
  })
})
