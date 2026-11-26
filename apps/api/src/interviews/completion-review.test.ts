import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { evaluateCompletionReview, loadCompletionReview, assertInterviewSessionsEnded } from './completion-review.js'
import { applyManualTranscriptRoles } from './manual-transcript-roles.js'
import { transcriptRoleReviewWarning, type CorrectedTranscriptTurn } from './transcript-postprocessing.js'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'

function turn(id = 'turn-1'): CorrectedTranscriptTurn {
  return { id, speakerId: 'voice-1', role: 'unknown', confidence: .35, text: '已纠正正文', startMs: 1000,
    endMs: 2000, audioSource: 'meeting', evidenceIds: ['evidence-1'], roleReasons: [] }
}
const mixed = { audioSource: 'meeting', offsetMs: 0, endMs: 10000, sourceMultipleSpeakers: true } as InterviewAudioManifestEntry

describe('interview completion speaker review', () => {
  for (const count of [0, 30, 31, 69]) it('allows automatic completion with unresolved turns: ' + count, () => {
    const turns = Array.from({ length: count }, (_, i) => turn('turn-' + i))
    const result = evaluateCompletionReview(turns, [mixed], 'version-1')
    assert.equal(result.phase, 'ready')
    assert.equal(result.unresolvedCount, count)
    assert.deepEqual(result.unresolvedIds, turns.map(row => row.id))
    assert.equal(result.versionId, 'version-1')
    assert.equal(result.limit, 30)
    if (count) assert.ok(transcriptRoleReviewWarning([mixed], turns), 'completion tolerance must not remove scoring warnings')
  })

  it('does not hide unknown, low-confidence or non-finite roles when the manifest is absent', () => {
    const turns = [turn('unknown'), { ...turn('low'), role: 'candidate' as const, confidence: .2, speakerConfirmed: true },
      { ...turn('nan'), role: 'candidate' as const, confidence: Number.NaN }, { ...turn('empty'), text: '  ' }]
    assert.deepEqual(evaluateCompletionReview(turns, []).unresolvedIds, ['unknown', 'low', 'nan'])
  })

  it('accepts reliable semantic inference and manual choices without fabricating speaker confirmation', () => {
    const semantic = { ...turn(), role: 'candidate' as const, confidence: .9,
      roleReview: { method: 'semantic_context' as const, status: 'inferred' as const, confidence: .9, reason: 'context', model: 'test', promptVersion: 'test' } }
    assert.equal(evaluateCompletionReview([semantic], [mixed]).unresolvedCount, 0)
    assert.equal(semantic.speakerConfirmed, undefined)
    assert.equal(evaluateCompletionReview([{ ...semantic, roleReview: { ...semantic.roleReview, status: 'mixed' } }], [mixed]).unresolvedCount, 1)
    assert.equal(evaluateCompletionReview([{ ...semantic, speakerConfirmed: true }], [mixed]).unresolvedCount, 0)
  })

  it('reapplies manual roles only to exactly matching evidence and preserves corrected text', () => {
    const original = turn()
    const saved = { ...original, role: 'candidate' as const }
    const corrected = applyManualTranscriptRoles([original], [saved])[0]!
    assert.equal(corrected.role, 'candidate')
    assert.equal(corrected.confidence, 1)
    assert.equal(corrected.speakerConfirmed, true)
    assert.equal(corrected.text, original.text)
    assert.deepEqual(corrected.evidenceIds, original.evidenceIds)
    assert.equal(original.role, 'unknown')
    for (const changed of [{ ...original, id: 'other' }, { ...original, text: '新正文' }, { ...original, startMs: 0 },
      { ...original, endMs: 3000 }, { ...original, audioSource: 'microphone' as const }]) {
      assert.equal(applyManualTranscriptRoles([changed], [saved])[0]!.role, 'unknown')
    }
  })

  for (const pending of ['audio', 'postprocess', 'none']) it('waits for all jobs: ' + pending, async () => {
    const db = { async query(sql: string) {
      if (sql.startsWith('SELECT turns')) return { rows: [{ turns: [turn()] }] }
      if (sql.startsWith('SELECT audio_source')) return { rows: [] }
      return { rows: [{ audio_pending: pending === 'audio', postprocess_status: pending === 'postprocess' ? 'processing' : 'completed' }] }
    } } as never
    const result = await loadCompletionReview(db, { id: 'session', status: 'paused', ended_at: '2026-11-16', corrected_transcript_version_id: 'version' })
    assert.equal(result?.phase, pending === 'none' ? 'ready' : 'processing')
  })

  it('keeps historical completions closed without concealing their unresolved count', async () => {
    const db = { async query(sql: string) { return { rows: sql.startsWith('SELECT turns') ? [{ turns: [turn()] }] : [] } } } as never
    const result = await loadCompletionReview(db, { id: 'session', status: 'completed', corrected_transcript_version_id: 'version' })
    assert.equal(result?.phase, 'completed')
    assert.equal(result?.unresolvedCount, 1)
  })

  it('blocks conclusion while a stopped or running recording session remains open', async () => {
    const db = { async query(sql: string) {
      assert.match(sql, /FOR UPDATE/)
      return { rows: [{ id: 'session', status: 'active' }] }
    } } as never
    await assert.rejects(assertInterviewSessionsEnded(db, 'interview'), { code: 'INTERVIEW_SESSION_NOT_ENDED', status: 409 })
    await assertInterviewSessionsEnded({ async query() { return { rows: [] } } } as never, 'interview')
  })
})
