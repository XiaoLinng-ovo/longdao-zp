import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { STAGE_DEFAULT_WEIGHTS, aggregateQuestionSheet, resolveStageWeights, stageScoreBreakdown } from './question-sheet-service.js'
import type { InterviewQuestionRecord, InterviewQuestionSheetRecord } from './question-sheet-repository.js'

function question(overrides: Partial<InterviewQuestionRecord>): InterviewQuestionRecord {
  return {
    id: 'q1', seq: 1, question: '问题', dimension: '架构能力', category: 'technical', difficulty: 'hard',
    source: 'live_question', questionEventId: null, answerSegmentIds: [], answerText: '回答', tiers: [],
    aiTier: null, aiScore: null, aiRationale: null, aiEvidence: [],
    finalTier: null, finalScore: null, comment: null, scoredBy: null, scoredAt: null,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  }
}

function sheet(overrides: Partial<InterviewQuestionSheetRecord> = {}): InterviewQuestionSheetRecord {
  return {
    id: 'sheet-1', applicationId: 'app-1', stage: 'initial', sheetType: 'hr_screen', status: 'submitted',
    source: 'ai', generationModel: null, promptVersion: null, generationError: null, generationNotice: null,
    generatedBy: null, generatedAt: null, submittedAt: null, lockedAt: null,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z',
    questions: [],
    ...overrides,
  }
}

describe('面试表汇总', () => {
  it('只统计已打分的题目，未打分的题不按 0 计', () => {
    const aggregate = aggregateQuestionSheet(sheet({
      questions: [
        question({ id: 'a', finalScore: 90 }),
        question({ id: 'b', finalScore: 70 }),
        question({ id: 'c', finalScore: null }),
      ],
    }))
    assert.equal(aggregate.score, 80)
    assert.equal(aggregate.scoredCount, 2)
    assert.equal(aggregate.totalCount, 3)
    assert.deepEqual(aggregate.ratings, { 架构能力: 80 })
  })

  it('一张表都没打分时为 null，而不是 0', () => {
    const aggregate = aggregateQuestionSheet(sheet({ questions: [question({ finalScore: null })] }))
    assert.equal(aggregate.score, null)
    assert.deepEqual(aggregate.ratings, {})
  })
})

describe('阶段权重与公式', () => {
  it('默认权重：初试两表各 0.35 + 录音 0.30；复试三表合计 0.70 + 录音 0.30', () => {
    assert.deepEqual(STAGE_DEFAULT_WEIGHTS.initial, { sheets: { hr_screen: 0.35, hiring_department: 0.35 }, recording: 0.3 })
    const finalSum = Object.values(STAGE_DEFAULT_WEIGHTS.final.sheets).reduce((sum, value) => sum + value, 0) + STAGE_DEFAULT_WEIGHTS.final.recording
    assert.ok(Math.abs(finalSum - 1) <= 0.01)
  })

  it('按公式计算综合分，并给出可展示的算式', () => {
    const weights = resolveStageWeights('initial')
    const breakdown = stageScoreBreakdown('initial', { hr_screen: 82, hiring_department: 76 }, 78, weights)
    assert.equal(breakdown.score, 79)
    assert.equal(breakdown.formula, '82 × 0.35 + 76 × 0.35 + 78 × 0.3 = 79')
    assert.deepEqual(breakdown.notes, [])
  })

  it('缺失项不按 0 计：权重在剩余项之间归一，并说明原因', () => {
    const breakdown = stageScoreBreakdown('initial', { hr_screen: 80 }, null, resolveStageWeights('initial'))
    assert.equal(breakdown.score, 80)
    assert.equal(breakdown.formula, '80 × 1 = 80')
    assert.ok(breakdown.notes.some((note) => note.includes('录音 AI 评分暂无分数')))
    assert.ok(breakdown.notes.some((note) => note.includes('归一')))
  })

  it('全部缺失时不给分数', () => {
    const breakdown = stageScoreBreakdown('final', {}, null, resolveStageWeights('final'))
    assert.equal(breakdown.score, null)
    assert.equal(breakdown.formula, '暂无可用于计算的分数')
    assert.equal(breakdown.notes.length, 4)
  })

  it('保存的权重覆盖默认值，非法键被忽略', () => {
    const resolved = resolveStageWeights('initial', { sheets: { hr_screen: 0.5, business: 0.5 }, recording: 0.2 })
    assert.equal(resolved.sheets.hr_screen, 0.5)
    assert.equal(resolved.sheets.hiring_department, 0.35)
    assert.equal(resolved.recording, 0.2)
    assert.equal('business' in resolved.sheets, false)
  })
})
