import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simplifyTranscript } from './transcript-text.js'
import { parseSpeakerSegments } from './asr-segments.js'
import { LiveInterviewSessionRepository } from './live-session-repository.js'
import { buildActualDialogue } from './interview-summary.js'

describe('transcript script normalization', () => {
  const oldRow = { id: 'a', session_id: 's', speaker_id: 'voice_2', role: 'candidate', role_confidence: .9, text: '我負責開發。', start_ms: 2000, end_ms: 4000, status: 'transcribed' }
  it('reads historical text for display and analysis without rewriting the database', async () => {
    const calls: string[] = []
    const repository = new LiveInterviewSessionRepository({ async query(sql: string) {
      calls.push(sql)
      return { rows: sql.startsWith('SELECT * FROM interview_live_sessions')
        ? [{ id: 's', interview_id: 'i', status: 'completed', external_status: 'ready', started_at: '2026-10-20T00:00:00Z', created_by: 'u' }] : [oldRow] }
    } } as never)
    const saved = await repository.get('s')
    assert.equal(saved.segments[0]?.text, '我负责开发。')
    assert.equal(await repository.getUtteranceText('a', ['a']), '我负责开发。')
    assert.equal(buildActualDialogue([{ ...saved.segments[0]!, text: oldRow.text }]).transcript[0]?.text, '我负责开发。')
    assert.ok(calls.every(sql => sql.startsWith('SELECT')))
    assert.equal(oldRow.text, '我負責開發。')
  })
  it('persists new transcript text in Simplified, including manually entered segments', async () => {
    let inserted: unknown[] = []
    const repository = new LiveInterviewSessionRepository({ async query(_sql: string, values: unknown[]) {
      inserted = values
      return { rows: [{ ...oldRow, text: values[4] }] }
    } } as never)
    const saved = await repository.addSegment('s', { speakerId: 'voice_2', role: 'candidate', confidence: .9, text: oldRow.text, startMs: 2000, endMs: 4000 })
    assert.equal(inserted[4], '我负责开发。')
    assert.equal(saved.text, '我负责开发。')
    assert.deepEqual(inserted.slice(5, 7), [2000, 4000])
  })
  it('converts script without correcting or inventing spoken words', () => {
    assert.equal(simplifyTranscript('對於我在學校報學的時候，需要聽很多表哥，然後提交自己的發票。'), '对于我在学校报学的时候，需要听很多表哥，然后提交自己的发票。')
    const mixed = '我用 Python 3.12 / RAG、AI 做开发，2026-10-20。\n100% OK!'
    assert.equal(simplifyTranscript(mixed), mixed)
    assert.equal(simplifyTranscript(''), '')
    assert.equal(simplifyTranscript(simplifyTranscript('學校發票')), '学校发票')
  })
  it('normalizes both recognizer response shapes without changing acoustic metadata', () => {
    const row = { id: 's1', speakerId: 'voice_2', text: '我負責開發與測試。', startMs: 1500, endMs: 4300, speakerVerified: true }
    assert.deepEqual(parseSpeakerSegments({ segments: [row] }), [{ ...row, text: '我负责开发与测试。' }])
    assert.equal(parseSpeakerSegments({ result: [{ spk: 1, sentence: '然後提交發票。', start: 1, end: 2 }] })[0]?.text, '然后提交发票。')
  })
})
