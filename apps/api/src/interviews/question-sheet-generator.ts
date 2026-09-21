import { describeModelHttpFailure } from '../ai/model-http-error.js'
import type { QuestionTier, QuestionTierName } from './question-sheet-repository.js'

export const QUESTION_SHEET_PROMPT_VERSION = 'v1'

/** 三级答案方向：与界面一致，允许面试官在区间内微调分数。 */
export const DEFAULT_QUESTION_TIERS: QuestionTier[] = [
  { tier: 'excellent', min: 90, max: 100, description: '' },
  { tier: 'pass', min: 70, max: 89, description: '' },
  { tier: 'below', min: 0, max: 69, description: '' },
]

export type QuestionSheetErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'INVALID_INPUT'
  | 'MODEL_HTTP_ERROR'
  | 'MODEL_REQUEST_FAILED'
  | 'MODEL_RESPONSE_INVALID'

export class QuestionSheetGenerationError extends Error {
  constructor(public readonly code: QuestionSheetErrorCode, message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'QuestionSheetGenerationError'
  }
}

export interface QuestionSheetGeneratorConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number }

export interface QuestionSheetGenerationInput {
  interviewTitle: string
  jobTitle: string
  requirements: string[]
  skills: string[]
  pairs: Array<{ question: string; answerText: string }>
}

export interface GeneratedSheetQuestion {
  seq: number
  question: string
  dimension: string
  category: string
  difficulty: string
  tiers: QuestionTier[]
  aiTier: QuestionTierName | null
  aiScore: number | null
  aiRationale: string | null
  aiEvidence: string[]
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const TIER_NAMES = new Set<QuestionTierName>(['excellent', 'pass', 'below'])
const CATEGORIES = new Set(['technical', 'behavioral', 'experience', 'job_specific'])
const DIFFICULTIES = new Set(['easy', 'medium', 'hard'])

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function loadQuestionSheetGeneratorConfig(env: NodeJS.ProcessEnv = process.env): QuestionSheetGeneratorConfig {
  const baseUrl = text(env.OPENAI_BASE_URL)
  const apiKey = text(env.OPENAI_API_KEY)
  const model = text(env.OPENAI_MODEL)
  if (!baseUrl || !apiKey || !model) {
    throw new QuestionSheetGenerationError('AI_NOT_CONFIGURED', '生成面试问题表需要 OPENAI_BASE_URL、OPENAI_API_KEY 与 OPENAI_MODEL。')
  }
  // 空值必须回落到默认值，否则会被当成 0 判为非法配置。
  const timeoutMs = Number(text(env.OPENAI_TIMEOUT_MS) ?? '120000')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new QuestionSheetGenerationError('AI_NOT_CONFIGURED', 'OPENAI_TIMEOUT_MS 必须是正整数。')
  }
  try {
    new URL(baseUrl)
  } catch (error) {
    throw new QuestionSheetGenerationError('AI_NOT_CONFIGURED', 'OPENAI_BASE_URL 必须是合法地址。', error)
  }
  return { baseUrl, apiKey, model, timeoutMs }
}

function parseTiers(value: unknown): QuestionTier[] {
  if (!Array.isArray(value)) return []
  const tiers = value.flatMap((item) => {
    if (!isRecord(item)) return []
    const tier = text(item.tier)
    if (!tier || !TIER_NAMES.has(tier as QuestionTierName)) return []
    const min = Number(item.min)
    const max = Number(item.max)
    if (!Number.isFinite(min) || !Number.isFinite(max)) return []
    return [{ tier: tier as QuestionTierName, min: Math.max(0, Math.min(100, Math.round(min))), max: Math.max(0, Math.min(100, Math.round(max))), description: text(item.description) ?? '' }]
  })
  return tiers.length === 3 ? tiers : []
}

/**
 * 解析模型输出。
 * 只有确实存在候选人回答的题目才接受 AI 默认分与依据——没有回答时模型若给了分也要丢弃，避免出现无依据的分数。
 */
export function parseQuestionSheetResponse(content: unknown, pairs: QuestionSheetGenerationInput['pairs']): GeneratedSheetQuestion[] {
  if (!isRecord(content) || !Array.isArray(content.questions)) {
    throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '模型返回的内容不是包含 questions 数组的 JSON 对象。')
  }
  const generated: GeneratedSheetQuestion[] = []
  content.questions.forEach((item, index) => {
    if (!isRecord(item)) return
    const question = text(item.question) ?? text(pairs[index]?.question)
    if (!question) return
    const answerText = pairs[index]?.answerText ?? ''
    const hasAnswer = answerText.trim().length > 0
    const tiers = parseTiers(item.tiers)
    const rawTier = text(item.aiTier) ?? text(item.aiTierName)
    const aiTier = hasAnswer && rawTier && TIER_NAMES.has(rawTier as QuestionTierName) ? (rawTier as QuestionTierName) : null
    const rawScore = Number(item.aiScore)
    const aiScore = hasAnswer && Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : null
    generated.push({
      seq: index + 1,
      question,
      dimension: text(item.dimension) ?? '综合能力',
      category: CATEGORIES.has(String(item.category)) ? String(item.category) : 'job_specific',
      difficulty: DIFFICULTIES.has(String(item.difficulty)) ? String(item.difficulty) : 'medium',
      tiers: tiers.length ? tiers : DEFAULT_QUESTION_TIERS.map((tier) => ({ ...tier })),
      aiTier,
      aiScore: aiTier === null ? null : aiScore,
      aiRationale: hasAnswer ? (text(item.rationale) ?? null) : null,
      aiEvidence: hasAnswer && Array.isArray(item.evidence) ? item.evidence.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).slice(0, 5) : [],
    })
  })
  if (!generated.length) throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '模型没有返回可用的题目。')
  return generated
}

function buildSystemPrompt(): string {
  return [
    '你是资深面试官助手。给定某轮面试的实际问答、岗位要求与技能要求，为每道题生成可执行的评分标准。',
    'Return ONLY a JSON object shaped as {"questions":[{"question":"...","dimension":"考察维度，例如 架构能力/系统设计","category":"technical|behavioral|experience|job_specific","difficulty":"easy|medium|hard","tiers":[{"tier":"excellent","min":90,"max":100,"description":"..."},{"tier":"pass","min":70,"max":89,"description":"..."},{"tier":"below","min":0,"max":69,"description":"..."}],"aiTier":"excellent|pass|below","aiScore":85,"rationale":"...","evidence":["引用候选人回答中的原话片段"]}]}.',
    '每道题必须给出三档 tiers，描述要具体到"做到什么算优秀/合格/待改进"，不要写空话。',
    '只有当该题提供了候选人回答时，才允许给出 aiTier、aiScore、rationale 与 evidence；没有回答的题必须把 aiTier 与 aiScore 设为 null，不得猜测分数。',
    'evidence 必须引用候选人回答中的原话。不得给出录用、淘汰、Offer 或流程状态结论。',
  ].join(' ')
}

export function createQuestionSheetGenerator(config: QuestionSheetGeneratorConfig, fetchImpl: FetchLike = fetch) {
  return {
    async generate(input: QuestionSheetGenerationInput): Promise<GeneratedSheetQuestion[]> {
      if (!input.pairs.length) throw new QuestionSheetGenerationError('INVALID_INPUT', '该轮面试没有可用于生成问题表的问答记录。')
      let response: Response
      try {
        response = await fetchImpl(`${config.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: buildSystemPrompt() },
              {
                role: 'user',
                content: JSON.stringify({
                  interviewTitle: input.interviewTitle,
                  jobTitle: input.jobTitle,
                  requirements: input.requirements,
                  skills: input.skills,
                  qa: input.pairs.map((pair, index) => ({ seq: index + 1, question: pair.question, answer: pair.answerText })),
                }),
              },
            ],
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch (error) {
        throw new QuestionSheetGenerationError('MODEL_REQUEST_FAILED', '面试问题表模型请求失败。', error)
      }
      if (!response.ok) {
        throw new QuestionSheetGenerationError('MODEL_HTTP_ERROR', await describeModelHttpFailure(response, config.apiKey, 'Interview question sheet model'))
      }
      let envelope: unknown
      try {
        envelope = await response.json()
      } catch (error) {
        throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '模型响应不是合法 JSON。', error)
      }
      const content = isRecord(envelope) && Array.isArray(envelope.choices) && isRecord(envelope.choices[0]) && isRecord(envelope.choices[0].message)
        ? envelope.choices[0].message.content
        : undefined
      let parsedContent: unknown = content
      if (typeof content === 'string') {
        try {
          parsedContent = JSON.parse(content)
        } catch (error) {
          throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '模型返回的内容不是合法 JSON。', error)
        }
      }
      return parseQuestionSheetResponse(parsedContent, input.pairs)
    },
  }
}

export type StageRecommendationName = 'strong_yes' | 'yes' | 'mixed' | 'no'

export interface StageReviewInput {
  stage: 'initial' | 'final'
  candidateName: string
  jobTitle: string
  requirements: string[]
  sheetSummaries: Array<{
    sheetType: string
    score: number | null
    ratings: Record<string, number>
    questions: Array<{ question: string; finalScore: number | null; comment: string | null; aiScore: number | null; aiEvidence: string[] }>
  }>
  recordingScore: number | null
}

export interface StageReviewOutput { recommendation: StageRecommendationName; score: number; rationale: string; evidence: string[] }

const RECOMMENDATIONS = new Set<StageRecommendationName>(['strong_yes', 'yes', 'mixed', 'no'])

export function parseStageReviewResponse(content: unknown): StageReviewOutput {
  if (!isRecord(content)) throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '阶段综合结论不是 JSON 对象。')
  const recommendation = text(content.recommendation)
  if (!recommendation || !RECOMMENDATIONS.has(recommendation as StageRecommendationName)) {
    throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', 'recommendation 必须是 strong_yes/yes/mixed/no。')
  }
  const rawScore = Number(content.score)
  return {
    recommendation: recommendation as StageRecommendationName,
    score: Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0,
    rationale: text(content.rationale) ?? '',
    evidence: Array.isArray(content.evidence) ? content.evidence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 8) : [],
  }
}

/** 阶段综合：初试给出是否推荐进复试，复试给出录取建议。始终只是建议，不改变申请状态。 */
export function createStageReviewGenerator(config: QuestionSheetGeneratorConfig, fetchImpl: FetchLike = fetch) {
  const systemPrompt = [
    '你是招聘决策辅助助手。给定候选人在某一面试阶段的各张面试表打分、评语与录音证据，输出该阶段的综合建议。',
    'Return ONLY a JSON object shaped as {"recommendation":"strong_yes|yes|mixed|no","score":85,"rationale":"...","evidence":["引用具体表或回答的片段"]}.',
    'initial 阶段的 recommendation 表示是否建议进入复试；final 阶段表示是否建议录用。',
    'evidence 必须引用具体的表项、评语或录音证据，不得编造；不得输出录用、淘汰等流程结论。',
    'evidence 与 rationale 全部使用简体中文自然表达：直接写"哪张表的哪道题、候选人原话或评语"，不要出现字段名（如 finalScore、aiEvidence、score、ratings）、不要写 JSON 键值对，面向 HR 与业务面试官阅读。',
  ].join(' ')
  return {
    async review(input: StageReviewInput): Promise<StageReviewOutput> {
      let response: Response
      try {
        response = await fetchImpl(`${config.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: JSON.stringify(input) },
            ],
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch (error) {
        throw new QuestionSheetGenerationError('MODEL_REQUEST_FAILED', '阶段综合模型请求失败。', error)
      }
      if (!response.ok) {
        throw new QuestionSheetGenerationError('MODEL_HTTP_ERROR', await describeModelHttpFailure(response, config.apiKey, 'Interview stage review model'))
      }
      let envelope: unknown
      try {
        envelope = await response.json()
      } catch (error) {
        throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '模型响应不是合法 JSON。', error)
      }
      const content = isRecord(envelope) && Array.isArray(envelope.choices) && isRecord(envelope.choices[0]) && isRecord(envelope.choices[0].message)
        ? envelope.choices[0].message.content
        : undefined
      if (typeof content !== 'string') throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '模型没有返回内容。')
      try {
        return parseStageReviewResponse(JSON.parse(content))
      } catch (error) {
        if (error instanceof QuestionSheetGenerationError) throw error
        throw new QuestionSheetGenerationError('MODEL_RESPONSE_INVALID', '模型返回的内容不是合法 JSON。', error)
      }
    },
  }
}
