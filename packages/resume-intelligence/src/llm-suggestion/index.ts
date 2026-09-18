export interface LlmResumeSuggestion {
  summary: string
  strengths: string[]
  risks: string[]
  matchedRequirements: string[]
  conflicts: string[]
  interviewQuestions: string[]
  confidence: number
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('LLM suggestion must be a JSON object')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  return value.trim()
}

function textArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${field} must be an array of strings`)
  }
  return value.map((item) => item.trim()).filter(Boolean)
}

export function parseLlmResumeSuggestion(value: unknown): LlmResumeSuggestion {
  const input = record(value)
  const summary = text(input.summary, 'summary')
  const confidence = input.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new TypeError('confidence must be a number between 0 and 1')
  }
  return {
    summary,
    strengths: textArray(input.strengths, 'strengths'),
    risks: textArray(input.risks, 'risks'),
    matchedRequirements: textArray(input.matchedRequirements, 'matchedRequirements'),
    conflicts: textArray(input.conflicts, 'conflicts'),
    interviewQuestions: textArray(input.interviewQuestions, 'interviewQuestions'),
    confidence,
  }
}
