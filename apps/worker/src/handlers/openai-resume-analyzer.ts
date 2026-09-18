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

export function createOpenAIResumeAnalyzer(options: OpenAIResumeAnalyzerOptions): ResumeAnalyzer {
  const request = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  return async ({ task, content, context }): Promise<ResumeAnalysisResult> => {
    const report = buildRuleBasedReport({
      resume: {
        documentId: task.payload.resumeId, fileName: content.fileName, text: content.text,
        ...(content.mimeType === undefined ? {} : { mimeType: content.mimeType }),
        ...(task.payload.source === undefined ? {} : { source: task.payload.source }),
      },
      job: { ...(task.payload.jobId === undefined ? {} : { jobId: task.payload.jobId }), title: '', requirements: [] },
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
            { role: 'user', content: buildResumeAnalysisPrompt({ anonymizedResumeText: anonymized.text, job: { title: '', requirements: [] } }) },
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
    try {
      const payload: unknown = await response.json()
      suggestion = parseLlmResumeSuggestion(JSON.parse(responseContent(payload)))
    } catch (error: unknown) {
      throw new WorkerFailure('Resume analysis model returned invalid structured JSON', {
        category: 'validation', code: 'MODEL_RESPONSE_INVALID', retryable: false, cause: error,
      })
    }
    report.assessment = {
      ...report.assessment,
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
