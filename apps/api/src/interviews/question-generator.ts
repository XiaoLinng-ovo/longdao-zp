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
  const parsedTimeout = Number(env.OPENAI_TIMEOUT_MS ?? '30000')
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
        throw new InterviewQuestionGenerationError('MODEL_HTTP_ERROR', `Interview question model returned HTTP ${response.status}.`)
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
