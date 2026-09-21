import {
  QuestionSheetRepository,
  type InterviewQuestionRecord,
  type InterviewQuestionSheetRecord,
  type InterviewStage,
  type InterviewStageReviewRecord,
  type QuestionScorePatch,
  type QuestionSheetType,
  type QuestionTier,
  type QuestionWriteInput,
  type StageDecision,
  type StageWeights,
} from './question-sheet-repository.js'
import {
  DEFAULT_QUESTION_TIERS,
  QUESTION_SHEET_PROMPT_VERSION,
  QuestionSheetGenerationError,
  createQuestionSheetGenerator,
  createStageReviewGenerator,
  loadQuestionSheetGeneratorConfig,
  type GeneratedSheetQuestion,
  type QuestionSheetGenerationInput,
  type QuestionSheetGeneratorConfig,
  type StageReviewInput,
} from './question-sheet-generator.js'

/** 两个阶段各自的表类型：初试 2 张，复试 3 张。 */
export const STAGE_SHEET_TYPES: Record<InterviewStage, QuestionSheetType[]> = {
  initial: ['hr_screen', 'hiring_department'],
  final: ['business', 'hr', 'boss'],
}

export const SHEET_TYPE_LABEL: Record<QuestionSheetType, string> = {
  hr_screen: '人事面试表',
  hiring_department: '用人部门面试表',
  business: '业务面试表',
  hr: 'HR 面试表',
  boss: 'BOSS 面试表',
}

/** 初试综合分权重：人工面试表 70%，录音 AI 评分 30%。 */
/** 阶段默认权重（和为 1）：初试两张表各 0.35 + 录音 0.30；复试三张表合计 0.70 + 录音 0.30。 */
export const STAGE_DEFAULT_WEIGHTS: Record<InterviewStage, StageWeights> = {
  initial: { sheets: { hr_screen: 0.35, hiring_department: 0.35 }, recording: 0.3 },
  final: { sheets: { business: 0.233, hr: 0.233, boss: 0.234 }, recording: 0.3 },
}

export function resolveStageWeights(stage: InterviewStage, stored?: StageWeights | null): StageWeights {
  const defaults = STAGE_DEFAULT_WEIGHTS[stage]
  const sheets = { ...defaults.sheets }
  let recording = defaults.recording
  if (stored && Object.keys(stored.sheets).length) {
    for (const [key, value] of Object.entries(stored.sheets)) {
      if (key in defaults.sheets && Number.isFinite(value) && value >= 0) sheets[key] = value
    }
    if (Number.isFinite(stored.recording) && stored.recording >= 0) recording = stored.recording
  }
  return { sheets, recording }
}

export interface StageScoreItem { key: string; label: string; score: number | null; weight: number; effectiveWeight: number; contribution: number | null }
export interface StageScoreBreakdown { formula: string; items: StageScoreItem[]; score: number | null; notes: string[] }

/**
 * 阶段综合分 = Σ(各表得分 × 表权重) + 录音 AI 评分 × 录音权重。
 * 缺失项不按 0 计：不参与计算，权重在剩余项之间归一，并在 notes 里说明。
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

export interface QuestionSheetAggregate {
  /** 已打分题目的算术平均；没有打分的题为 null（不按 0 计）。 */
  score: number | null
  /** 按考察维度分组的平均分。 */
  ratings: Record<string, number>
  scoredCount: number
  totalCount: number
}

export interface ApplicationSheetView extends InterviewQuestionSheetRecord {
  aggregate: QuestionSheetAggregate
}

export interface ApplicationQuestionSheetsView {
  applicationId: string
  sheets: ApplicationSheetView[]
  reviews: InterviewStageReviewRecord[]
  /** 两个阶段的权重与公式拆解，供页面直接展示「各表得分 × 权重 = 综合分」。 */
  stages: Array<{ stage: InterviewStage; weights: StageWeights; breakdown: StageScoreBreakdown }>
}

export function aggregateQuestionSheet(sheet: InterviewQuestionSheetRecord): QuestionSheetAggregate {
  const scored = sheet.questions.filter((question) => typeof question.finalScore === 'number')
  const buckets = new Map<string, number[]>()
  for (const question of scored) {
    const key = question.dimension?.trim() || question.category?.trim() || '综合能力'
    buckets.set(key, [...(buckets.get(key) ?? []), question.finalScore as number])
  }
  const ratings = Object.fromEntries([...buckets].map(([key, values]) => [key, Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)]))
  const score = scored.length ? Math.round(scored.reduce((sum, question) => sum + (question.finalScore as number), 0) / scored.length) : null
  return { score, ratings, scoredCount: scored.length, totalCount: sheet.questions.length }
}

/** 录音 AI 评分：问题级 AI 分数的平均，取不到则为 null（不按 0 计）。 */
export function recordingScoreOf(sheets: InterviewQuestionSheetRecord[]): number | null {
  const scores = sheets.flatMap((sheet) => sheet.questions.map((question) => question.aiScore)).filter((value): value is number => typeof value === 'number')
  return scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null
}

export interface PendingGenerationResult { processed: boolean; applicationId?: string; failed?: string }

export class QuestionSheetService {
  constructor(
    private readonly repository: QuestionSheetRepository,
    private readonly dependencies: {
      fetchImpl?: typeof fetch
      logger?: Pick<Console, 'error' | 'warn' | 'log'>
      /** 测试注入：避免真实模型调用。 */
      createGenerator?: (config: QuestionSheetGeneratorConfig) => ReturnType<typeof createQuestionSheetGenerator>
      createStageReview?: (config: QuestionSheetGeneratorConfig) => ReturnType<typeof createStageReviewGenerator>
    } = {},
  ) {}

  async getApplicationView(applicationId: string): Promise<ApplicationQuestionSheetsView> {
    const { sheets, reviews } = await this.repository.listForApplication(applicationId)
    const stages = (Object.keys(STAGE_SHEET_TYPES) as InterviewStage[]).map((stage) => {
      const submitted = sheets.filter((sheet) => sheet.stage === stage && (sheet.status === 'submitted' || sheet.status === 'locked'))
      const sheetScores: Record<string, number> = {}
      for (const sheet of submitted) {
        const score = aggregateQuestionSheet(sheet).score
        if (typeof score === 'number') sheetScores[sheet.sheetType] = score
      }
      const weights = resolveStageWeights(stage, reviews.find((review) => review.stage === stage)?.weights)
      return { stage, weights, breakdown: stageScoreBreakdown(stage, sheetScores, recordingScoreOf(submitted), weights) }
    })
    return { applicationId, sheets: sheets.map((sheet) => ({ ...sheet, aggregate: aggregateQuestionSheet(sheet) })), reviews, stages }
  }

  /** 读取指定表；不存在时抛错，避免调用方各自处理。 */
  async requireSheet(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType): Promise<InterviewQuestionSheetRecord> {
    const sheet = await this.repository.find(applicationId, stage, sheetType)
    if (!sheet) throw new QuestionSheetGenerationError('INVALID_INPUT', '面试表还不存在，请先生成或手工创建。')
    return sheet
  }

  /** 生成或重新生成某张表：置为 generating，由后台轮询真正执行。 */
  async requestGeneration(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType, actorId: string): Promise<ApplicationQuestionSheetsView> {
    if (!STAGE_SHEET_TYPES[stage].includes(sheetType)) throw new QuestionSheetGenerationError('INVALID_INPUT', `${stage} 阶段不支持该面试表类型：${sheetType}`)
    const model = process.env.OPENAI_MODEL?.trim() || 'unconfigured'
    await this.repository.markGenerating(applicationId, stage, sheetType, actorId, model, QUESTION_SHEET_PROMPT_VERSION)
    return this.getApplicationView(applicationId)
  }

  /**
   * 领取并处理一张待生成的问题表。
   * 未配置模型时降级：仍按问答生成题目与三级区间，但不写任何 AI 分，并把原因记进 generation_notice。
   */
  async processPendingGeneration(): Promise<PendingGenerationResult> {
    const claimed = await this.repository.claimPendingGeneration()
    if (!claimed) return { processed: false }
    const { sheetId, applicationId, stage } = claimed
    try {
      const pairs = await this.repository.listQaPairs(applicationId, stage)
      if (!pairs.length) throw new QuestionSheetGenerationError('INVALID_INPUT', '该阶段还没有问答记录，无法生成面试表。')
      const context = await this.repository.getApplicationJobContext(applicationId)
      const built = await this.buildQuestions(pairs, context, stage)
      await this.repository.replaceQuestions(sheetId, built.questions, { model: built.model, promptVersion: QUESTION_SHEET_PROMPT_VERSION })
      if (built.notice) await this.repository.markGenerationNotice(sheetId, built.notice)
      return { processed: true, applicationId }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      await this.repository.markGenerationFailed(sheetId, message)
      this.dependencies.logger?.error?.(`[question-sheet] generation failed: ${message}`)
      return { processed: true, applicationId, failed: message }
    }
  }

  async patchQuestion(sheetId: string, questionId: string, patch: QuestionScorePatch, actorId: string): Promise<InterviewQuestionRecord> {
    return this.repository.patchQuestion(sheetId, questionId, patch, actorId)
  }

  async addManualQuestion(sheetId: string, input: { question: string; dimension?: string | null; answerText?: string | null; tiers?: QuestionTier[] }): Promise<InterviewQuestionRecord> {
    return this.repository.addManualQuestion(sheetId, { ...input, tiers: input.tiers ?? DEFAULT_QUESTION_TIERS.map((tier) => ({ ...tier })) })
  }

  async deleteQuestion(sheetId: string, questionId: string): Promise<void> {
    return this.repository.deleteQuestion(sheetId, questionId)
  }

  /** 提交某张表；该阶段所有表都提交后自动生成阶段综合建议。 */
  async submit(sheetId: string, actorId: string): Promise<{ sheet: InterviewQuestionSheetRecord; aggregate: QuestionSheetAggregate; stageReview: InterviewStageReviewRecord | null }> {
    const sheet = await this.repository.submit(sheetId, actorId)
    const stageReview = await this.buildStageReview(sheet.applicationId, sheet.stage)
    return { sheet, aggregate: aggregateQuestionSheet(sheet), stageReview }
  }

  async lock(sheetId: string, actorId: string): Promise<{ sheet: InterviewQuestionSheetRecord; aggregate: QuestionSheetAggregate }> {
    const sheet = await this.repository.lock(sheetId, actorId)
    return { sheet, aggregate: aggregateQuestionSheet(sheet) }
  }

  /** 人工确认阶段结论：能否进复试、是否录用都由人落，AI 不写 decision。 */
  async recordDecision(applicationId: string, stage: InterviewStage, decision: StageDecision, actorId: string): Promise<InterviewStageReviewRecord> {
    const allowed: Record<InterviewStage, StageDecision[]> = { initial: ['advanced', 'rejected', 'hold'], final: ['hired', 'rejected', 'hold'] }
    if (!allowed[stage].includes(decision)) throw new QuestionSheetGenerationError('INVALID_INPUT', `${stage} 阶段不支持该结论：${decision}`)
    return this.repository.recordStageDecision(applicationId, stage, decision, actorId)
  }

  /** 阶段内所有表提交后合成阶段结论：分数走可调权重的公式，复试另请模型给出录取建议。 */
  async buildStageReview(applicationId: string, stage: InterviewStage): Promise<InterviewStageReviewRecord | null> {
    const { sheets, reviews } = await this.repository.listForApplication(applicationId)
    const expected = STAGE_SHEET_TYPES[stage]
    const submitted = sheets.filter((sheet) => sheet.stage === stage && (sheet.status === 'submitted' || sheet.status === 'locked'))
    if (!expected.every((type) => submitted.some((sheet) => sheet.sheetType === type))) return null

    const sheetScores: Record<string, number> = {}
    for (const sheet of submitted) {
      const score = aggregateQuestionSheet(sheet).score
      if (typeof score === 'number') sheetScores[sheet.sheetType] = score
    }
    const recordingScore = recordingScoreOf(submitted)
    const weights = resolveStageWeights(stage, reviews.find((review) => review.stage === stage)?.weights)
    const breakdown = stageScoreBreakdown(stage, sheetScores, recordingScore, weights)
    const aiScore = breakdown.score

    if (stage === 'initial') {
      return this.repository.upsertStageReview(applicationId, stage, {
        sheetScores,
        weights,
        recordingScore,
        aiScore,
        aiRecommendation: aiScore === null ? null : aiScore >= 70 ? 'yes' : aiScore >= 60 ? 'mixed' : 'no',
        aiRationale: aiScore === null
          ? '面试表与录音都没有可用分数，无法给出初试建议。'
          : `初试综合（${breakdown.formula}）；是否进入复试由人确认。`,
        aiEvidence: submitted.flatMap((sheet) => sheet.questions.flatMap((question) => question.aiEvidence)).slice(0, 8),
      })
    }

    // 复试：分数同样走公式，另外请模型综合三张表与录音证据给出录取建议；模型不可用时只落分数与原因。
    const input: StageReviewInput = {
      stage,
      candidateName: '',
      jobTitle: '',
      requirements: [],
      sheetSummaries: submitted.map((sheet) => {
        const aggregate = aggregateQuestionSheet(sheet)
        return {
          sheetType: SHEET_TYPE_LABEL[sheet.sheetType],
          score: aggregate.score,
          ratings: aggregate.ratings,
          questions: sheet.questions.map((question) => ({ question: question.question, finalScore: question.finalScore, comment: question.comment, aiScore: question.aiScore, aiEvidence: question.aiEvidence })),
        }
      }),
      recordingScore,
    }
    try {
      const config = loadQuestionSheetGeneratorConfig()
      const generator = this.dependencies.createStageReview
        ? this.dependencies.createStageReview(config)
        : createStageReviewGenerator(config, this.dependencies.fetchImpl ?? fetch)
      const reviewed = await generator.review(input)
      return this.repository.upsertStageReview(applicationId, stage, {
        sheetScores, weights, recordingScore, aiScore,
        aiRecommendation: reviewed.recommendation, aiRationale: reviewed.rationale, aiEvidence: reviewed.evidence,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this.dependencies.logger?.error?.(`[question-sheet] stage review failed: ${message}`)
      return this.repository.upsertStageReview(applicationId, stage, {
        sheetScores, weights, recordingScore, aiScore,
        aiRecommendation: null, aiRationale: `复试综合建议生成失败：${message}`, aiEvidence: [],
      })
    }
  }

  /**
   * 调整阶段权重并立即重算综合分。
   * 校验：只允许该阶段已有的表类型，全部非负，合计为 1（容差 0.01）；调整留痕。
   */
  async updateStageWeights(applicationId: string, stage: InterviewStage, next: StageWeights, actorId: string): Promise<{ review: InterviewStageReviewRecord; breakdown: StageScoreBreakdown }> {
    const allowed = STAGE_SHEET_TYPES[stage]
    const unknown = Object.keys(next.sheets).filter((key) => !allowed.includes(key as QuestionSheetType))
    if (unknown.length) throw new QuestionSheetGenerationError('INVALID_INPUT', `${stage} 阶段没有这些表类型：${unknown.join('、')}`)
    const entries = [...allowed.map((type) => next.sheets[type] ?? 0), next.recording]
    if (entries.some((value) => !Number.isFinite(value) || value < 0)) throw new QuestionSheetGenerationError('INVALID_INPUT', '权重必须是非负数字。')
    const total = entries.reduce((sum, value) => sum + value, 0)
    if (Math.abs(total - 1) > 0.01) throw new QuestionSheetGenerationError('INVALID_INPUT', `权重合计必须为 1（当前 ${Math.round(total * 1000) / 1000}）。`)

    const { sheets, reviews } = await this.repository.listForApplication(applicationId)
    const current = reviews.find((review) => review.stage === stage)
    const weights = resolveStageWeights(stage, next)
    const submitted = sheets.filter((sheet) => sheet.stage === stage && (sheet.status === 'submitted' || sheet.status === 'locked'))
    const sheetScores: Record<string, number> = {}
    for (const sheet of submitted) {
      const score = aggregateQuestionSheet(sheet).score
      if (typeof score === 'number') sheetScores[sheet.sheetType] = score
    }
    const breakdown = stageScoreBreakdown(stage, sheetScores, recordingScoreOf(submitted), weights)
    const history = [...(current?.weightsHistory ?? []), { actorId, at: new Date().toISOString(), from: resolveStageWeights(stage, current?.weights), to: weights }].slice(-20)
    const review = await this.repository.updateStageWeights(applicationId, stage, weights, breakdown.score, history)
    return { review, breakdown }
  }

  private async buildQuestions(
    pairs: Awaited<ReturnType<QuestionSheetRepository['listQaPairs']>>,
    context: Awaited<ReturnType<QuestionSheetRepository['getApplicationJobContext']>>,
    stage: InterviewStage,
  ): Promise<{ questions: QuestionWriteInput[]; model: string; notice?: string }> {
    const base = (generated: GeneratedSheetQuestion | undefined, index: number): Omit<QuestionWriteInput, 'seq'> => ({
      question: generated?.question ?? pairs[index]!.question,
      dimension: generated?.dimension ?? '综合能力',
      category: generated?.category ?? (stage === 'initial' ? 'experience' : 'job_specific'),
      difficulty: generated?.difficulty ?? 'medium',
      source: 'live_question',
      questionEventId: pairs[index]!.questionEventId,
      answerSegmentIds: pairs[index]!.answerSegmentIds,
      answerText: pairs[index]!.answerText || null,
      tiers: generated?.tiers ?? DEFAULT_QUESTION_TIERS.map((tier) => ({ ...tier })),
      aiTier: generated?.aiTier ?? null,
      aiScore: generated?.aiScore ?? null,
      aiRationale: generated?.aiRationale ?? null,
      aiEvidence: generated?.aiEvidence ?? [],
    })

    let config: QuestionSheetGeneratorConfig
    try {
      config = loadQuestionSheetGeneratorConfig()
    } catch (error: unknown) {
      if (!(error instanceof QuestionSheetGenerationError) || error.code !== 'AI_NOT_CONFIGURED') throw error
      return {
        questions: pairs.map((_pair, index) => ({ seq: index + 1, ...base(undefined, index) })),
        model: 'unconfigured',
        notice: '未配置 AI 模型：已按该阶段问答生成题目与三级区间，但没有 AI 默认分。',
      }
    }

    const input: QuestionSheetGenerationInput = {
      interviewTitle: context?.jobTitle ?? '',
      jobTitle: context?.jobTitle ?? '',
      requirements: context?.requirements ?? [],
      skills: context?.skills ?? [],
      pairs: pairs.map((pair) => ({ question: pair.question, answerText: pair.answerText })),
    }
    const generator = this.dependencies.createGenerator
      ? this.dependencies.createGenerator(config)
      : createQuestionSheetGenerator(config, this.dependencies.fetchImpl ?? fetch)
    const generated = await generator.generate(input)
    return { questions: pairs.map((_pair, index) => ({ seq: index + 1, ...base(generated[index], index) })), model: config.model }
  }
}

/** 后台轮询：与 worker 的 poll 写法保持一致（单实例 API 内驱动）。 */
export function startQuestionSheetPoll(options: {
  service: QuestionSheetService
  pollIntervalMs: number
  logger?: Pick<Console, 'error' | 'warn' | 'log'>
}): () => void {
  const logger = options.logger ?? console
  let running = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      let guard = 0
      while (guard < 5) {
        const outcome = await options.service.processPendingGeneration()
        if (!outcome.processed) break
        if (outcome.applicationId) logger.log?.(`[question-sheet] ${outcome.failed ? 'failed' : 'ready'}: ${outcome.applicationId}`)
        guard += 1
      }
    } catch (error: unknown) {
      logger.error?.(`[question-sheet] poll failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      running = false
    }
  }
  void tick()
  const interval = setInterval(() => void tick(), options.pollIntervalMs)
  interval.unref?.()
  return () => clearInterval(interval)
}
