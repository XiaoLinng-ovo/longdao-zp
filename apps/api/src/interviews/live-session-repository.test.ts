import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LiveInterviewSessionRepository } from './live-session-repository.js'

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
