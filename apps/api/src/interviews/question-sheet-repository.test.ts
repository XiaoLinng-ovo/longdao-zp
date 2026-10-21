import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { QuestionSheetRepository, type QuestionWriteInput } from './question-sheet-repository.js'

describe('修补面试表漏题', () => {
  for (const status of ['generating', 'submitted', 'locked']) {
    it(`${status}状态不补写也不删除题目`, async () => {
      const statements: string[] = []
      const client = { query: async (sql: string) => { statements.push(sql); return { rows: sql.includes('FOR UPDATE') ? [{ status }] : [] } }, release() {} }
      const repository = new QuestionSheetRepository({ connect: async () => client } as never)
      assert.equal(await repository.appendMissingQuestions('sheet-1', []), 0)
      assert.ok(!statements.some(sql => /INSERT|UPDATE interview_question_sheets SET|DELETE/.test(sql)))
    })
  }
  it('只追加缺失题，保留原题id、顺序、分数和备注；重复执行不重复写入', async () => {
    const original = { id: 'original-id', question: '原有问题', seq: 3, final_score: 88, comment: '人工备注' }
    const rows: Array<Record<string, unknown>> = [{ ...original }]
    const statements: string[] = []
    const client = {
      async query(sql: string, values: unknown[] = []) {
        statements.push(sql)
        if (sql.includes('FOR UPDATE')) return { rows: [{ status: 'scoring' }] }
        if (sql.startsWith('SELECT question, seq')) return { rows }
        if (sql.startsWith('INSERT INTO interview_questions')) {
          const row = { id: 'new-id', seq: values[1], question: values[2], source: values[6], question_event_id: values[7], answer_text: values[9], tiers: [], ai_evidence: [], created_at: '2026-10-16T00:00:00Z', updated_at: '2026-10-16T00:00:00Z' }
          rows.push(row)
          return { rows: [row] }
        }
        return { rows: [] }
      }, release() {},
    }
    const repository = new QuestionSheetRepository({ connect: async () => client } as never)
    const input: QuestionWriteInput[] = ['原有 问题', '遗漏问题', '遗漏问题'].map((question, index) => ({ seq: index + 1, question, source: 'ai_generated' }))
    assert.equal(await repository.appendMissingQuestions('sheet-1', input), 1)
    assert.deepEqual(rows[0], original)
    assert.equal(rows[1]!.seq, 4)
    assert.equal(await repository.appendMissingQuestions('sheet-1', input), 0)
    assert.equal(rows.length, 2)
    assert.ok(!statements.some(sql => sql.startsWith('DELETE') || sql.startsWith('UPDATE interview_questions')))
  })
})


describe('面试表实际对话来源', () => {
  it('按音频时间关联实际问题，参考题点击事件和异步写入时间不参与', async () => {
    let query = ''
    const row = (id: string, role: string, text: string, start: number, end = start + 1000, session = 's') => ({
      id, role, text, start_ms: start, end_ms: end, role_confidence: .95, session_id: session, speaker_id: role, status: 'transcribed', interview_id: 'i' })
    const rows = [row('a', 'candidate', '我完成了接口开发。', 2000), row('q', 'interviewer', '请介绍实际项目。', 0),
      row('q2', 'interviewer', '需要回学校吗？', 6000), row('a2', 'candidate', '需要两天。', 8000),
      row('orphan', 'candidate', '我主动补充项目压测经验。', 0, 1000, 's2')]
    const repository = new QuestionSheetRepository({ query: async (sql: string) => { query = sql; return { rows } } } as never)
    const result = await repository.listQaPairs('app', 'initial')
    assert.doesNotMatch(query, /question_events|created_at/)
    assert.match(query, /a.organization_id = i.organization_id/)
    assert.equal(result.length, 2)
    assert.equal(result[0]!.question, '请介绍实际项目。')
    assert.equal(result[0]!.answerText, '我完成了接口开发。')
    assert.equal(result[1]!.answerText, '需要两天。')
    assert.equal(result[0]!.source, 'live_question')
    assert.equal(result[0]!.questionEventId, null)
  })
  it('不把与未知说话人重叠的发言作为题目回答证据', async () => {
    const rows = [
      { id: 'q', role: 'interviewer', text: '介绍项目。', start_ms: 0, end_ms: 1000 },
      { id: 'a', role: 'candidate', text: '我负责开发。', start_ms: 2000, end_ms: 4000 },
      { id: 'u', role: 'unknown', text: '混合声音。', start_ms: 3000, end_ms: 4500 },
    ].map(row => ({ ...row, role_confidence: .95, session_id: 's', interview_id: 'i', speaker_id: row.role, status: 'transcribed' }))
    const repository = new QuestionSheetRepository({ query: async () => ({ rows }) } as never)
    const pairs = await repository.listQaPairs('app', 'initial')
    assert.equal(pairs[0]!.answerText, '')
    assert.deepEqual(pairs[0]!.answerSegmentIds, [])
  })
})
