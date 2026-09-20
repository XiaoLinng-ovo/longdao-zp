import { describeModelHttpFailure } from '../ai/model-http-error.js'

export type InterviewQuestionCategory = 'technical' | 'behavioral' | 'experience' | 'job_specific'
export type InterviewQuestionDifficulty = 'easy' | 'medium' | 'hard'

export interface InterviewScoringCriterion {
  criterion: string
  points: number
}

export interface GeneratedInterviewQuestion {
  category: InterviewQuestionCategory
  difficulty: InterviewQuestionDifficulty
  question: string
  rationale: string
  groundedIn: string[]
  scoringRubric: InterviewScoringCriterion[]
}

export interface InterviewQuestionSet {
  questions: GeneratedInterviewQuestion[]
  advisoryOnly: true
  applicationStatusMutation: 'none'
}

export interface InterviewQuestionGenerationInput {
  jobTitle: string
  jobRequirements: string[]
  anonymizedResume: string
  analysisSummary: string[]
  questionCount: number
}

export interface InterviewQuestionGeneratorConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export type InterviewQuestionGenerationErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'INVALID_INPUT'
  | 'MODEL_HTTP_ERROR'
  | 'MODEL_REQUEST_FAILED'
  | 'MODEL_RESPONSE_INVALID'

export class InterviewQuestionGenerationError extends Error {
  constructor(
    public readonly code: InterviewQuestionGenerationErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'InterviewQuestionGenerationError'
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const CATEGORIES = new Set<InterviewQuestionCategory>(['technical', 'behavioral', 'experience', 'job_specific'])
const DIFFICULTIES = new Set<InterviewQuestionDifficulty>(['easy', 'medium', 'hard'])

function required(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export function loadInterviewQuestionGeneratorConfig(
  env: NodeJS.ProcessEnv = process.env,
): InterviewQuestionGeneratorConfig {
  const baseUrl = required(env.OPENAI_BASE_URL)
  const apiKey = required(env.OPENAI_API_KEY)
  const model = required(env.OPENAI_MODEL)
  if (!baseUrl || !apiKey || !model) {
    throw new InterviewQuestionGenerationError(
      'AI_NOT_CONFIGURED',
      'Interview question generation requires OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL.',
    )
  }
  // 空值必须回落到默认值，否则会被当成 0 判为非法配置。
  const parsedTimeout = Number(env.OPENAI_TIMEOUT_MS?.trim() || '120000')
  if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
    throw new InterviewQuestionGenerationError('AI_NOT_CONFIGURED', 'OPENAI_TIMEOUT_MS must be a positive integer.')
  }
  try {
    new URL(baseUrl)
  } catch (error) {
    throw new InterviewQuestionGenerationError('AI_NOT_CONFIGURED', 'OPENAI_BASE_URL must be a valid URL.', error)
  }
  return { baseUrl, apiKey, model, timeoutMs: parsedTimeout }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseQuestion(value: unknown): GeneratedInterviewQuestion | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    'category', 'difficulty', 'question', 'rationale', 'groundedIn', 'scoringRubric',
  ])) return undefined
  if (!isNonEmptyString(value.category) || !CATEGORIES.has(value.category as InterviewQuestionCategory)) return undefined
  if (!isNonEmptyString(value.difficulty) || !DIFFICULTIES.has(value.difficulty as InterviewQuestionDifficulty)) return undefined
  if (!isNonEmptyString(value.question) || !isNonEmptyString(value.rationale)) return undefined
  if (!Array.isArray(value.groundedIn) || value.groundedIn.length === 0 || !value.groundedIn.every(isNonEmptyString)) return undefined
  if (!Array.isArray(value.scoringRubric) || value.scoringRubric.length === 0) return undefined

  const rubric: InterviewScoringCriterion[] = []
  for (const entry of value.scoringRubric) {
    if (!isRecord(entry) || !hasExactKeys(entry, ['criterion', 'points'])) return undefined
    if (!isNonEmptyString(entry.criterion) || !Number.isInteger(entry.points) || Number(entry.points) <= 0) return undefined
    rubric.push({ criterion: entry.criterion, points: Number(entry.points) })
  }
  if (rubric.reduce((sum, entry) => sum + entry.points, 0) !== 10) return undefined

  return {
    category: value.category as InterviewQuestionCategory,
    difficulty: value.difficulty as InterviewQuestionDifficulty,
    question: value.question,
    rationale: value.rationale,
    groundedIn: value.groundedIn,
    scoringRubric: rubric,
  }
}

function parseModelContent(content: unknown, expectedCount: number): GeneratedInterviewQuestion[] {
  if (!isNonEmptyString(content)) throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', 'Model response content is empty.')
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', 'Model response content is not valid JSON.', error)
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ['questions']) || !Array.isArray(parsed.questions)) {
    throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', 'Model response does not match the question schema.')
  }
  const questions = parsed.questions.map(parseQuestion)
  if (questions.length !== expectedCount || questions.some((question) => question === undefined)) {
    throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', 'Model response contains invalid questions.')
  }
  return questions as GeneratedInterviewQuestion[]
}

function validateInput(input: InterviewQuestionGenerationInput): void {
  if (!isNonEmptyString(input.jobTitle) || !isNonEmptyString(input.anonymizedResume)) {
    throw new InterviewQuestionGenerationError('INVALID_INPUT', 'Job title and anonymized resume are required.')
  }
  if (!Array.isArray(input.jobRequirements) || input.jobRequirements.length === 0 || !input.jobRequirements.every(isNonEmptyString)) {
    throw new InterviewQuestionGenerationError('INVALID_INPUT', 'At least one job requirement is required.')
  }
  if (!Array.isArray(input.analysisSummary) || !input.analysisSummary.every(isNonEmptyString)) {
    throw new InterviewQuestionGenerationError('INVALID_INPUT', 'Analysis summary must contain strings only.')
  }
  if (!Number.isInteger(input.questionCount) || input.questionCount < 1 || input.questionCount > 20) {
    throw new InterviewQuestionGenerationError('INVALID_INPUT', 'Question count must be an integer between 1 and 20.')
  }
}

export function createInterviewQuestionGenerator(config: InterviewQuestionGeneratorConfig, fetchImpl: FetchLike = fetch) {
  return {
    async generate(input: InterviewQuestionGenerationInput): Promise<InterviewQuestionSet> {
      validateInput(input)
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
              {
                role: 'system',
                content: 'Generate evidence-grounded interview questions for human interviewers. Return only JSON. Never recommend, reject, hire, offer, or change application status. Each question must use category technical|behavioral|experience|job_specific, difficulty easy|medium|hard, groundedIn evidence, and a scoringRubric totaling exactly 10 points.',
              },
              { role: 'user', content: JSON.stringify(input) },
            ],
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch (error) {
        throw new InterviewQuestionGenerationError('MODEL_REQUEST_FAILED', 'Interview question model request failed.', error)
      }
      if (!response.ok) {
        throw new InterviewQuestionGenerationError('MODEL_HTTP_ERROR', await describeModelHttpFailure(response, config.apiKey, 'Interview question model'))
      }
      let envelope: unknown
      try {
        envelope = await response.json()
      } catch (error) {
        throw new InterviewQuestionGenerationError('MODEL_RESPONSE_INVALID', 'Model response envelope is not valid JSON.', error)
      }
      const content = isRecord(envelope)
        && Array.isArray(envelope.choices)
        && isRecord(envelope.choices[0])
        && isRecord(envelope.choices[0].message)
        ? envelope.choices[0].message.content
        : undefined
      return {
        questions: parseModelContent(content, input.questionCount),
        advisoryOnly: true,
        applicationStatusMutation: 'none',
      }
    },
  }
}

function localRubric(): InterviewScoringCriterion[] {
  return [
    { criterion: '回答与简历证据一致', points: 4 },
    { criterion: '技术与岗位要求匹配', points: 3 },
    { criterion: '表达清晰且有具体案例', points: 3 },
  ]
}

export function generateLocalInterviewQuestions(input: InterviewQuestionGenerationInput): InterviewQuestionSet {
  validateInput(input)
  const primaryRequirement = input.jobRequirements[0] ?? input.jobTitle
  const secondaryRequirement = input.jobRequirements[1] ?? primaryRequirement
  const resumeLine = input.anonymizedResume.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? '简历经历'
  const summary = input.analysisSummary.find(Boolean) ?? '候选人简历与岗位存在可核实的匹配点'
  const templates: GeneratedInterviewQuestion[] = [
    {
      category: 'experience',
      difficulty: 'medium',
      question: `请结合简历中的“${resumeLine.slice(0, 40)}”，介绍一段最能体现你岗位能力的经历。`,
      rationale: '核验简历经历是否真实、完整，并了解候选人在项目中的实际职责。',
      groundedIn: [resumeLine.slice(0, 80)],
      scoringRubric: localRubric(),
    },
    {
      category: 'job_specific',
      difficulty: 'medium',
      question: `这个岗位重点关注“${primaryRequirement}”。请说明你过去如何解决过同类问题，结果如何？`,
      rationale: '验证候选人的经验是否直接覆盖岗位核心要求。',
      groundedIn: [primaryRequirement],
      scoringRubric: localRubric(),
    },
    {
      category: 'technical',
      difficulty: 'hard',
      question: `如果让你负责一个与“${secondaryRequirement}”相关的新项目，你会如何拆解方案、识别风险并推进落地？`,
      rationale: '评估候选人将既有技能迁移到新任务的方案设计能力。',
      groundedIn: [secondaryRequirement, summary],
      scoringRubric: localRubric(),
    },
    {
      category: 'behavioral',
      difficulty: 'medium',
      question: '请讲一次你和团队意见不一致、但最终推动项目前进的经历。你具体做了什么？',
      rationale: '评估协作、沟通和冲突处理能力。',
      groundedIn: ['简历分析与岗位要求'],
      scoringRubric: localRubric(),
    },
    {
      category: 'experience',
      difficulty: 'easy',
      question: '请说明你选择这个岗位的原因，以及你希望在入职后前三个月优先完成什么。',
      rationale: '了解求职动机、岗位理解和入职后的行动计划。',
      groundedIn: [input.jobTitle],
      scoringRubric: localRubric(),
    },
  ]
  const questions: GeneratedInterviewQuestion[] = Array.from({ length: input.questionCount }, (_, index) => {
    const base = templates[index % templates.length]!
    if (index < templates.length) return base
    return {
      ...base,
      difficulty: 'hard',
      question: `${base.question}（请补充更多量化结果或失败复盘）`,
    }
  })
  return { questions, advisoryOnly: true, applicationStatusMutation: 'none' }
}
