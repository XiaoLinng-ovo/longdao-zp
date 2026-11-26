import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { QuestionSheetConflictError, QuestionSheetRepository, type QuestionWriteInput } from './question-sheet-repository.js'
import { ASSESSMENT_RUBRICS, ASSESSMENT_RUBRIC_VERSION, tiersForCriterion } from './question-sheet-rubrics.js'

describe('固定考察点人工分数边界', () => {
  for (const score of [0, 10, 11, 12, 13]) {
    it('用人部门人工分数 ' + score + (score > 12 ? ' 拒绝保存' : ' 可保存'), async () => {
      const statements: string[] = []
      const criterion = ASSESSMENT_RUBRICS.department[0]!
      const client = {
        async query(sql: string, values: unknown[] = []) {
          statements.push(sql)
          if (sql.includes('FOR UPDATE')) return { rows: [{ status: 'scoring' }] }
          if (sql.startsWith('SELECT category, tiers')) return { rows: [{ category: 'rubric:department:results', tiers: tiersForCriterion('department', criterion) }] }
          if (sql.startsWith('UPDATE interview_questions')) return { rows: [{ id: 'question-1', seq: 1, question: criterion.title,
            category: 'rubric:department:results', source: 'manual', final_score: values[1],
            created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' }] }
          return { rows: [] }
        },
        release() {},
      }
      const repository = new QuestionSheetRepository({ connect: async () => client } as never)
      const save = () => repository.patchQuestion('sheet-1', 'question-1', { finalScore: score }, 'user-1')
      if (score > 12) {
        await assert.rejects(save(), QuestionSheetConflictError)
        assert.ok(!statements.some(sql => sql.startsWith('UPDATE interview_questions')))
        assert.ok(statements.includes('ROLLBACK'))
      } else {
        const result = await save()
        assert.equal(result.finalScore, score)
        assert.equal(result.maxScore, 12)
        assert.ok(statements.includes('COMMIT'))
      }
    })
  }
})

describe('即时载入人工考察点', () => {
  const template: QuestionWriteInput[] = ASSESSMENT_RUBRICS.hr.map((item, index) => ({
    seq: index + 1, question: item.title, dimension: item.title, category: 'rubric:hr:' + item.id,
    source: 'manual', tiers: tiersForCriterion('hr', item),
  }))

  function setup(status = 'draft', saved: Record<string, unknown> = {}, failInsert = false) {
    const statements: Array<{ sql: string; values: unknown[] }> = []
    const row = { id: 'sheet-1', application_id: 'app-1', stage: 'initial', sheet_type: 'hr_screen', status,
      source: 'ai', prompt_version: null as string | null, created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' }
    const original = { id: 'old-id', seq: 1, question: '旧面试问题', source: 'ai_generated',
      created_at: row.created_at, updated_at: row.updated_at, ...saved }
    let rows: Array<Record<string, unknown>> = [original]
    const client = {
      async query(sql: string, values: unknown[] = []) {
        statements.push({ sql, values })
        if (sql === 'ROLLBACK') rows = [original]
        if (sql.includes('FROM interview_question_sheets')) return { rows: [row] }
        if (sql.startsWith('SELECT') && sql.includes('FROM interview_questions')) return { rows }
        if (sql.startsWith('DELETE FROM interview_questions')) rows = []
        if (sql.startsWith('INSERT INTO interview_questions')) {
          if (failInsert) throw new Error('insert failed')
          const item = { id: 'new-' + values[1], seq: values[1], question: values[2], dimension: values[3],
            category: values[4], source: values[6], tiers: JSON.parse(String(values[10])),
            created_at: row.created_at, updated_at: row.updated_at }
          rows.push(item)
          return { rows: [item] }
        }
        if (sql.startsWith('UPDATE interview_question_sheets')) { row.status = 'scoring'; row.prompt_version = String(values[1]) }
        return { rows: [] }
      },
      release() { statements.push({ sql: 'release', values: [] }) },
    }
    const repository = new QuestionSheetRepository({ connect: async () => client } as never)
    repository.ensure = async () => ({ id: row.id }) as never
    const load = () => repository.loadAssessmentRubric('app-1', 'initial', 'hr_screen', 'user-1', template, 'manual-rubric-v1')
    return { repository, statements, load, row, rows: () => rows }
  }

  for (const status of ['draft', 'scoring']) {
    it(status + '无人工结果时在同一事务内载入五项标准并进入评分状态', async () => {
      const { load, statements, row, rows } = setup(status)
      await load()
      const sql = statements.map(item => item.sql)
      assert.ok(sql.findIndex(item => item.includes('FOR UPDATE')) < sql.findIndex(item => item.startsWith('DELETE')))
      assert.equal(rows().length, 5)
      assert.ok(rows().every(item => String(item.category).startsWith('rubric:hr:')))
      assert.equal(row.status, 'scoring')
      assert.ok(sql.includes('COMMIT'))
      assert.ok(!sql.some(item => item.includes("status = 'generating'")))
      const update = statements.find(item => item.sql.startsWith('UPDATE'))!
      assert.match(update.sql, /source = 'manual'/)
      assert.match(update.sql, /generation_error = NULL, generation_notice = NULL/)
      assert.deepEqual(update.values, ['sheet-1', 'manual-rubric-v1', 'user-1'])
      assert.equal(sql.at(-1), 'release')
    })
  }

  for (const [status, saved] of [
    ['submitted', {}], ['locked', {}], ['scoring', { final_score: 0 }],
    ['scoring', { final_score: 7 }], ['draft', { comment: '已记录的人工评语' }],
    ['scoring', { final_tier: 'pass' }], ['draft', { comment: '' }],
  ] as const) {
    it(status + JSON.stringify(saved) + '禁止删除或覆盖原记录', async () => {
      const { load, statements, rows } = setup(status, saved)
      await assert.rejects(load(), QuestionSheetConflictError)
      assert.equal(rows()[0]!.id, 'old-id')
      assert.equal(statements.filter(item => /^(DELETE|INSERT|UPDATE)/.test(item.sql)).length, 0)
      assert.ok(statements.some(item => item.sql === 'ROLLBACK'))
    })
  }

  it('生成中的并发请求不重复替换记录', async () => {
    const { load, statements } = setup('generating')
    await load()
    assert.equal(statements.filter(item => /^(DELETE|INSERT|UPDATE)/.test(item.sql)).length, 0)
  })

  it('旧版未评分表原位升级为固定模板，重复读取不再替换', async () => {
    const { repository, row, rows } = setup('scoring')
    repository.ensure = async () => { throw new Error('升级不得新建面试表') }
    assert.equal(await repository.upgradeAssessmentRubric('sheet-1', template, ASSESSMENT_RUBRIC_VERSION), true)
    assert.equal(row.prompt_version, ASSESSMENT_RUBRIC_VERSION)
    assert.equal(rows().length, 5)
    const ids = rows().map(item => item.id)
    assert.equal(await repository.upgradeAssessmentRubric('sheet-1', template, ASSESSMENT_RUBRIC_VERSION), false)
    assert.deepEqual(rows().map(item => item.id), ids)
  })

  for (const [status, saved] of [
    ['generating', {}], ['submitted', {}], ['locked', {}], ['scoring', { final_score: 0 }],
    ['scoring', { final_tier: 'pass' }], ['draft', { comment: '' }],
  ] as const) {
    it('自动升级保护已有状态和人工记录：' + status + JSON.stringify(saved), async () => {
      const { repository, statements, rows } = setup(status, saved)
      assert.equal(await repository.upgradeAssessmentRubric('sheet-1', template, ASSESSMENT_RUBRIC_VERSION), false)
      assert.equal(rows()[0]!.id, 'old-id')
      assert.ok(!statements.some(item => /^(DELETE|INSERT|UPDATE)/.test(item.sql)))
    })
  }

  it('任一考察点写入失败时回滚，保留原表', async () => {
    const { load, statements, rows } = setup('scoring', {}, true)
    await assert.rejects(load(), /insert failed/)
    assert.equal(rows()[0]!.id, 'old-id')
    assert.ok(statements.some(item => item.sql === 'ROLLBACK'))
    assert.ok(!statements.some(item => item.sql === 'COMMIT'))
  })
})

describe('重新载入考察点', () => {
  function setup(status: string, saved = false) {
    const statements: string[] = []
    const row = { id: 'sheet-1', application_id: 'app-1', stage: 'initial', sheet_type: 'hr_screen', status,
      source: 'manual', created_at: '2026-10-22T00:00:00Z', updated_at: '2026-10-22T00:00:00Z' }
    const client = {
      async query(sql: string) {
        statements.push(sql)
        if (sql.includes('FOR UPDATE')) return { rows: [row] }
        if (sql.startsWith('UPDATE interview_question_sheets')) {
          assert.match(sql, /status NOT IN \('locked', 'submitted'\)/)
          assert.match(sql, /q.final_score IS NOT NULL OR q.comment IS NOT NULL/)
          if (saved || row.status === 'submitted' || row.status === 'locked') return { rows: [] }
          row.status = 'generating'
          return { rows: [row] }
        }
        if (sql.includes('FROM interview_question_sheets')) return { rows: [row] }
        return { rows: [] }
      },
      release() { statements.push('release') },
    }
    const repository = new QuestionSheetRepository({ connect: async () => client } as never)
    repository.ensure = async () => ({ ...row, questions: [] }) as never
    return { repository, statements }
  }

  for (const status of ['draft', 'scoring']) {
    it(`${status} 无人工结果时允许载入，先锁表再检查并更新`, async () => {
      const { repository, statements } = setup(status)
      const result = await repository.markGenerating('app-1', 'initial', 'hr_screen', 'user-1', 'rubric', 'v1')
      assert.equal(result.status, 'generating')
      const lock = statements.findIndex(sql => sql.includes('FOR UPDATE'))
      const update = statements.findIndex(sql => sql.startsWith('UPDATE interview_question_sheets'))
      assert.ok(lock > 0 && update > lock)
      assert.ok(statements.includes('COMMIT'))
      assert.equal(statements.at(-1), 'release')
    })
  }

  for (const [status, saved] of [['submitted', false], ['locked', false], ['scoring', true]] as const) {
    it(`${status} 已提交、锁定或存在人工结果时拒绝覆盖`, async () => {
      const { repository, statements } = setup(status, saved)
      await assert.rejects(repository.markGenerating('app-1', 'initial', 'hr_screen', 'user-1', 'rubric', 'v1'), QuestionSheetConflictError)
      assert.ok(statements.includes('ROLLBACK'))
      assert.equal(statements.at(-1), 'release')
    })
  }

  it('并发重复请求遇到生成中状态时不重置任务', async () => {
    const { repository, statements } = setup('generating')
    const result = await repository.markGenerating('app-1', 'initial', 'hr_screen', 'user-1', 'rubric', 'v1')
    assert.equal(result.status, 'generating')
    assert.ok(!statements.some(sql => sql.startsWith('UPDATE')))
    assert.ok(statements.includes('COMMIT'))
  })
})

describe('首页面试评分汇总', () => {
  it('空范围不查询数据库', async () => {
    const repository = new QuestionSheetRepository({ query: () => { throw new Error('unexpected query') } } as never)
    assert.deepEqual(await repository.listDashboardReviews([]), [])
  })
  it('只查询授权范围，统计人工最终分且保留零分', async () => {
    const sheets = [{ sheetType: 'hr_screen', status: 'scoring', totalQuestions: 3, scoredQuestions: 1 }]
    const repository = new QuestionSheetRepository({ query: async (sql: string, values: unknown[]) => {
      assert.deepEqual(values, [['scoped-interview']])
      assert.match(sql, /i.id = ANY\(\$1::uuid\[\]\)/)
      assert.match(sql, /app.organization_id = i.organization_id/)
      assert.match(sql, /COUNT\(final_score\)/)
      assert.doesNotMatch(sql, /COUNT\(ai_score\)|final_score > 0/)
      return { rows: [{ interview_id: 'scoped-interview', stage: 'initial', has_completed_live: true, decision: null, sheets }] }
    } } as never)
    assert.deepEqual(await repository.listDashboardReviews(['scoped-interview']), [{
      interviewId: 'scoped-interview', stage: 'initial', hasCompletedLive: true, decision: null, sheets,
    }])
  })
})

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
