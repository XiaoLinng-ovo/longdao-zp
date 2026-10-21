import { WorkerFailure } from '../errors.js'
import type { TaskEnvelope, TaskHandler, TaskHandlerContext } from '../task.js'
import { buildJobRequirements, buildRuleBasedReport, resumeBodyCharacterCount, resumeTextHasEncodingDamage, type AnalysisReport, type LlmResumeSuggestion, type ResumeScoringSkill } from '@smartrecruit-pro/resume-intelligence'

export interface ResumeAnalysisTaskPayload {
  applicationId?: string
  resumeId: string
  candidateId?: string
  jobId?: string
  jobTitle?: string
  jobRequirements?: string[]
  jobSkills?: string[]
  jobRequirementRequired?: boolean[]
  scoringSkill?: ResumeScoringSkill
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
    generatedAt: string
    report: AnalysisReport
    suggestion?: LlmResumeSuggestion
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
  if (payload.jobTitle !== undefined) requireString(payload.jobTitle, 'jobTitle')
  if (payload.jobRequirements !== undefined && (!Array.isArray(payload.jobRequirements) || payload.jobRequirements.some((item) => typeof item !== 'string'))) {
    throw new WorkerFailure('jobRequirements must be an array of strings when provided', {
      category: 'validation',
      code: 'INVALID_RESUME_ANALYSIS_PAYLOAD',
    })
  }
  if (payload.jobSkills !== undefined && (!Array.isArray(payload.jobSkills) || payload.jobSkills.some((item) => typeof item !== 'string'))) {
    throw new WorkerFailure('jobSkills must be an array of strings when provided', {
      category: 'validation',
      code: 'INVALID_RESUME_ANALYSIS_PAYLOAD',
    })
  }

  if (payload.jobRequirementRequired !== undefined && (!Array.isArray(payload.jobRequirementRequired) || payload.jobRequirementRequired.some((item) => typeof item !== 'boolean') || payload.jobRequirementRequired.length !== (payload.jobRequirements?.length ?? 0))) {
    throw new WorkerFailure('jobRequirementRequired must contain one boolean per job requirement', {
      category: 'validation', code: 'INVALID_RESUME_ANALYSIS_PAYLOAD',
    })
  }

  if (payload.scoringSkill !== undefined) {
    const skill = payload.scoringSkill
    if (!payload.jobId || !skill || typeof skill !== 'object' ||
      typeof skill.id !== 'string' || !skill.id.trim() || typeof skill.name !== 'string' || !skill.name.trim() ||
      typeof skill.content !== 'string' || !skill.content.trim() || skill.content.length > 8000 ||
      typeof skill.updatedAt !== 'string' || !skill.updatedAt.trim()) {
      throw new WorkerFailure('Invalid job scoring Skill', { category: 'validation', code: 'INVALID_SCORING_SKILL', retryable: false })
    }
  }
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

export async function defaultAnalyzer(input: ResumeAnalysisInput): Promise<ResumeAnalysisResult> {
  const { task, content, context } = input
  if (task.payload.scoringSkill) throw new WorkerFailure('该岗位已配置 AI 评分 Skill，请先配置 AI 模型并重启 Worker；不能用默认规则代替专属评分规则。', {
    category: 'dependency_unavailable', code: 'SCORING_SKILL_AI_REQUIRED', retryable: false,
  })
  if (task.payload.jobRequirements?.some((v) => v.trim()) || task.payload.jobSkills?.some((v) => v.trim())) throw new WorkerFailure('岗位评分需要配置大模型进行语义理解；不能用关键词算法代替。请配置 AI 模型并重启 Worker。', {
    category: 'dependency_unavailable', code: 'SEMANTIC_SCORING_AI_REQUIRED', retryable: false,
  })
  const normalizedText = content.text.replace(/\s+/gu, ' ').trim()
  const job = {
    ...(task.payload.jobId === undefined ? {} : { jobId: task.payload.jobId }),
    title: task.payload.jobTitle ?? '',
    requirements: buildJobRequirements({
      ...(task.payload.jobId === undefined ? {} : { jobId: task.payload.jobId }),
      ...(task.payload.jobRequirements === undefined ? {} : { requirementLabels: task.payload.jobRequirements }),
      ...(task.payload.jobRequirementRequired === undefined ? {} : { requirementRequired: task.payload.jobRequirementRequired }),
      ...(task.payload.jobSkills === undefined ? {} : { skills: task.payload.jobSkills }),
    }),
  }
  const report = buildRuleBasedReport({
    resume: {
      documentId: task.payload.resumeId,
      fileName: content.fileName,
      text: content.text,
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
      engine: report.provenance.engine,
      generatedAt: context.now(),
      report,
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

    if (resumeBodyCharacterCount(content.text) < 5) {
      throw new WorkerFailure('未提取到有效简历正文，不能生成评分；扫描件或仅有水印的 PDF 需要 OCR 识别。', {
        category: 'validation', code: 'RESUME_BODY_MISSING', retryable: false,
      })
    }

    if (resumeTextHasEncodingDamage(content.text)) {
      throw new WorkerFailure('简历正文存在明显乱码或缺失字形，尚未生成评分；请先完成 OCR 识别或重新导出原文件。', {
        category: 'validation', code: 'RESUME_TEXT_GARBLED', retryable: false,
      })
    }

    return analyze({ task, content, context })
  }
}

export const resumeAnalysisHandler = createResumeAnalysisHandler()
