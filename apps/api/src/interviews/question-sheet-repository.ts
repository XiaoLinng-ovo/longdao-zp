import type { Pool, PoolClient } from 'pg'

export type QuestionSheetStatus = 'draft' | 'generating' | 'scoring' | 'submitted' | 'locked'
export type QuestionTierName = 'excellent' | 'pass' | 'below'
export type QuestionSource = 'live_question' | 'ai_generated' | 'manual'
export type InterviewStage = 'initial' | 'final'
export type QuestionSheetType = 'hr_screen' | 'hiring_department' | 'business' | 'hr' | 'boss'
export type StageDecision = 'advanced' | 'rejected' | 'hired' | 'hold'

/** 阶段综合分的权重：各表 + 录音，和为 1（缺失项在计算时按剩余权重归一）。 */
export interface StageWeights { sheets: Record<string, number>; recording: number }

export interface QuestionTier { tier: QuestionTierName; min: number; max: number; description: string }

export interface InterviewQuestionRecord {
  id: string
  seq: number
  question: string
  dimension: string | null
  category: string | null
  difficulty: string | null
  source: QuestionSource
  questionEventId: string | null
  answerSegmentIds: string[]
  answerText: string | null
  tiers: QuestionTier[]
  aiTier: QuestionTierName | null
  aiScore: number | null
  aiRationale: string | null
  aiEvidence: string[]
  finalTier: QuestionTierName | null
  finalScore: number | null
  comment: string | null
  scoredBy: string | null
  scoredAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InterviewQuestionSheetRecord {
  id: string
  applicationId: string
  stage: InterviewStage
  sheetType: QuestionSheetType
  status: QuestionSheetStatus
  source: 'ai' | 'manual'
  generationModel: string | null
  promptVersion: string | null
  generationError: string | null
  generationNotice: string | null
  generatedBy: string | null
  generatedAt: string | null
  submittedAt: string | null
  lockedAt: string | null
  createdAt: string
  updatedAt: string
  questions: InterviewQuestionRecord[]
}

export interface InterviewStageReviewRecord {
  id: string
  applicationId: string
  stage: InterviewStage
  sheetScores: Record<string, number>
  weights: StageWeights
  weightsHistory: Array<{ actorId: string; at: string; from: StageWeights; to: StageWeights }>
  recordingScore: number | null
  aiScore: number | null
  aiRecommendation: 'strong_yes' | 'yes' | 'mixed' | 'no' | null
  aiRationale: string | null
  aiEvidence: string[]
  decision: StageDecision | null
  decidedBy: string | null
  decidedAt: string | null
}
/** 一问一答：来自提问事件 + 其后的候选人转写片段。 */
export interface InterviewQaPair {
  questionEventId: string
  question: string
  answerSegmentIds: string[]
  answerText: string
}

export interface QuestionWriteInput {
  seq: number
  question: string
  dimension?: string | null
  category?: string | null
  difficulty?: string | null
  source: QuestionSource
  questionEventId?: string | null
  answerSegmentIds?: string[]
  answerText?: string | null
  tiers?: QuestionTier[]
  aiTier?: QuestionTierName | null
  aiScore?: number | null
  aiRationale?: string | null
  aiEvidence?: string[]
}

export interface QuestionScorePatch {
  finalTier?: QuestionTierName | null
  finalScore?: number | null
  comment?: string | null
}

/** 候选人回答的最小置信度：低于该值不参与自动打分（沿用实时面试的角色判定口径）。 */
const MIN_CANDIDATE_CONFIDENCE = 0.6

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const raw = String(value ?? '')
  return raw ? new Date(raw).toISOString() : ''
}

function nullableIso(value: unknown): string | null {
  return value ? iso(value) : null
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function tierArray(value: unknown): QuestionTier[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const tier = row.tier
    if (tier !== 'excellent' && tier !== 'pass' && tier !== 'below') return []
    return [{ tier, min: Number(row.min ?? 0), max: Number(row.max ?? 0), description: typeof row.description === 'string' ? row.description : '' }]
  })
}

function mapSheetRow(row: Record<string, unknown>): Omit<InterviewQuestionSheetRecord, 'questions'> {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    stage: String(row.stage) as InterviewStage,
    sheetType: String(row.sheet_type) as QuestionSheetType,
    status: String(row.status) as QuestionSheetStatus,
    source: String(row.source) as 'ai' | 'manual',
    generationModel: (row.generation_model as string | null) ?? null,
    promptVersion: (row.prompt_version as string | null) ?? null,
    generationError: (row.generation_error as string | null) ?? null,
    generationNotice: (row.generation_notice as string | null) ?? null,
    generatedBy: (row.generated_by as string | null) ?? null,
    generatedAt: nullableIso(row.generated_at),
    submittedAt: nullableIso(row.submitted_at),
    lockedAt: nullableIso(row.locked_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function mapQuestionRow(row: Record<string, unknown>): InterviewQuestionRecord {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    question: String(row.question),
    dimension: (row.dimension as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    difficulty: (row.difficulty as string | null) ?? null,
    source: String(row.source) as QuestionSource,
    questionEventId: (row.question_event_id as string | null) ?? null,
    answerSegmentIds: stringArray(row.answer_segment_ids),
    answerText: (row.answer_text as string | null) ?? null,
    tiers: tierArray(row.tiers),
    aiTier: (row.ai_tier as QuestionTierName | null) ?? null,
    aiScore: numberOrNull(row.ai_score),
    aiRationale: (row.ai_rationale as string | null) ?? null,
    aiEvidence: stringArray(row.ai_evidence),
    finalTier: (row.final_tier as QuestionTierName | null) ?? null,
    finalScore: numberOrNull(row.final_score),
    comment: (row.comment as string | null) ?? null,
    scoredBy: (row.scored_by as string | null) ?? null,
    scoredAt: nullableIso(row.scored_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

const SHEET_COLUMNS = 'id, application_id, stage, sheet_type, status, source, generation_model, prompt_version, generation_error, generation_notice, generated_by, generated_at, submitted_at, locked_at, created_at, updated_at'
const QUESTION_COLUMNS = 'id, seq, question, dimension, category, difficulty, source, question_event_id, answer_segment_ids, answer_text, tiers, ai_tier, ai_score, ai_rationale, ai_evidence, final_tier, final_score, comment, scored_by, scored_at, created_at, updated_at'
const STAGE_REVIEW_COLUMNS = 'id, application_id, stage, sheet_scores, weights, weights_history, recording_score, ai_score, ai_recommendation, ai_rationale, ai_evidence, decision, decided_by, decided_at'

function mapStageReviewRow(row: Record<string, unknown>): InterviewStageReviewRecord {
  const scores = row.sheet_scores && typeof row.sheet_scores === 'object' ? (row.sheet_scores as Record<string, unknown>) : {}
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    stage: String(row.stage) as InterviewStage,
    sheetScores: Object.fromEntries(Object.entries(scores).flatMap(([key, value]) => (typeof value === 'number' ? [[key, value]] : []))),
    weights: mapWeights(row.weights),
    weightsHistory: mapWeightsHistory(row.weights_history),
    recordingScore: numberOrNull(row.recording_score),
    aiScore: numberOrNull(row.ai_score),
    aiRecommendation: (row.ai_recommendation as InterviewStageReviewRecord['aiRecommendation']) ?? null,
    aiRationale: (row.ai_rationale as string | null) ?? null,
    aiEvidence: stringArray(row.ai_evidence),
    decision: (row.decision as StageDecision | null) ?? null,
    decidedBy: (row.decided_by as string | null) ?? null,
    decidedAt: nullableIso(row.decided_at),
  }
}

function mapWeightsHistory(value: unknown): Array<{ actorId: string; at: string; from: StageWeights; to: StageWeights }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const actorId = typeof row.actorId === 'string' ? row.actorId : ''
    const at = typeof row.at === 'string' ? row.at : ''
    if (!actorId || !at) return []
    return [{ actorId, at, from: mapWeights(row.from), to: mapWeights(row.to) }]
  })
}

function mapWeights(value: unknown): StageWeights {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const sheets = row.sheets && typeof row.sheets === 'object' ? (row.sheets as Record<string, unknown>) : {}
  return {
    sheets: Object.fromEntries(Object.entries(sheets).flatMap(([key, weight]) => (typeof weight === 'number' ? [[key, weight]] : []))),
    recording: typeof row.recording === 'number' ? row.recording : 0,
  }
}

export class QuestionSheetConflictError extends Error {
  readonly code = 'QUESTION_SHEET_CONFLICT'
  constructor(message: string) { super(message); this.name = 'QuestionSheetConflictError' }
}

export class QuestionSheetNotFoundError extends Error {
  readonly code = 'QUESTION_SHEET_NOT_FOUND'
  constructor(message: string) { super(message); this.name = 'QuestionSheetNotFoundError' }
}

export class QuestionSheetRepository {
  constructor(private readonly pool: Pool) {}

  /** 读取某应聘某阶段某类型的问题表；不存在时返回 null（是否创建由调用方决定）。 */
  async find(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType): Promise<InterviewQuestionSheetRecord | null> {
    const sheet = await this.pool.query(
      `SELECT ${SHEET_COLUMNS} FROM interview_question_sheets WHERE application_id = $1::uuid AND stage = $2 AND sheet_type = $3`,
      [applicationId, stage, sheetType],
    )
    const row = sheet.rows[0]
    if (!row) return null
    const questions = await this.pool.query(`SELECT ${QUESTION_COLUMNS} FROM interview_questions WHERE sheet_id = $1::uuid ORDER BY seq`, [row.id])
    return { ...mapSheetRow(row), questions: questions.rows.map(mapQuestionRow) }
  }

  /** 该应聘下的所有表与阶段汇总，供详情页一次取回。 */
  async listForApplication(applicationId: string): Promise<{ sheets: InterviewQuestionSheetRecord[]; reviews: InterviewStageReviewRecord[] }> {
    const sheets = await this.pool.query(`SELECT ${SHEET_COLUMNS} FROM interview_question_sheets WHERE application_id = $1::uuid ORDER BY stage, sheet_type`, [applicationId])
    const rows: InterviewQuestionSheetRecord[] = []
    for (const row of sheets.rows) {
      const questions = await this.pool.query(`SELECT ${QUESTION_COLUMNS} FROM interview_questions WHERE sheet_id = $1::uuid ORDER BY seq`, [row.id])
      rows.push({ ...mapSheetRow(row), questions: questions.rows.map(mapQuestionRow) })
    }
    const reviews = await this.pool.query(`SELECT ${STAGE_REVIEW_COLUMNS} FROM interview_stage_reviews WHERE application_id = $1::uuid ORDER BY stage`, [applicationId])
    return { sheets: rows, reviews: reviews.rows.map(mapStageReviewRow) }
  }

  /** 确保存在一张草稿表：已存在则原样返回，避免重复建表。 */
  async ensure(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType): Promise<InterviewQuestionSheetRecord> {
    await this.pool.query(
      `INSERT INTO interview_question_sheets (application_id, stage, sheet_type) VALUES ($1::uuid, $2, $3)
       ON CONFLICT (application_id, stage, sheet_type) DO NOTHING`,
      [applicationId, stage, sheetType],
    )
    const sheet = await this.find(applicationId, stage, sheetType)
    if (!sheet) throw new QuestionSheetNotFoundError('面试问题表创建失败')
    return sheet
  }

  /** 标记为待生成：locked 状态不允许重新生成。 */
  async markGenerating(applicationId: string, stage: InterviewStage, sheetType: QuestionSheetType, actorId: string, model: string, promptVersion: string): Promise<InterviewQuestionSheetRecord> {
    await this.ensure(applicationId, stage, sheetType)
    const updated = await this.pool.query(
      `UPDATE interview_question_sheets
          SET status = 'generating', source = 'ai', generation_model = $4, prompt_version = $5,
              generation_error = NULL, generation_notice = NULL, generated_by = $6::uuid, updated_at = now()
        WHERE application_id = $1::uuid AND stage = $2 AND sheet_type = $3 AND status <> 'locked'
        RETURNING ${SHEET_COLUMNS}`,
      [applicationId, stage, sheetType, model, promptVersion, actorId],
    )
    if (!updated.rows[0]) throw new QuestionSheetConflictError('问题表已锁定，不能重新生成')
    return this.ensure(applicationId, stage, sheetType)
  }

  /**
   * 领取一个待生成的表（后台轮询用）。
   * 不锁行：单实例部署下按 updated_at 顺序取即可，重复领取由生成结果覆盖兜底。
   */
  async claimPendingGeneration(): Promise<{ sheetId: string; applicationId: string; stage: InterviewStage; sheetType: QuestionSheetType } | null> {
    const claimed = await this.pool.query(
      `UPDATE interview_question_sheets
          SET updated_at = now()
        WHERE id = (
          SELECT id FROM interview_question_sheets
           WHERE status = 'generating'
           ORDER BY updated_at
           LIMIT 1
        )
        RETURNING id, application_id, stage, sheet_type`,
    )
    const row = claimed.rows[0]
    return row ? { sheetId: String(row.id), applicationId: String(row.application_id), stage: String(row.stage) as InterviewStage, sheetType: String(row.sheet_type) as QuestionSheetType } : null
  }

  /** 写入生成结果：整体替换题目，状态进入 scoring。 */
  async replaceQuestions(sheetId: string, questions: QuestionWriteInput[], meta: { model: string; promptVersion: string }): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(`DELETE FROM interview_questions WHERE sheet_id = $1::uuid`, [sheetId])
      for (const question of questions) await this.insertQuestion(client, sheetId, question)
      await client.query(
      `UPDATE interview_question_sheets
            SET status = 'scoring', generation_model = $2, prompt_version = $3, generation_error = NULL,
                generated_at = now(), updated_at = now()
          WHERE id = $1::uuid`,
        [sheetId, meta.model, meta.promptVersion],
      )
    })
  }

  /** 降级生成（例如未配置模型）时记录原因，状态仍可用于打分。 */
  async markGenerationNotice(sheetId: string, notice: string): Promise<void> {
    await this.pool.query(
      `UPDATE interview_question_sheets SET generation_notice = $2, updated_at = now() WHERE id = $1::uuid`,
      [sheetId, notice.slice(0, 300)],
    )
  }

  async markGenerationFailed(sheetId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE interview_question_sheets SET status = 'draft', generation_error = $2, generation_notice = NULL, updated_at = now() WHERE id = $1::uuid`,
      [sheetId, message.slice(0, 500)],
    )
  }

  /** 打分：只在 scoring 状态允许，并记录打分人与时间。 */
  async patchQuestion(sheetId: string, questionId: string, patch: QuestionScorePatch, actorId: string): Promise<InterviewQuestionRecord> {
    return this.transaction(async (client) => {
      const sheet = await this.lockSheet(client, sheetId)
      if (sheet.status !== 'scoring') throw new QuestionSheetConflictError(`当前状态（${sheet.status}）不能修改打分`)
      const assignments: string[] = []
      const values: unknown[] = [questionId]
      const add = (column: string, value: unknown) => assignments.push(`${column} = $${values.push(value)}`)
      if (patch.finalTier !== undefined) add('final_tier', patch.finalTier)
      if (patch.finalScore !== undefined) add('final_score', patch.finalScore)
      if (patch.comment !== undefined) add('comment', patch.comment)
      assignments.push('scored_by = $' + values.push(actorId) + '::uuid', 'scored_at = now()', 'updated_at = now()')
      const updated = await client.query(
        `UPDATE interview_questions SET ${assignments.join(', ')} WHERE id = $1::uuid AND sheet_id = $${values.push(sheetId)}::uuid RETURNING ${QUESTION_COLUMNS}`,
        values,
      )
      if (!updated.rows[0]) throw new QuestionSheetNotFoundError('未找到该题目')
      return mapQuestionRow(updated.rows[0])
    })
  }

  /** 手工补录题目（线下面试）：追加到末尾。 */
  async addManualQuestion(sheetId: string, input: { question: string; dimension?: string | null; answerText?: string | null; tiers?: QuestionTier[] }): Promise<InterviewQuestionRecord> {
    return this.transaction(async (client) => {
      const sheet = await this.lockSheet(client, sheetId)
      if (sheet.status === 'locked' || sheet.status === 'generating') throw new QuestionSheetConflictError(`当前状态（${sheet.status}）不能新增题目`)
      const next = await client.query<{ next: number }>(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM interview_questions WHERE sheet_id = $1::uuid`, [sheetId])
      return this.insertQuestion(client, sheetId, {
        seq: Number(next.rows[0]?.next ?? 1),
        question: input.question,
        dimension: input.dimension ?? null,
        source: 'manual',
        answerText: input.answerText ?? null,
        ...(input.tiers === undefined ? {} : { tiers: input.tiers }),
      })
    })
  }

  async deleteQuestion(sheetId: string, questionId: string): Promise<void> {
    await this.transaction(async (client) => {
      const sheet = await this.lockSheet(client, sheetId)
      if (sheet.status === 'locked' || sheet.status === 'generating') throw new QuestionSheetConflictError(`当前状态（${sheet.status}）不能删除题目`)
      await client.query(`DELETE FROM interview_questions WHERE id = $1::uuid AND sheet_id = $2::uuid`, [questionId, sheetId])
    })
  }

  async submit(sheetId: string, actorId: string): Promise<InterviewQuestionSheetRecord> {
    return this.transaction(async (client) => {
      const sheet = await this.lockSheet(client, sheetId)
      if (sheet.status === 'locked') throw new QuestionSheetConflictError('问题表已锁定')
      if (sheet.status !== 'scoring' && sheet.status !== 'submitted') throw new QuestionSheetConflictError(`当前状态（${sheet.status}）不能提交`)
      await client.query(
        `UPDATE interview_question_sheets
            SET status = 'submitted', submitted_at = now(), generated_by = COALESCE(generated_by, $2::uuid), updated_at = now()
          WHERE id = $1::uuid`,
        [sheetId, actorId],
      )
      return this.loadWithExecutor(client, sheetId)
    })
  }

  async lock(sheetId: string, actorId: string): Promise<InterviewQuestionSheetRecord> {
    return this.transaction(async (client) => {
      const sheet = await this.lockSheet(client, sheetId)
      if (sheet.status !== 'submitted' && sheet.status !== 'locked') throw new QuestionSheetConflictError(`当前状态（${sheet.status}）不能锁定`)
      await client.query(
        `UPDATE interview_question_sheets SET status = 'locked', locked_at = COALESCE(locked_at, now()), updated_at = now() WHERE id = $1::uuid`,
        [sheetId],
      )
      return this.loadWithExecutor(client, sheetId)
    })
  }

  /** 阶段汇总：AI 建议与人工结论分开存，AI 不写 decision。 */
  async upsertStageReview(applicationId: string, stage: InterviewStage, input: {
    sheetScores: Record<string, number>
    weights: StageWeights
    weightsHistory?: Array<{ actorId: string; at: string; from: StageWeights; to: StageWeights }>
    recordingScore: number | null
    aiScore: number | null
    aiRecommendation: InterviewStageReviewRecord['aiRecommendation']
    aiRationale: string | null
    aiEvidence: string[]
  }): Promise<InterviewStageReviewRecord> {
    const result = await this.pool.query(
      `INSERT INTO interview_stage_reviews
         (application_id, stage, sheet_scores, weights, weights_history, recording_score, ai_score, ai_recommendation, ai_rationale, ai_evidence)
       VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (application_id, stage) DO UPDATE
         SET sheet_scores = EXCLUDED.sheet_scores, weights = EXCLUDED.weights, recording_score = EXCLUDED.recording_score,
             ai_score = EXCLUDED.ai_score, ai_recommendation = EXCLUDED.ai_recommendation,
             ai_rationale = EXCLUDED.ai_rationale, ai_evidence = EXCLUDED.ai_evidence, updated_at = now()
       RETURNING ${STAGE_REVIEW_COLUMNS}`,
      [applicationId, stage, JSON.stringify(input.sheetScores), JSON.stringify(input.weights), JSON.stringify(input.weightsHistory ?? []), input.recordingScore, input.aiScore, input.aiRecommendation, input.aiRationale, JSON.stringify(input.aiEvidence)],
    )
    return mapStageReviewRow(result.rows[0])
  }

  /** 只更新权重、重算后的综合分与权重留痕，不动 AI 建议文本与人工结论。 */
  async updateStageWeights(applicationId: string, stage: InterviewStage, weights: StageWeights, aiScore: number | null, history: Array<{ actorId: string; at: string; from: StageWeights; to: StageWeights }>): Promise<InterviewStageReviewRecord> {
    const result = await this.pool.query(
      `INSERT INTO interview_stage_reviews (application_id, stage, weights, weights_history, ai_score)
       VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5)
       ON CONFLICT (application_id, stage) DO UPDATE
         SET weights = EXCLUDED.weights, weights_history = EXCLUDED.weights_history, ai_score = EXCLUDED.ai_score, updated_at = now()
       RETURNING ${STAGE_REVIEW_COLUMNS}`,
      [applicationId, stage, JSON.stringify(weights), JSON.stringify(history), aiScore],
    )
    return mapStageReviewRow(result.rows[0])
  }

  /** 人工确认阶段结论：能否进复试、是否录用都由人落，AI 不参与写状态。 */
  async recordStageDecision(applicationId: string, stage: InterviewStage, decision: StageDecision, actorId: string): Promise<InterviewStageReviewRecord> {
    const result = await this.pool.query(
      `INSERT INTO interview_stage_reviews (application_id, stage, decision, decided_by, decided_at)
       VALUES ($1::uuid, $2, $3, $4::uuid, now())
       ON CONFLICT (application_id, stage) DO UPDATE
         SET decision = EXCLUDED.decision, decided_by = EXCLUDED.decided_by, decided_at = now(), updated_at = now()
       RETURNING ${STAGE_REVIEW_COLUMNS}`,
      [applicationId, stage, decision, actorId],
    )
    return mapStageReviewRow(result.rows[0])
  }

  /**
   * 一问一答配对：按提问事件的时间顺序切段，回答取该提问之后、下一条提问之前的候选人片段。
   * 依赖两边的 created_at（写入时间）排序，与实时面试的角色置信度阈值保持一致。
   */
  async listQaPairs(applicationId: string, stage: InterviewStage): Promise<InterviewQaPair[]> {
    const result = await this.pool.query(
      `WITH sessions AS (
         SELECT s.id FROM interview_live_sessions s
           JOIN interviews i ON i.id = s.interview_id
          WHERE i.application_id = $1::uuid AND i.stage = $2
       ), events AS (
         SELECT e.id, e.question, e.created_at,
                LEAD(e.created_at) OVER (ORDER BY e.created_at, e.id) AS next_at
           FROM interview_live_question_events e
          WHERE e.session_id IN (SELECT id FROM sessions)
       )
       SELECT e.id AS event_id, e.question,
              COALESCE(array_agg(s.id ORDER BY s.created_at) FILTER (WHERE s.id IS NOT NULL), '{}') AS segment_ids,
              COALESCE(string_agg(s.text, ' ' ORDER BY s.created_at) FILTER (WHERE s.id IS NOT NULL), '') AS answer_text
         FROM events e
         LEFT JOIN interview_live_segments s
                ON s.session_id IN (SELECT id FROM sessions)
               AND s.role = 'candidate'
               AND s.role_confidence >= $3
               AND s.created_at > e.created_at
               AND (e.next_at IS NULL OR s.created_at < e.next_at)
        GROUP BY e.id, e.question, e.created_at
        ORDER BY e.created_at, e.id`,
      [applicationId, stage, MIN_CANDIDATE_CONFIDENCE],
    )
    return result.rows.map((row) => ({
      questionEventId: String(row.event_id),
      question: String(row.question),
      answerSegmentIds: stringArray(row.segment_ids),
      answerText: String(row.answer_text ?? '').trim(),
    }))
  }

  /** 该应聘对应的岗位与候选人上下文，用于生成题目与三级标准。 */
  async getApplicationJobContext(applicationId: string): Promise<{ candidateName: string; jobTitle: string; requirements: string[]; skills: string[] } | null> {
    const result = await this.pool.query(
      `SELECT c.name AS candidate_name, j.title AS job_title, latest.content
         FROM applications a
         JOIN jobs j ON j.id = a.job_id
         JOIN candidates c ON c.id = a.candidate_id
         LEFT JOIN LATERAL (
           SELECT content FROM job_spec_versions WHERE job_id = j.id ORDER BY version DESC LIMIT 1
         ) AS latest ON true
        WHERE a.id = $1::uuid`,
      [applicationId],
    )
    const row = result.rows[0]
    if (!row) return null
    const content = row.content && typeof row.content === 'object' ? (row.content as Record<string, unknown>) : {}
    const requirements = Array.isArray(content.requirements)
      ? content.requirements.flatMap((item) => {
          if (!item || typeof item !== 'object') return []
          const entry = item as Record<string, unknown>
          const text = [entry.label, entry.description].filter((value) => typeof value === 'string' && value.trim()).join('：')
          return text ? [text] : []
        })
      : []
    const skills = Array.isArray(content.skills) ? content.skills.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
    return {
      candidateName: String(row.candidate_name ?? ''),
      jobTitle: String(row.job_title ?? ''),
      requirements,
      skills,
    }
  }

  private async insertQuestion(client: PoolClient, sheetId: string, input: QuestionWriteInput): Promise<InterviewQuestionRecord> {
    const inserted = await client.query(
      `INSERT INTO interview_questions
         (sheet_id, seq, question, dimension, category, difficulty, source, question_event_id,
          answer_segment_ids, answer_text, tiers, ai_tier, ai_score, ai_rationale, ai_evidence)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9::uuid[], $10, $11::jsonb, $12, $13, $14, $15::jsonb)
       RETURNING ${QUESTION_COLUMNS}`,
      [
        sheetId, input.seq, input.question, input.dimension ?? null, input.category ?? null, input.difficulty ?? null,
        input.source, input.questionEventId ?? null, input.answerSegmentIds ?? [], input.answerText ?? null,
        JSON.stringify(input.tiers ?? []), input.aiTier ?? null, input.aiScore ?? null, input.aiRationale ?? null,
        JSON.stringify(input.aiEvidence ?? []),
      ],
    )
    return mapQuestionRow(inserted.rows[0])
  }

  private async lockSheet(client: PoolClient, sheetId: string): Promise<{ status: QuestionSheetStatus; applicationId: string; stage: InterviewStage; sheetType: QuestionSheetType }> {
    const locked = await client.query(`SELECT status, application_id, stage, sheet_type FROM interview_question_sheets WHERE id = $1::uuid FOR UPDATE`, [sheetId])
    const row = locked.rows[0]
    if (!row) throw new QuestionSheetNotFoundError('未找到面试问题表')
    return {
      status: String(row.status) as QuestionSheetStatus,
      applicationId: String(row.application_id),
      stage: String(row.stage) as InterviewStage,
      sheetType: String(row.sheet_type) as QuestionSheetType,
    }
  }

  private async loadWithExecutor(client: PoolClient, sheetId: string): Promise<InterviewQuestionSheetRecord> {
    const sheet = await client.query(`SELECT ${SHEET_COLUMNS} FROM interview_question_sheets WHERE id = $1::uuid`, [sheetId])
    const questions = await client.query(`SELECT ${QUESTION_COLUMNS} FROM interview_questions WHERE sheet_id = $1::uuid ORDER BY seq`, [sheetId])
    return { ...mapSheetRow(sheet.rows[0]), questions: questions.rows.map(mapQuestionRow) }
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
