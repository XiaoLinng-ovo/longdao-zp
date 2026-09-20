export interface InterviewAnswerAnalyzerConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number }
export interface InterviewAnswerAnalysisInput { question: string; candidateAnswer: string; jobTitle: string; jobRequirements: string[]; priorContext: string[]; resumeContext?: string[] }
export interface InterviewDimensionScore { dimension: string; score: number; rationale: string }
export interface InterviewAnswerAnalysis { summary: string; evidence: string[]; scores: InterviewDimensionScore[]; concerns: string[]; confidence: number; nextQuestion: string; advisoryOnly: true; applicationStatusMutation: 'none' }
export type InterviewAnswerAnalysisErrorCode = 'AI_NOT_CONFIGURED' | 'INVALID_INPUT' | 'MODEL_HTTP_ERROR' | 'MODEL_REQUEST_FAILED' | 'MODEL_RESPONSE_INVALID'

export class InterviewAnswerAnalysisError extends Error {
  constructor(public readonly code: InterviewAnswerAnalysisErrorCode, message: string, public readonly cause?: unknown) { super(message); this.name = 'InterviewAnswerAnalysisError' }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
const required = (value: string | undefined) => value?.trim() || undefined
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function loadInterviewAnswerAnalyzerConfig(env: NodeJS.ProcessEnv = process.env): InterviewAnswerAnalyzerConfig {
  const baseUrl = required(env.OPENAI_BASE_URL); const apiKey = required(env.OPENAI_API_KEY); const model = required(env.OPENAI_MODEL)
  const timeoutMs = Number(env.OPENAI_TIMEOUT_MS ?? '30000')
  if (!baseUrl || !apiKey || !model || !Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new InterviewAnswerAnalysisError('AI_NOT_CONFIGURED', 'Interview answer analysis requires valid OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, and OPENAI_TIMEOUT_MS.')
  try { new URL(baseUrl) } catch (error) { throw new InterviewAnswerAnalysisError('AI_NOT_CONFIGURED', 'OPENAI_BASE_URL must be a valid URL.', error) }
  return { baseUrl, apiKey, model, timeoutMs }
}

// 模型可能把 JSON 包在 markdown 代码块里，或在其前后夹杂解释性文本。先提取纯 JSON 文本再解析。
function extractJsonContent(content: string): string {
  const trimmed = content.trim()
  if (trimmed.startsWith('{')) return trimmed
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1]!.trim()
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1)
  return trimmed
}

const REQUIRED_KEYS = ['summary', 'evidence', 'scores', 'concerns', 'confidence', 'nextQuestion'] as const
// fail-closed：模型绝不能越权输出招聘/录用/拒绝决策。出现这些键一律拒绝。
const DECISION_KEYS = ['decision', 'recommendation', 'verdict', 'outcome', 'hire', 'reject', 'offer', 'hiringDecision', 'rejection', 'applicationStatus', 'applicationStatusMutation'] as const

function parseAnalysis(content: unknown): Omit<InterviewAnswerAnalysis, 'advisoryOnly' | 'applicationStatusMutation'> {
  if (!isText(content)) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response content is empty.')
  let value: unknown
  try { value = JSON.parse(extractJsonContent(content)) } catch (error) { throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response content is not valid JSON.', error) }
  if (!isRecord(value)) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response is not a JSON object.')
  for (const key of DECISION_KEYS) if (key in value) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', `Model response must not include a hiring or rejection decision (found "${key}").`)
  for (const key of REQUIRED_KEYS) if (!(key in value)) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', `Model response is missing required field "${key}".`)
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter(isText) : undefined
  const concerns = Array.isArray(value.concerns) ? value.concerns.filter(isText) : undefined
  const scores = Array.isArray(value.scores) ? value.scores : undefined
  if (!evidence || !concerns || !scores || scores.length === 0) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response contains invalid evidence, concerns, or scores.')
  if (!isText(value.summary) || !isText(value.nextQuestion) || typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response contains invalid summary, question, or confidence.')
  const parsedScores = scores.map((entry) => {
    if (!isRecord(entry) || typeof entry.score !== 'number' || entry.score < 0 || entry.score > 10 || !isText(entry.dimension) || !isText(entry.rationale)) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response contains an invalid dimension score.')
    return { dimension: entry.dimension, score: entry.score, rationale: entry.rationale }
  })
  return { summary: value.summary, evidence, scores: parsedScores, concerns, confidence: value.confidence, nextQuestion: value.nextQuestion }
}

export function createInterviewAnswerAnalyzer(config: InterviewAnswerAnalyzerConfig, fetchImpl: FetchLike = fetch) {
  const requestOnce = async (input: InterviewAnswerAnalysisInput): Promise<Omit<InterviewAnswerAnalysis, 'advisoryOnly' | 'applicationStatusMutation'>> => {
    let response: Response
    try {
      response = await fetchImpl(`${config.baseUrl.replace(/\/$/u, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Analyze only the candidate answer using quoted evidence. Use resumeContext and priorContext when provided to check consistency and choose a useful follow-up question. Return strict JSON with summary, evidence, scores[{dimension,score 0-10,rationale}], concerns, confidence 0-1, nextQuestion. Never return a hiring, rejection, offer, or application-status decision.' }, { role: 'user', content: JSON.stringify(input) }] }), signal: AbortSignal.timeout(config.timeoutMs) })
    } catch (error) { throw new InterviewAnswerAnalysisError('MODEL_REQUEST_FAILED', 'Interview answer model request failed.', error) }
    if (!response.ok) throw new InterviewAnswerAnalysisError('MODEL_HTTP_ERROR', `Interview answer model returned HTTP ${response.status}.`)
    let envelope: unknown
    try { envelope = await response.json() } catch (error) { throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response envelope is not valid JSON.', error) }
    const content = isRecord(envelope) && Array.isArray(envelope.choices) && isRecord(envelope.choices[0]) && isRecord(envelope.choices[0].message) ? envelope.choices[0].message.content : undefined
    return parseAnalysis(content)
  }
  return { async analyze(input: InterviewAnswerAnalysisInput): Promise<InterviewAnswerAnalysis> {
    if (![input.question, input.candidateAnswer, input.jobTitle].every(isText) || !input.jobRequirements.length) throw new InterviewAnswerAnalysisError('INVALID_INPUT', 'Question, candidate answer, job title, and requirements are required.')
    // 模型偶发输出结构不合规时重试一次，显著降低单次抖动导致的整体失败。
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { const analysis = await requestOnce(input); return { ...analysis, advisoryOnly: true, applicationStatusMutation: 'none' } }
      catch (error) { lastError = error; if (!(error instanceof InterviewAnswerAnalysisError) || error.code !== 'MODEL_RESPONSE_INVALID') throw error }
    }
    throw lastError
  } }
}
