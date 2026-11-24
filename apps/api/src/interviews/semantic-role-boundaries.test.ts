import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LiveSegment } from './live-session-repository.js'
import { buildActualDialogue, reliableCandidateTurns } from './interview-summary.js'
import { buildInterviewerRefinementContext, buildLiveAnalysisContext } from './live-analysis-context.js'
import { consolidateTranscript, rawSegmentsToEvidence, type TranscriptEvidenceSegment } from './transcript-postprocessing.js'
import type { SemanticRoleReview } from './semantic-role-review.js'
import { selectUtteranceSegments } from './utterance-segments.js'

const review = (status: SemanticRoleReview['status'] = 'inferred', confidence = .95): SemanticRoleReview => ({
  method: 'semantic_context', status, confidence, reason: '结合上下文复核', model: 'test', promptVersion: 'v2',
})
const segment = (role: LiveSegment['role'] = 'candidate', status: SemanticRoleReview['status'] = 'inferred'): LiveSegment => ({
  id: 'a', sessionId: 's', speakerId: 'voice-1', role, confidence: .95, text: '我负责后端开发。',
  startMs: 1000, endMs: 3000, status: 'transcribed', roleReview: review(status),
})
const offline = (row: LiveSegment): TranscriptEvidenceSegment => ({ ...rawSegmentsToEvidence([row])[0]!,
  evidenceId: 'offline:' + row.id, routeId: 'offline:funasr', routeKind: 'offline' })
const unreviewed = (row: LiveSegment): LiveSegment => {
  const { roleReview, ...rest } = row
  return rest
}

describe('semantic role boundaries across downstream processing', () => {
  for (const useLiveAnchor of [true, false]) {
    for (const [role, text] of [
      ['candidate', '请问岗位需要出差吗？我之前的项目主要在本地。'],
      ['interviewer', '我们负责平台开发。我之前也是做后端的。'],
    ] as const) {
      it('preserves contextual ' + role + ' and acoustic boundaries, live anchor=' + useLiveAnchor, () => {
        const original = { ...segment(role), text }
        const input = structuredClone(original)
        const result = useLiveAnchor
          ? consolidateTranscript([offline({ ...unreviewed(original), role: 'unknown' })], rawSegmentsToEvidence([original]))
          : consolidateTranscript([offline(original)], [])
        assert.equal(result.turns.length, 1)
        assert.equal(result.turns[0]!.role, role)
        assert.equal(result.turns[0]!.text, text)
        assert.equal(result.turns[0]!.speakerId, original.speakerId)
        assert.equal(result.turns[0]!.startMs, original.startMs)
        assert.equal(result.turns[0]!.endMs, original.endMs)
        assert.deepEqual(result.turns[0]!.roleReview, original.roleReview)
        assert.equal(result.turns[0]!.speakerConfirmed, false)
        assert.deepEqual(original, input)
      })
    }
    for (const status of ['mixed', 'uncertain'] as const) {
      it('keeps ' + status + ' unresolved despite a stale high-confidence role, live anchor=' + useLiveAnchor, () => {
        const original = { ...segment('interviewer', status), text: '请介绍你的项目？我负责后端开发。' }
        const result = useLiveAnchor ? consolidateTranscript([], rawSegmentsToEvidence([original]))
          : consolidateTranscript([offline(original)], [])
        assert.equal(result.turns.length, 1)
        assert.equal(result.turns[0]!.role, 'unknown')
        assert.ok(result.turns[0]!.confidence < .6)
        assert.deepEqual(result.turns[0]!.roleReview, original.roleReview)
        assert.equal(result.turns[0]!.text, original.text)
        assert.deepEqual(result.evidence.map(row => [row.startMs, row.endMs]), [[1000, 3000]])
      })
    }
  }

  it('retains unresolved semantic evidence instead of outvoting it with unreviewed routes', () => {
    const original = segment('candidate', 'mixed')
    const result = consolidateTranscript([offline(original),
      { ...offline({ ...unreviewed(original), id: 'b' }), routeId: 'offline:whisper' }], [])
    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.role, 'unknown')
    assert.equal(result.turns[0]!.roleReview?.status, 'mixed')
    assert.equal(result.turns[0]!.evidenceIds.length, 2)
  })

  it('does not resolve contradictory semantic roles joined by an unknown route', () => {
    const original = segment()
    const rows = [offline(original),
      { ...offline({ ...unreviewed(original), id: 'b', role: 'unknown' }), routeId: 'offline:bridge' },
      { ...offline({ ...original, id: 'c', role: 'interviewer' }), routeId: 'offline:whisper' }]
    const result = consolidateTranscript(rows, [])
    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.role, 'unknown')
    assert.equal(result.turns[0]!.roleReview?.status, 'uncertain')
  })

  it('honors subsequent manual confirmation over semantic uncertainty without deleting review evidence', () => {
    const original = { ...segment('candidate', 'mixed'), confidence: 1, speakerConfirmed: true }
    const result = consolidateTranscript([offline(original)], [])
    assert.equal(result.turns[0]!.role, 'candidate')
    assert.equal(result.turns[0]!.speakerConfirmed, true)
    assert.deepEqual(result.turns[0]!.roleReview, original.roleReview)
    assert.equal(buildActualDialogue([original]).transcript[0]!.role, 'candidate')
    assert.equal(buildLiveAnalysisContext([original], 'a', []).candidateAnswer, original.text)
  })

  it('does not let heuristic cues resolve contradictory manual confirmations', () => {
    const original = { ...unreviewed(segment()), speakerConfirmed: true, confidence: 1 }
    const rows = [offline(original),
      { ...offline({ ...original, id: 'b', role: 'unknown', speakerConfirmed: false }), routeId: 'offline:bridge' },
      { ...offline({ ...original, id: 'c', role: 'interviewer' }), routeId: 'offline:whisper' }]
    const result = consolidateTranscript(rows, [])
    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0]!.role, 'unknown')
    assert.equal(result.turns[0]!.speakerConfirmed, false)
    assert.ok(result.turns[0]!.roleReasons.includes('manual_role_conflict'))
  })

  for (const status of ['mixed', 'uncertain', 'inferred'] as const) {
    it('blocks unresolved ' + status + ' speech in analysis, merging and summary evidence', () => {
      const original = segment('candidate', status)
      if (status === 'inferred') original.roleReview!.confidence = .7
      const next = { ...original, id: 'b', startMs: 3000, endMs: 4000 }
      assert.throws(() => selectUtteranceSegments([original, next], 'a', ['a', 'b']), { code: 'INVALID_UTTERANCE_SEGMENTS' })
      assert.throws(() => buildLiveAnalysisContext([original], 'a', []), { code: 'ANALYSIS_SPEAKER_UNCONFIRMED' })
      assert.throws(() => buildInterviewerRefinementContext([{ ...original, role: 'interviewer' }], 'a', []), { code: 'ANALYSIS_SPEAKER_UNCONFIRMED' })
      const dialogue = buildActualDialogue([original, next])
      assert.deepEqual(dialogue.transcript.map(row => row.role), ['unknown', 'unknown'])
      assert.equal(reliableCandidateTurns(dialogue.transcript).length, 0)
    })
  }

  it('allows high-confidence semantic speech without pretending it is manually confirmed', () => {
    const original = segment()
    assert.equal(buildLiveAnalysisContext([original], 'a', []).candidateAnswer, original.text)
    assert.equal(buildActualDialogue([original]).transcript[0]!.role, 'candidate')
    assert.equal(original.speakerConfirmed, undefined)
  })
})
