import { WorkerFailure } from '../errors.js'
import type { TaskEnvelope, TaskHandler, TaskHandlerContext } from '../task.js'

export interface ResumeAnalysisTaskPayload {
  applicationId?: string
  resumeId: string
  candidateId?: string
  jobId?: string
  fileName: string
  mimeType?: string
  /** Inline text is useful for tests and small migration jobs. */
  text?: string
  /** Production storage integration will resolve this reference in a later phase. */
  storageKey?: string
  contentSha256?: string
  source?: 'upload' | 'paste' | 'test' | 'migration'
}

export interface ResumeContent {
  text: string
  fileName: string
  mimeType?: string
  contentSha256?: string
}

export interface ResumeAnalysisInput {
  task: TaskEnvelope<'resume-analysis', ResumeAnalysisTaskPayload>
  content: ResumeContent
  context: TaskHandlerContext
}

export interface ResumeAnalysisResult {
  taskType: 'resume-analysis'
  status: 'completed'
  applicationId?: string
  resumeId: string
  candidateId?: string
  jobId?: string
  document: {
    fileName: string
    mimeType?: string
    textLength: number
    normalizedTextLength: number
    contentSha256?: string
  }
  analysis: {
    engine: string
    analyzerStatus: 'skeleton'
    generatedAt: string
  }
  safety: {
    advisoryOnly: true
    applicationStatusMutation: 'none'
    autoReject: false
    autoHire: false
    autoOffer: false
  }
}

export type ResumeTextLoader = (
  payload: ResumeAnalysisTaskPayload,
  context: TaskHandlerContext,
) => Promise<ResumeContent>

export type ResumeAnalyzer = (input: ResumeAnalysisInput) => Promise<ResumeAnalysisResult>

export interface ResumeAnalysisHandlerOptions {
  loadText?: ResumeTextLoader
  analyze?: ResumeAnalyzer
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkerFailure(`${field} must be a non-empty string`, {
      category: 'validation',
      code: 'INVALID_RESUME_ANALYSIS_PAYLOAD',
    })
  }
  return value.trim()
}

function validatePayload(payload: ResumeAnalysisTaskPayload): ResumeAnalysisTaskPayload {
  if (payload.applicationId !== undefined) requireString(payload.applicationId, 'applicationId')
  requireString(payload.resumeId, 'resumeId')
  requireString(payload.fileName, 'fileName')

  if (payload.mimeType !== undefined) requireString(payload.mimeType, 'mimeType')
  if (payload.text !== undefined && typeof payload.text !== 'string') {
    throw new WorkerFailure('text must be a string when provided', {
      category: 'validation',
      code: 'INVALID_RESUME_TEXT',
    })
  }
  if (payload.storageKey !== undefined) requireString(payload.storageKey, 'storageKey')
  if (payload.contentSha256 !== undefined) requireString(payload.contentSha256, 'contentSha256')

  if ((payload.text === undefined || payload.text.trim() === '') && payload.storageKey === undefined) {
    throw new WorkerFailure('Either text or storageKey is required for resume analysis', {
      category: 'validation',
      code: 'RESUME_CONTENT_MISSING',
    })
  }
  return payload
}

async function defaultTextLoader(
  payload: ResumeAnalysisTaskPayload,
  _context: TaskHandlerContext,
): Promise<ResumeContent> {
  if (payload.storageKey === undefined) {
    throw new WorkerFailure('No resume text loader is configured for this task', {
      category: 'dependency_unavailable',
      code: 'RESUME_STORAGE_ADAPTER_MISSING',
    })
  }

  throw new WorkerFailure(`Resume storage reference cannot be read yet: ${payload.storageKey}`, {
    category: 'dependency_unavailable',
    code: 'RESUME_STORAGE_ADAPTER_MISSING',
  })
}

/**
 * This is intentionally a small default analyzer. It validates and summarizes the
 * input but does not claim to produce the full resume-intelligence report. The
 * production adapter can be injected without changing the task envelope or runner.
 */
async function defaultAnalyzer(input: ResumeAnalysisInput): Promise<ResumeAnalysisResult> {
  const { task, content, context } = input
  const normalizedText = content.text.replace(/\s+/gu, ' ').trim()
  const result: ResumeAnalysisResult = {
    taskType: 'resume-analysis',
    status: 'completed',
    resumeId: task.payload.resumeId,
    document: {
      fileName: content.fileName,
      textLength: content.text.length,
      normalizedTextLength: normalizedText.length,
    },
    analysis: {
      engine: 'resume-intelligence-port',
      analyzerStatus: 'skeleton',
      generatedAt: context.now(),
    },
    safety: {
      advisoryOnly: true,
      applicationStatusMutation: 'none',
      autoReject: false,
      autoHire: false,
      autoOffer: false,
    },
  }

  if (task.payload.applicationId !== undefined) result.applicationId = task.payload.applicationId
  if (task.payload.candidateId !== undefined) result.candidateId = task.payload.candidateId
  if (task.payload.jobId !== undefined) result.jobId = task.payload.jobId
  if (content.mimeType !== undefined) result.document.mimeType = content.mimeType
  if (content.contentSha256 !== undefined) result.document.contentSha256 = content.contentSha256
  return result
}

function assertTaskPayload(task: TaskEnvelope<'resume-analysis', ResumeAnalysisTaskPayload>): void {
  if (task.payload === null || typeof task.payload !== 'object') {
    throw new WorkerFailure('resume-analysis payload must be an object', {
      category: 'validation',
      code: 'INVALID_RESUME_ANALYSIS_PAYLOAD',
    })
  }
}

export function createResumeAnalysisHandler(
  options: ResumeAnalysisHandlerOptions = {},
): TaskHandler<'resume-analysis', ResumeAnalysisTaskPayload, ResumeAnalysisResult> {
  const loadText = options.loadText ?? defaultTextLoader
  const analyze = options.analyze ?? defaultAnalyzer

  return async (task, context) => {
    assertTaskPayload(task)
    const payload = validatePayload(task.payload)
    const content = payload.text !== undefined && payload.text.trim() !== ''
      ? {
          text: payload.text,
          fileName: payload.fileName,
          ...(payload.mimeType === undefined ? {} : { mimeType: payload.mimeType }),
          ...(payload.contentSha256 === undefined ? {} : { contentSha256: payload.contentSha256 }),
        }
      : await loadText(payload, context)

    if (content.text.trim() === '') {
      throw new WorkerFailure('Resume text must not be empty', {
        category: 'validation',
        code: 'EMPTY_RESUME_TEXT',
      })
    }

    return analyze({ task, content, context })
  }
}

export const resumeAnalysisHandler = createResumeAnalysisHandler()
