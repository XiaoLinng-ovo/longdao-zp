import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InterviewSummaryRepository } from './interview-summary-repository.js'
import { LiveInterviewSessionRepository } from './live-session-repository.js'

describe('corrected transcript read path', () => {
  it('reads published turns instead of the raw realtime segments when a version is attached', async () => {
    const calls: string[] = []
    const pool = { async query(sql: string) {
      calls.push(sql)
      if (sql.startsWith('SELECT * FROM interview_live_sessions')) return { rows: [{ id: 'session-1', interview_id: 'interview-1',
        status: 'completed', external_status: 'ready', started_at: '2026-11-04T00:00:00Z', created_by: 'user-1',
        current_question: '请介绍项目。', corrected_transcript_version_id: 'version-1' }] }
      if (sql.startsWith('SELECT turns, metadata FROM interview_transcript_versions')) return { rows: [{ turns: [{
        id: 'turn-1', speakerId: 'voice-1', role: 'candidate', confidence: .9, text: '我校正后的回答。',
        startMs: 1000, endMs: 2000, evidenceIds: ['live:raw-1'], roleReasons: ['reviewed'], audioSource: 'meeting', speakerConfirmed: true,
      }], metadata: { roleReviewRequired: true, warnings: ['原始录音只覆盖到本场第 5 分 19 秒，后续时段没有原音频证据。'] } }] }
      throw new Error(`不应读取原始片段：${sql}`)
    } }
    const result = await new LiveInterviewSessionRepository(pool as never).get('session-1')

    assert.equal(result.segments[0]!.text, '我校正后的回答。')
    assert.equal(result.segments[0]!.role, 'candidate')
    assert.equal(result.segments[0]!.audioSource, 'meeting')
    assert.equal(result.segments[0]!.speakerConfirmed, true)
    assert.equal(result.transcriptRoleReviewRequired, true)
    assert.deepEqual(result.transcriptWarnings, ['原始录音只覆盖到本场第 5 分 19 秒，后续时段没有原音频证据。'])
    assert.ok(!calls.some(sql => sql.includes('FROM interview_live_segments')))
  })

  it('does not let summary generation claim before transcript postprocessing completes', async () => {
    let captured = ''
    const repository = new InterviewSummaryRepository({ async query(sql: string) {
      captured = sql
      return { rows: [] }
    } } as never)

    assert.equal(await repository.claim(), null)
    assert.match(captured, /interview_transcript_postprocess_jobs/u)
    assert.match(captured, /p\.status<>'completed'/u)
  })
})
