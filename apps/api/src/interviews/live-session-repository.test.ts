import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LiveInterviewSessionRepository } from './live-session-repository.js'
import { ACTUAL_ANSWER_PROMPT_VERSION } from './actual-answer-analysis.js'

describe('live session creation state gate', () => {
  function fixture(interviewStatus: string | undefined, insertError?: Error) {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    let releases = 0
    const sessionRow = {
      id: 'session-1', interview_id: 'interview-1', status: 'active', external_status: 'not_configured',
      started_at: '2026-01-01T00:00:00.000Z', created_by: 'user-1', current_question: '',
    }
    const client = {
      async query(sql: string, values?: unknown[]) {
        calls.push({ sql, ...(values ? { values } : {}) })
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
        if (sql.startsWith('SELECT status FROM interviews')) return { rows: interviewStatus ? [{ status: interviewStatus }] : [] }
        if (sql.startsWith('INSERT INTO interview_live_sessions')) {
          if (insertError) throw insertError
          return { rows: [sessionRow] }
        }
        return { rows: [] }
      },
      release() { releases++ },
    }
    const repository = new LiveInterviewSessionRepository({ async connect() { return client } } as never)
    return { repository, calls, released: () => releases }
  }

  it('locks a scheduled interview and creates the session in one transaction', async () => {
    const fixtureResult = fixture('scheduled')

    const session = await fixtureResult.repository.create('interview-1', 'user-1')

    assert.equal(session.id, 'session-1')
    assert.equal(session.interviewId, 'interview-1')
    assert.deepEqual(fixtureResult.calls.map(call => call.sql), [
      'BEGIN',
      'SELECT status FROM interviews WHERE id = $1::uuid FOR UPDATE',
      'INSERT INTO interview_live_sessions (interview_id, created_by) VALUES ($1::uuid, $2::uuid) RETURNING *',
      'COMMIT',
    ])
    assert.deepEqual(fixtureResult.calls[2]?.values, ['interview-1', 'user-1'])
    assert.equal(fixtureResult.released(), 1)
  })

  for (const scenario of [
    ['completed', 'INTERVIEW_ALREADY_COMPLETED'],
    ['cancelled', 'INTERVIEW_CANCELLED'],
    ['draft', 'INTERVIEW_NOT_SCHEDULED'],
    ['in_progress', 'INTERVIEW_NOT_SCHEDULED'],
  ] as const) {
    it(`rejects ${scenario[0]} interviews without inserting a session`, async () => {
      const fixtureResult = fixture(scenario[0])

      await assert.rejects(fixtureResult.repository.create('interview-1', 'user-1'), {
        code: scenario[1], status: 409,
      })

      assert.ok(!fixtureResult.calls.some(call => call.sql.startsWith('INSERT')))
      assert.equal(fixtureResult.calls.at(-1)?.sql, 'ROLLBACK')
      assert.equal(fixtureResult.released(), 1)
    })
  }

  it('returns not found when the interview does not exist', async () => {
    const fixtureResult = fixture(undefined)

    await assert.rejects(fixtureResult.repository.create('missing', 'user-1'), {
      code: 'INTERVIEW_NOT_FOUND', status: 404,
    })

    assert.ok(!fixtureResult.calls.some(call => call.sql.startsWith('INSERT')))
    assert.equal(fixtureResult.calls.at(-1)?.sql, 'ROLLBACK')
    assert.equal(fixtureResult.released(), 1)
  })

  it('maps a database trigger rejection to a domain 409 instead of a 500', async () => {
    const trigger = Object.assign(new Error('INTERVIEW_ALREADY_COMPLETED'), { code: 'P0001' })
    const fixtureResult = fixture('scheduled', trigger)

    await assert.rejects(fixtureResult.repository.create('interview-1', 'user-1'), {
      code: 'INTERVIEW_ALREADY_COMPLETED', status: 409, message: '面试已完成，不能重新创建实时会话',
    })

    assert.equal(fixtureResult.calls.at(-1)?.sql, 'ROLLBACK')
    assert.equal(fixtureResult.released(), 1)
  })

  it('maps an active-session unique violation and rolls back', async () => {
    const conflict = Object.assign(new Error('duplicate active session'), { code: '23505' })
    const fixtureResult = fixture('scheduled', conflict)

    await assert.rejects(fixtureResult.repository.create('interview-1', 'user-1'), {
      code: 'LIVE_SESSION_ALREADY_ACTIVE', status: 409,
    })

    assert.equal(fixtureResult.calls.filter(call => call.sql.startsWith('INSERT')).length, 1)
    assert.equal(fixtureResult.calls.at(-1)?.sql, 'ROLLBACK')
    assert.equal(fixtureResult.released(), 1)
  })
})

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
  it('persists both recognition versions independently of the scored text and reloads them', async () => {
    const comparison = { streamingText: '我负责平台的开发。', offlineText: '我负责平台开发。团队八个人。',
      streamingComplete: false, selectedSource: 'offline' as const, startMs: 15000, endMs: 30000 }
    const row = { id: 'a', session_id: 's', speaker_id: 'voice_1', role: 'candidate', role_confidence: .82,
      text: comparison.offlineText, start_ms: 15000, end_ms: 30000, status: 'transcribed', transcript_comparison: comparison }
    let written: unknown[] | undefined
    const repository = new LiveInterviewSessionRepository({ async query(sql: string, values?: unknown[]) {
      if (sql.startsWith('SELECT * FROM interview_live_sessions')) return { rows: [{ id: 's', interview_id: 'i', status: 'active', external_status: 'ready', started_at: '2026-10-23T00:00:00Z', created_by: 'u' }] }
      if (sql.startsWith('INSERT')) { assert.match(sql, /transcript_comparison/); written = values }
      return { rows: [row] }
    } } as never)
    const saved = await repository.addSegment('s', { speakerId: 'voice_1', role: 'candidate', confidence: .82,
      text: comparison.offlineText, startMs: 15000, endMs: 30000, transcriptComparison: comparison })
    assert.deepEqual(JSON.parse(String(written?.[9])), comparison)
    assert.equal(written?.[4], comparison.offlineText)
    assert.deepEqual(saved.transcriptComparison, comparison)
    const restored = await repository.get('s')
    assert.deepEqual(restored.segments[0]?.transcriptComparison, comparison)
    assert.equal(restored.segments[0]?.text, comparison.offlineText)
  })
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
  it('persists and restores refinement and source membership separately from original speech', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = []
    const analysis = { summary: '项目交付', evidence: [], scores: [], concerns: [], confidence: .8, nextQuestion: '', advisoryOnly: true as const, applicationStatusMutation: 'none' as const,
      transcriptRefinement: { text: '我完成了开发和验收。', corrections: [], uncertainties: ['项目名称待核实'] },
      sourceSegments: [{ id: 'a', text: segment.text, role: 'candidate', speakerId: 'candidate' }, { id: 'b', text: '和验收。', role: 'candidate', speakerId: 'candidate' }] }
    const query = async (text: string, values?: unknown[]) => {
      calls.push({ text, ...(values ? { values } : {}) })
      if (text.startsWith('SELECT * FROM interview_live_sessions')) return { rows: [{ id: 's', interview_id: 'i', status: 'active', external_status: 'ready', started_at: '2026-10-22T00:00:00Z', created_by: 'u' }] }
      return { rows: [{ ...segment, analysis }] }
    }
    const repository = new LiveInterviewSessionRepository({ query, async connect() { return { query, release() {} } } } as never)
    await repository.saveAnalysis('a', '请介绍项目。', analysis, 'model')
    const insert = calls.find(call => call.text.startsWith('INSERT INTO interview_live_analyses'))!
    assert.deepEqual(JSON.parse(String(insert.values?.[10])), analysis.transcriptRefinement)
    assert.deepEqual(JSON.parse(String(insert.values?.[11])), analysis.sourceSegments)
    const restored = await repository.get('s')
    assert.deepEqual(restored.segments[0]?.analysis, analysis)
    assert.equal(restored.segments[0]?.text, segment.text)
    assert.ok(calls.some(call => call.text.includes("'transcriptRefinement',a.transcript_refinement,'sourceSegments',a.source_segments")))
    assert.ok(!calls.some(call => /UPDATE interview_live_segments.*text\s*=/.test(call.text)))
  })
})

describe('manual refinement persistence', () => {
  function fixture(role = 'candidate') {
    const speech = { id: 'a', session_id: 's', speaker_id: 'voice', role, role_confidence: 1,
      text: '原始发言', start_ms: 0, end_ms: 1000, status: 'analyzed' }
    const sourceSegments = [{ id: 'a', text: speech.text, role, speakerId: speech.speaker_id }]
    const analysis = { transcript_refinement: { text: '模型整理的发言', corrections: [{ original: '原字', corrected: '改字' }], uncertainties: ['存档记录'] },
      source_segments: sourceSegments, prompt_version: ACTUAL_ANSWER_PROMPT_VERSION }
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    let released = false
    const client = { async query(sql: string, values?: unknown[]) {
      calls.push({ sql, ...(values ? { values } : {}) })
      if (sql.startsWith('SELECT * FROM interview_live_segments')) return { rows: [speech] }
      if (sql.startsWith('SELECT transcript_refinement')) return { rows: [analysis] }
      if (sql.startsWith('UPDATE interview_live_analyses')) analysis.transcript_refinement = JSON.parse(String(values![1]))
      return { rows: [] }
    }, release() { released = true } }
    return { repository: new LiveInterviewSessionRepository({ async connect() { return client } } as never),
      calls, analysis, speech, sourceSegments, released: () => released }
  }
  for (const role of ['candidate', 'interviewer']) it(`saves ${role} edits without changing original speech or scoring fields`, async () => {
    const f = fixture(role)
    const result = await f.repository.updateRefinement('a', { text: '  手动微调后的发言  ', expectedText: '模型整理的发言', sourceSegments: f.sourceSegments }, 'user-1')
    assert.equal(result.text, '手动微调后的发言')
    assert.equal(result.editedBy, 'user-1')
    assert.ok(Number.isFinite(Date.parse(result.editedAt!)))
    assert.deepEqual(result.corrections, [{ original: '原字', corrected: '改字' }])
    assert.equal(f.speech.text, '原始发言')
    assert.deepEqual(f.analysis.transcript_refinement, result)
    assert.deepEqual(f.calls.filter(call => call.sql.startsWith('UPDATE')).map(call => call.sql), [
      'UPDATE interview_live_analyses SET transcript_refinement=$2::jsonb WHERE segment_id=$1::uuid',
    ])
    assert.equal(f.calls[0]!.sql, 'BEGIN')
    assert.match(f.calls[1]!.sql, /ORDER BY id FOR UPDATE/)
    assert.match(f.calls[2]!.sql, /FOR UPDATE/)
    assert.equal(f.calls.at(-1)!.sql, 'COMMIT')
    assert.ok(f.released())
  })
  for (const scenario of ['text', 'speech', 'role', 'version']) it(`rejects stale ${scenario} without overwriting saved data`, async () => {
    const f = fixture()
    if (scenario === 'speech') f.speech.text = '原始发言已更新'
    if (scenario === 'role') f.speech.role = 'unknown'
    if (scenario === 'version') f.analysis.prompt_version = 'old'
    await assert.rejects(f.repository.updateRefinement('a', {
      text: '不应保存', expectedText: scenario === 'text' ? '旧版本' : '模型整理的发言', sourceSegments: f.sourceSegments,
    }, 'user-1'), { code: 'TRANSCRIPT_REFINEMENT_CONFLICT', status: 409 })
    assert.equal(f.analysis.transcript_refinement.text, '模型整理的发言')
    assert.ok(!f.calls.some(call => call.sql.startsWith('UPDATE')))
    assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK')
    assert.ok(f.released())
  })
})

describe('manual speaker confirmation persistence', () => {
  it('persists manual confirmation, preserves acoustic identities and restores the merged answer after reload', async () => {
    const rows = ['a', 'b'].map((id, index) => ({ id, session_id: 's', speaker_id: `voice_${index}`,
      role: 'unknown', role_confidence: .3, speaker_confirmed: false, text: `回答${index + 1}。`,
      start_ms: index * 2000, end_ms: index * 2000 + 1000, status: 'transcribed', audio_source: 'meeting' }))
    const queries: string[] = []
    const repository = new LiveInterviewSessionRepository({ async query(sql: string, values?: unknown[]) {
      queries.push(sql)
      if (sql.startsWith('SELECT * FROM interview_live_sessions')) return { rows: [{ id: 's', interview_id: 'i', status: 'active', external_status: 'ready', started_at: '2026-10-22T00:00:00Z', created_by: 'u' }] }
      if (sql.startsWith('UPDATE interview_live_segments')) {
        const ids = sql.includes('ANY(') ? values![0] as string[] : [values![0] as string]
        const updated = rows.filter(row => ids.includes(row.id))
        for (const row of updated) { row.role = values![1] as string; row.role_confidence = 1; row.speaker_confirmed = /speaker_confirmed\s*=\s*true/.test(sql) }
        return { rows: updated }
      }
      return { rows }
    } } as never)
    await repository.correctUtteranceRole('a', ['a'], 'candidate')
    await repository.correctRole('b', 'candidate')
    const restored = await repository.get('s')
    assert.deepEqual(restored.segments.map(row => [row.speakerId, row.role, row.speakerConfirmed]), [
      ['voice_0', 'candidate', true], ['voice_1', 'candidate', true],
    ])
    assert.equal(await repository.getUtteranceText('a', ['b', 'a']), '回答1。回答2。')
    const updated = await repository.correctUtteranceRole('a', ['a', 'b'], 'interviewer')
    assert.equal(updated.length, 2)
    assert.ok(updated.every(row => row.speakerConfirmed && row.role === 'interviewer'))
    assert.ok(queries.filter(sql => sql.startsWith('UPDATE')).every(sql => !sql.includes('speaker_id=')))
  })

  it('rejects non-adjacent selections before writing any role changes', async () => {
    const rows = ['a', 'middle', 'b'].map((id, index) => ({ id, session_id: 's', speaker_id: 'voice', role: 'candidate',
      role_confidence: 1, speaker_confirmed: true, text: id, start_ms: index * 2000, end_ms: index * 2000 + 1000, status: 'transcribed' }))
    const repository = new LiveInterviewSessionRepository({ async query(sql: string) {
      assert.ok(sql.startsWith('SELECT'))
      return { rows }
    } } as never)
    await assert.rejects(repository.correctUtteranceRole('a', ['a', 'b'], 'interviewer'), { code: 'INVALID_UTTERANCE_SEGMENTS', status: 400 })
  })
})
