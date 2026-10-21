import {
  QuestionSheetRepository,
  type InterviewQuestionRecord,
  type InterviewQuestionSheetRecord,
  type InterviewStage,
  type InterviewStageReviewRecord,
  type NextRoundInterview,
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

const GENERATION_BATCH_SIZE = 5
const GENERATION_CONCURRENCY = 2

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
  nextInterview: NextRoundInterview | null
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

export interface PendingGenerationResult { processed: boolean; applicationId?: string; failed?: string }

export class QuestionSheetService {
  constructor(
    private readonly repository: QuestionSheetRepository,
    private readonly dependencies: {
      fetchImpl?: typeof fetch
      resolveAiEnv?: (applicationId: string) => Promise<NodeJS.ProcessEnv>
      logger?: Pick<Console, 'error' | 'warn' | 'log'>
      /** 测试注入：避免真实模型调用。 */
      createGenerator?: (config: QuestionSheetGeneratorConfig) => ReturnType<typeof createQuestionSheetGenerator>
      createStageReview?: (config: QuestionSheetGeneratorConfig) => ReturnType<typeof createStageReviewGenerator>
    } = {},
  ) {}

  async getApplicationView(applicationId: string): Promise<ApplicationQuestionSheetsView> {
    const { sheets, reviews } = await this.repository.listForApplication(applicationId)
    const completedRecordingScores = await this.repository.listCompletedLiveRecordingScores(applicationId)
    const stages = (Object.keys(STAGE_SHEET_TYPES) as InterviewStage[]).map((stage) => {
      const submitted = sheets.filter((sheet) => sheet.stage === stage && (sheet.status === 'submitted' || sheet.status === 'locked'))
      const sheetScores: Record<string, number> = {}
      for (const sheet of submitted) {
        const score = aggregateQuestionSheet(sheet).score
        if (typeof score === 'number') sheetScores[sheet.sheetType] = score
      }
      const weights = resolveStageWeights(stage, reviews.find((review) => review.stage === stage)?.weights)
      const recordingScore = completedRecordingScores.find((item) => item.stage === stage)?.score ?? null
      return { stage, weights, breakdown: stageScoreBreakdown(stage, sheetScores, recordingScore, weights) }
    })
    return { applicationId, nextInterview: await this.repository.findNextRound(applicationId), sheets: sheets.map((sheet) => ({ ...sheet, aggregate: aggregateQuestionSheet(sheet) })), reviews, stages }
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
    if ((await this.repository.find(applicationId, stage, sheetType))?.status === 'generating') return this.getApplicationView(applicationId)
    const env = this.dependencies.resolveAiEnv ? await this.dependencies.resolveAiEnv(applicationId) : process.env
    const model = env.OPENAI_MODEL?.trim() || 'unconfigured'
    await this.repository.markGenerating(applicationId, stage, sheetType, actorId, model, QUESTION_SHEET_PROMPT_VERSION)
    return this.getApplicationView(applicationId)
  }

  /**
   * 面试结束时按本轮题库与实际提问创建评价表；没有回答的题不评分。
   */
  async requestAutomaticGeneration(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType, actorId: string): Promise<{ queued: boolean; reason?: string }> {
    if (!STAGE_SHEET_TYPES[stage].includes(sheetType)) throw new QuestionSheetGenerationError('INVALID_INPUT', `${stage} 阶段不支持该面试表类型：${sheetType}`)
    const pairs = await this.repository.listSheetQaPairs(applicationId, stage, sheetType)
    if (!pairs.some((pair) => pair.question.trim())) {
      return { queued: false, reason: '没有找到该阶段的已保存题库或提问记录，本次未生成逐题评价。' }
    }
    const existing = await this.repository.find(applicationId, stage, sheetType)
    if (existing && (existing.status === 'generating' || existing.status === 'scoring' || existing.status === 'submitted' || existing.status === 'locked' || existing.questions.length > 0)) {
      return { queued: existing.status === 'generating', reason: existing.status === 'generating' ? '逐题评分正在生成中。' : '已保留该阶段已有的逐题评价，未覆盖原内容。' }
    }
    await this.requestGeneration(applicationId, stage, sheetType, actorId)
    return { queued: true }
  }

  /** 复试结束后分别排队三类评价表；某张失败不阻止其余表生成。 */
  async requestFinalStageGeneration(applicationId: string, actorId: string): Promise<{ queued: boolean; reason?: string; sheets: Array<{ sheetType: QuestionSheetType; queued: boolean; reason?: string }> }> {
    return this.requestStageGeneration(applicationId, 'final', actorId)
  }

  async requestStageGeneration(applicationId: string, stage: InterviewStage, actorId: string): Promise<{ queued: boolean; reason?: string; sheets: Array<{ sheetType: QuestionSheetType; queued: boolean; reason?: string }> }> {
    const sheets: Array<{ sheetType: QuestionSheetType; queued: boolean; reason?: string }> = []
    for (const sheetType of STAGE_SHEET_TYPES[stage]) {
      try {
        sheets.push({ sheetType, ...await this.requestAutomaticGeneration(applicationId, stage, sheetType, actorId) })
      } catch (error) {
        sheets.push({ sheetType, queued: false, reason: error instanceof Error ? error.message : '生成失败' })
      }
    }
    const details = sheets.filter(item => item.reason).map(item => SHEET_TYPE_LABEL[item.sheetType] + '：' + item.reason)
    return { queued: sheets.some(item => item.queued), ...(details.length ? { reason: details.join('；') } : {}), sheets }
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
      const pairs = await this.repository.listSheetQaPairs(applicationId, stage, claimed.sheetType)
      if (!pairs.length) throw new QuestionSheetGenerationError('INVALID_INPUT', '该阶段还没有问答记录，无法生成面试表。')
      const context = await this.repository.getApplicationJobContext(applicationId)
      const built = await this.buildQuestions(pairs, context, stage, applicationId, claimed.sheetType)
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

  async unlock(sheetId: string, actorId: string): Promise<{ sheet: InterviewQuestionSheetRecord; aggregate: QuestionSheetAggregate }> {
    const sheet = await this.repository.unlock(sheetId, actorId)
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
    const liveScore = (await this.repository.listCompletedLiveRecordingScores(applicationId)).find((item) => item.stage === stage)?.score
    const recordingScore = liveScore ?? null
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
      const config = loadQuestionSheetGeneratorConfig(this.dependencies.resolveAiEnv ? await this.dependencies.resolveAiEnv(applicationId) : process.env)
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
    const liveScore = (await this.repository.listCompletedLiveRecordingScores(applicationId)).find((item) => item.stage === stage)?.score
    const recordingScore = liveScore ?? null
    const breakdown = stageScoreBreakdown(stage, sheetScores, recordingScore, weights)
    const history = [...(current?.weightsHistory ?? []), { actorId, at: new Date().toISOString(), from: resolveStageWeights(stage, current?.weights), to: weights }].slice(-20)
    const review = await this.repository.updateStageWeights(applicationId, stage, weights, recordingScore, breakdown.score, history)
    return { review, breakdown }
  }

  private async buildQuestions(
    pairs: Awaited<ReturnType<QuestionSheetRepository['listSheetQaPairs']>>,
    context: Awaited<ReturnType<QuestionSheetRepository['getApplicationJobContext']>>,
    stage: InterviewStage,
    applicationId: string,
    sheetType: QuestionSheetType,
  ): Promise<{ questions: QuestionWriteInput[]; model: string; notice?: string }> {
    const base = (generated: GeneratedSheetQuestion | undefined, index: number): Omit<QuestionWriteInput, 'seq'> => ({
      question: pairs[index]!.question,
      dimension: pairs[index]!.dimension ?? generated?.dimension ?? '综合能力',
      category: pairs[index]!.category ?? generated?.category ?? (stage === 'initial' ? 'experience' : 'job_specific'),
      difficulty: pairs[index]!.difficulty ?? generated?.difficulty ?? 'medium',
      source: pairs[index]!.source ?? (pairs[index]!.questionEventId ? 'live_question' : 'ai_generated'),
      questionEventId: pairs[index]!.questionEventId,
      answerSegmentIds: pairs[index]!.answerSegmentIds,
      answerText: pairs[index]!.answerText || null,
      tiers: generated?.tiers ?? DEFAULT_QUESTION_TIERS.map((tier) => ({ ...tier })),
      aiTier: pairs[index]!.answerText.trim() ? generated?.aiTier ?? null : null,
      aiScore: pairs[index]!.answerText.trim() ? generated?.aiScore ?? null : null,
      aiRationale: pairs[index]!.answerText.trim() ? generated?.aiRationale ?? null : null,
      aiEvidence: pairs[index]!.answerText.trim() ? generated?.aiEvidence ?? [] : [],
    })

    if (pairs.every(pair => !pair.answerText.trim())) {
      return { questions: pairs.map((_pair, index) => ({ seq: index + 1, ...base(undefined, index) })), model: 'not-required', notice: '已整理本阶段题库与实际提问；未采集到可用回答，所有 AI 分数留空，可人工补充评价。' }
    }

    let config: QuestionSheetGeneratorConfig
    try {
      config = loadQuestionSheetGeneratorConfig(this.dependencies.resolveAiEnv ? await this.dependencies.resolveAiEnv(applicationId) : process.env)
    } catch (error: unknown) {
      if (!(error instanceof QuestionSheetGenerationError) || error.code !== 'AI_NOT_CONFIGURED') throw error
      return {
        questions: pairs.map((_pair, index) => ({ seq: index + 1, ...base(undefined, index) })),
        model: 'unconfigured',
        notice: '未配置 AI 模型：已按该阶段问答生成题目与三级区间，但没有 AI 默认分。',
      }
    }

    const input: QuestionSheetGenerationInput = {
      stage,
      sheetType,
      interviewTitle: context?.jobTitle ?? '',
      jobTitle: context?.jobTitle ?? '',
      requirements: context?.requirements ?? [],
      skills: context?.skills ?? [],
      pairs: pairs.map((pair) => ({ question: pair.question, answerText: pair.answerText })),
    }
    const generator = this.dependencies.createGenerator
      ? this.dependencies.createGenerator(config)
      : createQuestionSheetGenerator(config, this.dependencies.fetchImpl ?? fetch)
    const generated: Array<GeneratedSheetQuestion | undefined> = new Array(pairs.length)
    const failedBatches: Array<{ start: number; end: number; message: string }> = []
    const batches = Array.from({ length: Math.ceil(pairs.length / GENERATION_BATCH_SIZE) }, (_, index) => index * GENERATION_BATCH_SIZE)
    let nextBatch = 0
    // Bound model output size and concurrency; a failed batch must not discard the real interview record.
    const runBatch = async (): Promise<void> => {
      while (nextBatch < batches.length) {
        const start = batches[nextBatch++]!
        const batchPairs = input.pairs.slice(start, start + GENERATION_BATCH_SIZE)
        try {
          const result = await generator.generate({ ...input, pairs: batchPairs })
          if (result.length !== batchPairs.length) throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '模型返回的题目数量与本批题目不一致。')
          result.forEach((question, index) => { generated[start + index] = question })
        } catch (error) {
          if (!(error instanceof QuestionSheetGenerationError) || !['MODEL_HTTP_ERROR', 'MODEL_REQUEST_FAILED', 'MODEL_RESPONSE_INVALID'].includes(error.code)) throw error
          failedBatches.push({ start: start + 1, end: start + batchPairs.length, message: error.message })
        }
      }
    }
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(GENERATION_CONCURRENCY, batches.length) }, runBatch))
    const rejected = outcomes.find((result) => result.status === 'rejected')
    if (rejected?.status === 'rejected') throw rejected.reason
    failedBatches.sort((a, b) => a.start - b.start)
    const failedCount = failedBatches.reduce((sum, batch) => sum + batch.end - batch.start + 1, 0)
    const notice = failedCount
      ? `已保留全部 ${pairs.length} 道题目；其中 ${failedCount} 道未获得 AI 评价（题号 ${failedBatches.map((batch) => `${batch.start}-${batch.end}`).join('、')}），未填入 AI 分数，可人工评分。原因：${failedBatches[0]!.message}`
      : undefined
    return { questions: pairs.map((_pair, index) => ({ seq: index + 1, ...base(generated[index], index) })), model: config.model, ...(notice ? { notice } : {}) }
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
