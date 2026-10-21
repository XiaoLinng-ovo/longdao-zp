import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LiveInterviewSessionRepository } from './live-session-repository.js'
import { ACTUAL_ANSWER_PROMPT_VERSION } from './actual-answer-analysis.js'

describe('LiveInterviewSessionRepository question persistence', () => {
  it('updates the current question and records an immutable question event', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = []
    const client = {
      async query(text: string, values?: unknown[]) {
        calls.push(values ? { text, values } : { text })
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] }
        if (text.startsWith('UPDATE interview_live_sessions')) return { rows: [{ id: 'session-1', interview_id: 'interview-1', status: 'active', external_status: 'not_configured', started_at: '2026-01-01T00:00:00.000Z', created_by: 'user-1', current_question: '请描述你负责过的项目。' }] }
        return { rows: [] }
      },
      release() {},
    }
    const pool = { async connect() { return client } }
    const repository = new LiveInterviewSessionRepository(pool as never)

    const session = await repository.setCurrentQuestion('session-1', '请描述你负责过的项目。', 'manual', 'user-1')

    assert.equal(session.currentQuestion, '请描述你负责过的项目。')
    assert.deepEqual(calls.filter((call) => call.text.startsWith('INSERT INTO interview_live_question_events'))[0]?.values, ['session-1', '请描述你负责过的项目。', 'manual', 'user-1', null])
  })
})

describe('audio source persistence', () => {
  it('writes and restores provenance without assigning a source to historical rows', async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const segment = { id: 'a', session_id: 's', speaker_id: 'meeting:single', role: 'candidate', role_confidence: 1, text: '项目说明', start_ms: 1000, end_ms: 2000, status: 'transcribed', audio_source: 'meeting' }
    const repository = new LiveInterviewSessionRepository({ async query(sql: string, values?: unknown[]) {
      calls.push({ sql, ...(values ? { values } : {}) })
      if (sql.startsWith('SELECT * FROM interview_live_sessions')) return { rows: [{ id: 's', interview_id: 'i', status: 'active', external_status: 'ready', started_at: '2026-10-20T00:00:00Z', created_by: 'u' }] }
      if (sql.startsWith('SELECT s.*')) return { rows: [segment, { ...segment, id: 'legacy', audio_source: null }] }
      return { rows: [segment] }
    } } as never)
    const saved = await repository.addSegment('s', { speakerId: 'meeting:single', role: 'candidate', confidence: 1, text: '项目说明', startMs: 1000, endMs: 2000, audioSource: 'meeting', audioObjectKey: 'original' })
    assert.equal(saved.audioSource, 'meeting')
    assert.equal(calls[0]!.values?.[8], 'meeting')
    const restored = await repository.get('s')
    assert.equal(restored.segments[0]!.audioSource, 'meeting')
    assert.equal(restored.segments[1]!.audioSource, undefined)
  })
})

describe('actual dialogue analysis persistence', () => {
  const segment = { id: 'a', session_id: 's', speaker_id: 'candidate', role: 'candidate', role_confidence: 1, text: '我完成了开发。', start_ms: 2000, end_ms: 4000, status: 'analyzed' }
  it('versions saved analyses so reference-based scores cannot be reused', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = []
    const client = { async query(text: string, values?: unknown[]) {
      calls.push({ text, ...(values ? { values } : {}) })
      return { rows: text.startsWith('SELECT *') ? [segment] : [] }
    }, release() {} }
    const repository = new LiveInterviewSessionRepository({ async connect() { return client } } as never)
    await repository.saveAnalysis('a', '请介绍项目。', { summary: '项目交付', evidence: [], scores: [], concerns: [], confidence: 0, nextQuestion: '', advisoryOnly: true, applicationStatusMutation: 'none' }, 'model')
    const insert = calls.find(call => call.text.startsWith('INSERT INTO interview_live_analyses'))!
    assert.equal(insert.values?.[1], '请介绍项目。')
    assert.equal(insert.values?.[9], ACTUAL_ANSWER_PROMPT_VERSION)
  })
  it('excludes old prompt versions when restoring a live room', async () => {
    let segmentQuery = ''
    const repository = new LiveInterviewSessionRepository({ async query(text: string) {
      if (text.startsWith('SELECT * FROM interview_live_sessions')) return { rows: [{ id: 's', interview_id: 'i', status: 'completed', external_status: 'ready', started_at: '2026-10-19T00:00:00Z', created_by: 'u' }] }
      segmentQuery = text
      return { rows: [{ ...segment, analysis: null }] }
    } } as never)
    const saved = await repository.get('s')
    assert.ok(segmentQuery.includes("a.prompt_version <> '" + ACTUAL_ANSWER_PROMPT_VERSION + "'"))
    assert.equal(saved.segments[0]?.analysis, undefined)
  })
})
