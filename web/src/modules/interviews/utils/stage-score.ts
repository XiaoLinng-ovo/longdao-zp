import {
  SHEET_TYPE_LABEL,
  STAGE_SHEET_TYPES,
  TIER_LABEL,
  type ApiInterviewQuestion,
  type InterviewStage,
  type QuestionSheetAggregate,
  type QuestionTier,
  type QuestionTierName,
  type StageScoreBreakdown,
  type StageScoreItem,
  type StageWeights,
} from '../api/question-sheets'

/** 阶段默认权重，与后端 STAGE_DEFAULT_WEIGHTS 一致：初试 0.35 + 0.35 + 录音 0.30，复试三表各约 0.233 + 录音 0.30。 */
export const STAGE_DEFAULT_WEIGHTS: Record<InterviewStage, StageWeights> = {
  initial: { sheets: { hr_screen: 0.35, hiring_department: 0.35 }, recording: 0.3 },
  final: { sheets: { business: 0.233, hr: 0.233, boss: 0.234 }, recording: 0.3 },
}

export function cloneWeights(weights: StageWeights): StageWeights {
  return { sheets: { ...weights.sheets }, recording: weights.recording }
}

/** 提交/锁定后的表才参与阶段综合分，与后端口径一致。 */
export function isScoreableSheet(status: string): boolean {
  return status === 'submitted' || status === 'locked'
}

/** 表内得分 = 已打分题目的算术平均；未打分的题不参与，也不按 0 计。 */
export function aggregateQuestions(questions: ApiInterviewQuestion[]): QuestionSheetAggregate {
  const scored = questions.filter((question) => typeof question.finalScore === 'number')
  const buckets = new Map<string, number[]>()
  for (const question of scored) {
    const key = question.dimension?.trim() || question.category?.trim() || '综合能力'
    buckets.set(key, [...(buckets.get(key) ?? []), question.finalScore as number])
  }
  const average = (values: number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  const ratings = Object.fromEntries([...buckets].map(([key, values]) => [key, average(values)]))
  return {
    score: scored.length ? average(scored.map((question) => question.finalScore as number)) : null,
    ratings,
    scoredCount: scored.length,
    totalCount: questions.length,
  }
}


/** 各表得分：只统计已提交/锁定的表。 */
export function sheetScoresOf(sheets: Array<{ sheetType: string; status: string; questions: ApiInterviewQuestion[] }>): Record<string, number> {
  const scores: Record<string, number> = {}
  for (const sheet of sheets) {
    if (!isScoreableSheet(sheet.status)) continue
    const score = aggregateQuestions(sheet.questions).score
    if (typeof score === 'number') scores[sheet.sheetType] = score
  }
  return scores
}

/**
 * 阶段综合分 = Σ(各表得分 × 表权重) + 录音 AI 评分 × 录音权重。
 * 缺失项不按 0 计：不参与计算，权重在剩余项之间归一，并在 notes 说明（与后端 stageScoreBreakdown 同口径）。
 */
export function stageScoreBreakdown(
  stage: InterviewStage,
  sheetScores: Record<string, number>,
  recordingScore: number | null,
  weights: StageWeights,
): StageScoreBreakdown {
  const items: StageScoreItem[] = STAGE_SHEET_TYPES[stage].map((sheetType) => ({
    key: sheetType,
    label: SHEET_TYPE_LABEL[sheetType],
    score: typeof sheetScores[sheetType] === 'number' ? sheetScores[sheetType]! : null,
    weight: weights.sheets[sheetType] ?? 0,
    effectiveWeight: 0,
    contribution: null,
  }))
  items.push({ key: 'recording', label: '录音 AI 评分', score: recordingScore, weight: weights.recording, effectiveWeight: 0, contribution: null })

  const notes = items.filter((item) => item.score === null).map((item) => `${item.label}暂无分数`)
  const totalWeight = items.filter((item) => item.score !== null).reduce((sum, item) => sum + item.weight, 0)
  if (!totalWeight) return { formula: '暂无可用于计算的分数', items, score: null, notes }

  let total = 0
  for (const item of items) {
    if (item.score === null) continue
    item.effectiveWeight = Math.round((item.weight / totalWeight) * 1000) / 1000
    item.contribution = Math.round(item.score * item.effectiveWeight * 100) / 100
    total += item.contribution
  }
  const score = Math.round(total)
  const formula = `${items.filter((item) => item.score !== null).map((item) => `${item.score} × ${item.effectiveWeight}`).join(' + ')} = ${score}`
  if (notes.length) notes.push('缺失项不参与计算，权重已在剩余项之间归一')
  return { formula, items, score, notes }
}

/** 权重合计与合法性：保存权重需要合计为 100%。 */
export function weightsTotal(weights: StageWeights, stage: InterviewStage): number {
  const sheetTotal = STAGE_SHEET_TYPES[stage].reduce((sum, sheetType) => sum + (weights.sheets[sheetType] ?? 0), 0)
  return Math.round((sheetTotal + weights.recording) * 1000) / 1000
}

export function weightsTotalPercent(weights: StageWeights, stage: InterviewStage): number {
  return Math.round(weightsTotal(weights, stage) * 100)
}

export function toPercent(value: number): number {
  return Math.round(value * 1000) / 10
}

export function fromPercent(value: number): number {
  return Math.round(value * 10) / 1000
}

/** 点档位时的分数：已填分数落在区间内则保留，否则取区间中值。 */
export function scoreForTier(tiers: QuestionTier[], tier: QuestionTierName, current: number | null): number {
  const target = tiers.find((item) => item.tier === tier)
  if (!target) return current ?? 0
  if (typeof current === 'number' && current >= target.min && current <= target.max) return current
  return Math.round((target.min + target.max) / 2)
}

export function tierRangeText(tiers: QuestionTier[], tier: QuestionTierName): string {
  const target = tiers.find((item) => item.tier === tier)
  return target ? `${TIER_LABEL[tier]} ${target.min}-${target.max}` : TIER_LABEL[tier]
}
