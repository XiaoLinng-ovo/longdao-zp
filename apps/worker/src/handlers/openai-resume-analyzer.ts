import {
  PROMPT_VERSION,
  anonymizeText,
  buildResumeAnalysisPrompt,
  buildRuleBasedReport,
  parseLlmResumeSuggestion,
} from '@smartrecruit-pro/resume-intelligence'
import { WorkerFailure } from '../errors.js'
import type { ResumeAnalysisResult, ResumeAnalyzer } from './resume-analysis.js'

export interface OpenAIResumeAnalyzerOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetch?: typeof fetch
}

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/chat/completions`
}

function responseContent(value: unknown): string {
  if (value === null || typeof value !== 'object') throw new TypeError('response must be an object')
  const choices = Reflect.get(value, 'choices')
  if (!Array.isArray(choices) || choices.length === 0) throw new TypeError('choices must not be empty')
  const message = choices[0] && typeof choices[0] === 'object' ? Reflect.get(choices[0], 'message') : undefined
  const content = message && typeof message === 'object' ? Reflect.get(message, 'content') : undefined
  if (typeof content !== 'string' || content.trim() === '') throw new TypeError('message content must be a string')
  return content
}

function likelyHeaderName(text: string): string | undefined {
  const firstToken = text.trimStart().split(/\s/u, 1)[0]?.trim()
  return firstToken && /^[\p{Script=Han}]{2,4}$/u.test(firstToken) ? firstToken : undefined
}

function extractJsonContent(content: string): string {
  const trimmed = content.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/u)
  if (fence?.[1]) return fence[1].trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed
}

function textItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return item.trim()
    if (!item || typeof item !== 'object') return ''
    const row = item as Record<string, unknown>
    return ['point', 'label', 'summary', 'evidence', 'requirement', 'question']
      .map((key) => row[key])
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .join('：')
  }).filter(Boolean)
}

export function createOpenAIResumeAnalyzer(options: OpenAIResumeAnalyzerOptions): ResumeAnalyzer {
  const request = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  return async ({ task, content, context }): Promise<ResumeAnalysisResult> => {
    const requirementLabels = task.payload.jobRequirements ?? []
    const job = {
      ...(task.payload.jobId === undefined ? {} : { jobId: task.payload.jobId }),
      title: task.payload.jobTitle ?? '',
      requirements: requirementLabels.map((label, index) => ({
        id: `${task.payload.jobId ?? 'job'}-requirement-${index + 1}`,
        label,
        kind: 'other' as const,
        keywords: [label],
        hard: index === 0,
      })),
    }
    const report = buildRuleBasedReport({
      resume: {
        documentId: task.payload.resumeId, fileName: content.fileName, text: content.text,
        ...(content.mimeType === undefined ? {} : { mimeType: content.mimeType }),
        ...(task.payload.source === undefined ? {} : { source: task.payload.source }),
      },
      job,
      subject: {
        resumeId: task.payload.resumeId,
        ...(task.payload.applicationId === undefined ? {} : { applicationId: task.payload.applicationId }),
        ...(task.payload.candidateId === undefined ? {} : { candidateId: task.payload.candidateId }),
        ...(task.payload.jobId === undefined ? {} : { jobId: task.payload.jobId }),
      },
      generatedAt: context.now(),
    })
    const candidateName = likelyHeaderName(report.parsedResume.normalizedText) ?? report.extraction.candidate.fullName
    const anonymized = anonymizeText(report.parsedResume.normalizedText, {
      ...(candidateName === undefined ? {} : { name: candidateName }),
      replaceNames: Boolean(report.extraction.candidate.fullName),
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await request(endpoint(options.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          response_format: { type: 'json_object' },
          temperature: 0,
          messages: [
            { role: 'system', content: '只返回符合要求的 JSON。分析仅供人工参考，不得作出自动招聘决定。' },
            { role: 'user', content: buildResumeAnalysisPrompt({ anonymizedResumeText: anonymized.text, job }) },
          ],
        }),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new WorkerFailure('Resume analysis model timed out', { category: 'timeout', code: 'MODEL_TIMEOUT', cause: error })
      }
      throw new WorkerFailure('Resume analysis model request failed', { category: 'network', code: 'MODEL_NETWORK_ERROR', cause: error })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      throw new WorkerFailure(`Resume analysis model returned HTTP ${response.status}`, {
        category: response.status === 429 ? 'rate_limited' : 'dependency_unavailable',
        code: 'MODEL_HTTP_ERROR',
      })
    }
    let suggestion
    let rawContent = ''
    try {
      const payload: unknown = await response.json()
      rawContent = responseContent(payload)
      const parsed = JSON.parse(extractJsonContent(rawContent)) as Record<string, unknown>
      if (parsed.summary !== undefined && typeof parsed.summary !== 'string') throw new TypeError('summary must be a string')
      if (parsed.score !== undefined && typeof parsed.score !== 'number') throw new TypeError('score must be a number')
      if (parsed.matchScore !== undefined && typeof parsed.matchScore !== 'number') throw new TypeError('matchScore must be a number')
      for (const key of ['strengths', 'risks', 'matchedRequirements', 'conflicts', 'interviewQuestions'] as const) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new TypeError(`${key} must be an array`)
      }
      if (parsed.confidence !== undefined && typeof parsed.confidence !== 'number') throw new TypeError('confidence must be a number')
      suggestion = parseLlmResumeSuggestion({
        summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary : report.assessment.strengths[0] || '已完成模型分析',
        score: typeof parsed.score === 'number' ? parsed.score : typeof parsed.matchScore === 'number' ? parsed.matchScore : report.assessment.score,
        strengths: textItems(parsed.strengths),
        risks: textItems(parsed.risks),
        matchedRequirements: textItems(parsed.matchedRequirements),
        conflicts: textItems(parsed.conflicts),
        interviewQuestions: textItems(parsed.interviewQuestions),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      })
    } catch (error: unknown) {
      throw new WorkerFailure(`Resume analysis model returned invalid structured JSON: ${error instanceof Error ? error.message : 'unknown'} | ${rawContent.slice(0, 500)}`, {
        category: 'validation', code: 'MODEL_RESPONSE_INVALID', retryable: false, cause: error,
      })
    }
    report.assessment = {
      ...report.assessment,
      score: suggestion.score,
      recommendation: suggestion.score >= 85 ? 'strong_match' : suggestion.score >= 70 ? 'match' : suggestion.score >= 55 ? 'needs_review' : 'weak_match',
      strengths: suggestion.strengths,
      risks: suggestion.risks,
      interviewQuestions: suggestion.interviewQuestions,
      confidence: suggestion.confidence,
    }
    report.provenance = {
      ...report.provenance, engine: 'llm-suggestion', promptVersion: PROMPT_VERSION,
      modelProvider: 'openai-compatible', modelName: options.model,
    }
    return {
      taskType: 'resume-analysis', status: 'completed', resumeId: task.payload.resumeId,
      ...(task.payload.applicationId === undefined ? {} : { applicationId: task.payload.applicationId }),
      ...(task.payload.candidateId === undefined ? {} : { candidateId: task.payload.candidateId }),
      ...(task.payload.jobId === undefined ? {} : { jobId: task.payload.jobId }),
      document: {
        fileName: content.fileName, textLength: content.text.length,
        normalizedTextLength: report.parsedResume.normalizedText.length,
        ...(content.mimeType === undefined ? {} : { mimeType: content.mimeType }),
        ...(content.contentSha256 === undefined ? {} : { contentSha256: content.contentSha256 }),
      },
      analysis: { engine: 'llm-suggestion', generatedAt: context.now(), report, suggestion },
      safety: { advisoryOnly: true, applicationStatusMutation: 'none', autoReject: false, autoHire: false, autoOffer: false },
    }
  }
}
