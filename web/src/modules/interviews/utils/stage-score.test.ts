import { describe, expect, it } from 'vitest'
import type { ApiInterviewQuestion, StageWeights } from '../api/question-sheets'
import {
  STAGE_DEFAULT_WEIGHTS,
  aggregateQuestions,
  fromPercent,
  recordingScoreOf,
  scoreForTier,
  sheetScoresOf,
  stageScoreBreakdown,
  toPercent,
  weightsTotalPercent,
} from './stage-score'

function question(overrides: Partial<ApiInterviewQuestion> = {}): ApiInterviewQuestion {
  return {
    id: 'q1',
    seq: 1,
    question: '问题',
    dimension: '架构能力',
    category: 'technical',
    difficulty: 'hard',
    source: 'live_question',
    questionEventId: null,
    answerSegmentIds: [],
    answerText: '回答',
    tiers: [],
    aiTier: null,
    aiScore: null,
    aiRationale: null,
    aiEvidence: [],
    finalTier: null,
    finalScore: null,
    comment: null,
    scoredBy: null,
    scoredAt: null,
    ...overrides,
  }
}

const defaultWeights: StageWeights = { sheets: { hr_screen: 0.35, hiring_department: 0.35 }, recording: 0.3 }

describe('面试表汇总（与后端口径一致）', () => {
  it('只统计已打分题目，未打分不按 0 计', () => {
    const aggregate = aggregateQuestions([question({ id: 'a', finalScore: 90 }), question({ id: 'b', finalScore: 70 }), question({ id: 'c' })])
    expect(aggregate).toEqual({ score: 80, ratings: { 架构能力: 80 }, scoredCount: 2, totalCount: 3 })
  })

  it('没有任何打分时为 null，而不是 0', () => {
    expect(aggregateQuestions([question()]).score).toBeNull()
  })

  it('只有已提交/锁定的表计入阶段得分', () => {
    const scores = sheetScoresOf([
      { sheetType: 'hr_screen', status: 'submitted', questions: [question({ finalScore: 88 })] },
      { sheetType: 'hiring_department', status: 'scoring', questions: [question({ finalScore: 10 })] },
    ])
    expect(scores).toEqual({ hr_screen: 88 })
  })

  it('录音 AI 评分取题目级 AI 分的平均，取不到为 null', () => {
    expect(recordingScoreOf([{ questions: [question({ aiScore: 80 }), question({ aiScore: 71 })] }])).toBe(76)
    expect(recordingScoreOf([{ questions: [question()] }])).toBeNull()
  })
})

describe('阶段综合分公式（与后端 stageScoreBreakdown 同口径）', () => {
  it('按公式计算综合分并给出可展示算式', () => {
    const breakdown = stageScoreBreakdown('initial', { hr_screen: 82, hiring_department: 76 }, 78, defaultWeights)
    expect(breakdown.score).toBe(79)
    expect(breakdown.formula).toBe('82 × 0.35 + 76 × 0.35 + 78 × 0.3 = 79')
    expect(breakdown.notes).toEqual([])
  })

  it('面试官调权重后按新权重重算', () => {
    const breakdown = stageScoreBreakdown('initial', { hr_screen: 82, hiring_department: 76 }, 78, { sheets: { hr_screen: 0.5, hiring_department: 0.2 }, recording: 0.3 })
    expect(breakdown.formula).toBe('82 × 0.5 + 76 × 0.2 + 78 × 0.3 = 80')
  })

  it('缺失项不按 0 计：权重在剩余项之间归一', () => {
    const breakdown = stageScoreBreakdown('initial', { hr_screen: 80 }, null, defaultWeights)
    expect(breakdown.score).toBe(80)
    expect(breakdown.formula).toBe('80 × 1 = 80')
    expect(breakdown.notes.some((note) => note.includes('录音 AI 评分暂无分数'))).toBe(true)
    expect(breakdown.notes.some((note) => note.includes('归一'))).toBe(true)
  })

  it('复试三表 + 录音，全部缺失时不给分数', () => {
    const breakdown = stageScoreBreakdown('final', {}, null, STAGE_DEFAULT_WEIGHTS.final)
    expect(breakdown.score).toBeNull()
    expect(breakdown.formula).toBe('暂无可用于计算的分数')
    expect(breakdown.notes).toHaveLength(4)
  })
})

describe('权重编辑辅助', () => {
  it('百分比与小数互转', () => {
    expect(toPercent(0.35)).toBe(35)
    expect(toPercent(0.233)).toBe(23.3)
    expect(fromPercent(35)).toBe(0.35)
    expect(fromPercent(23.3)).toBe(0.233)
  })

  it('合计百分比用于校验是否为 100%', () => {
    expect(weightsTotalPercent(defaultWeights, 'initial')).toBe(100)
    expect(weightsTotalPercent({ sheets: { hr_screen: 0.5 }, recording: 0.3 }, 'initial')).toBe(80)
    expect(weightsTotalPercent(STAGE_DEFAULT_WEIGHTS.final, 'final')).toBe(100)
  })

  it('点档位：分数在区间内保留，否则取区间中值', () => {
    const tiers = [
      { tier: 'excellent' as const, min: 90, max: 100, description: '' },
      { tier: 'pass' as const, min: 70, max: 89, description: '' },
      { tier: 'below' as const, min: 0, max: 69, description: '' },
    ]
    expect(scoreForTier(tiers, 'pass', 82)).toBe(82)
    expect(scoreForTier(tiers, 'excellent', 82)).toBe(95)
    expect(scoreForTier(tiers, 'below', null)).toBe(35)
  })
})
