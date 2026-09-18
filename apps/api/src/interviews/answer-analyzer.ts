export interface InterviewAnswerAnalyzerConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number }
export interface InterviewAnswerAnalysisInput { question: string; candidateAnswer: string; jobTitle: string; jobRequirements: string[]; priorContext: string[] }
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

function parseAnalysis(content: unknown): Omit<InterviewAnswerAnalysis, 'advisoryOnly' | 'applicationStatusMutation'> {
  if (!isText(content)) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response content is empty.')
  let value: unknown
  try { value = JSON.parse(content) } catch (error) { throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response content is not valid JSON.', error) }
  const keys = ['concerns', 'confidence', 'evidence', 'nextQuestion', 'scores', 'summary']
  if (!isRecord(value) || Object.keys(value).sort().join('|') !== keys.join('|')) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response does not match the answer analysis schema.')
  if (!isText(value.summary) || !isText(value.nextQuestion) || typeof value.confidence !== 'number' || value.confidence < 0 || value.confidence > 1) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response contains invalid summary, question, or confidence.')
  if (!Array.isArray(value.evidence) || !value.evidence.every(isText) || !Array.isArray(value.concerns) || !value.concerns.every(isText) || !Array.isArray(value.scores) || value.scores.length === 0) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response contains invalid evidence, concerns, or scores.')
  const scores = value.scores.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).sort().join('|') !== 'dimension|rationale|score' || !isText(entry.dimension) || !isText(entry.rationale) || typeof entry.score !== 'number' || entry.score < 0 || entry.score > 10) throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response contains an invalid dimension score.')
    return { dimension: entry.dimension, score: entry.score, rationale: entry.rationale }
  })
  return { summary: value.summary, evidence: value.evidence, scores, concerns: value.concerns, confidence: value.confidence, nextQuestion: value.nextQuestion }
}

export function createInterviewAnswerAnalyzer(config: InterviewAnswerAnalyzerConfig, fetchImpl: FetchLike = fetch) {
  return { async analyze(input: InterviewAnswerAnalysisInput): Promise<InterviewAnswerAnalysis> {
    if (![input.question, input.candidateAnswer, input.jobTitle].every(isText) || !input.jobRequirements.length) throw new InterviewAnswerAnalysisError('INVALID_INPUT', 'Question, candidate answer, job title, and requirements are required.')
    let response: Response
    try {
      response = await fetchImpl(`${config.baseUrl.replace(/\/$/u, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: config.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Analyze only the candidate answer using quoted evidence. Return strict JSON with summary, evidence, scores[{dimension,score 0-10,rationale}], concerns, confidence 0-1, nextQuestion. Never return a hiring, rejection, offer, or application-status decision.' }, { role: 'user', content: JSON.stringify(input) }] }), signal: AbortSignal.timeout(config.timeoutMs) })
    } catch (error) { throw new InterviewAnswerAnalysisError('MODEL_REQUEST_FAILED', 'Interview answer model request failed.', error) }
    if (!response.ok) throw new InterviewAnswerAnalysisError('MODEL_HTTP_ERROR', `Interview answer model returned HTTP ${response.status}.`)
    let envelope: unknown
    try { envelope = await response.json() } catch (error) { throw new InterviewAnswerAnalysisError('MODEL_RESPONSE_INVALID', 'Model response envelope is not valid JSON.', error) }
    const content = isRecord(envelope) && Array.isArray(envelope.choices) && isRecord(envelope.choices[0]) && isRecord(envelope.choices[0].message) ? envelope.choices[0].message.content : undefined
    return { ...parseAnalysis(content), advisoryOnly: true, applicationStatusMutation: 'none' }
  } }
}
