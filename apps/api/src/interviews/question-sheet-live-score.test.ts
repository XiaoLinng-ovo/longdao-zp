import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import { QuestionSheetRepository } from './question-sheet-repository.js'

describe('实时面试阶段录音评分', () => {
  it('只采用新版完整对话总结，禁止使用局部逐段评分回退', async () => {
    let sql = ''
    let values: unknown[] = []
    const pool = {
      query: async (statement: string, params: unknown[]) => {
        sql = statement
        values = params
        return { rows: [{ stage: 'initial', score: '78' }] }
      },
    } as unknown as Pool
    const repository = new QuestionSheetRepository(pool)

    const scores = await repository.listCompletedLiveRecordingScores('application-1')

    assert.deepEqual(scores, [{ stage: 'initial', score: 78 }])
    assert.deepEqual(values, ['application-1'])
    assert.match(sql, /live\.status = 'completed'/)
    assert.match(sql, /live\.summary_status = 'ready'/)
    assert.match(sql, /summary_report->>'version' = 'whole-dialogue-v2'/)
    assert.doesNotMatch(sql, /interview_live_analyses|legacy|summary_status = 'none'/)
    assert.match(sql, /summary_report->>'overallScore'/)
    assert.match(sql, /i\.status <> 'cancelled'/)
  })

  it('忽略无效阶段或无效分数行', async () => {
    const pool = {
      query: async () => ({ rows: [
        { stage: 'unknown', score: '80' },
        { stage: 'final', score: 'NaN' },
      ] }),
    } as unknown as Pool
    const repository = new QuestionSheetRepository(pool)
    assert.deepEqual(await repository.listCompletedLiveRecordingScores('application-1'), [])
  })
})
