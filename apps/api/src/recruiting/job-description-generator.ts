export interface GeneratedJobDescription {
  language: string
  content: string
  generatedBy: 'ai_assisted' | 'local_fallback'
}

export interface JobDescriptionGenerationInput {
  jobTitle: string
  spec?: {
    summary?: string
    responsibilities?: string[]
    requirements?: Array<{ label: string; description?: string; required?: boolean }>
    skills?: string[]
  } | undefined
}

export interface JobDescriptionGeneratorConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs: number
}

export type JobDescriptionGenerationErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'INVALID_INPUT'
  | 'MODEL_HTTP_ERROR'
  | 'MODEL_REQUEST_FAILED'
  | 'MODEL_RESPONSE_INVALID'

export class JobDescriptionGenerationError extends Error {
  constructor(
    public readonly code: JobDescriptionGenerationErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'JobDescriptionGenerationError'
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function extractJsonContent(content: string): string {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)
  return fenced?.[1]?.trim() ?? trimmed
}

export function loadJobDescriptionGeneratorConfig(env: NodeJS.ProcessEnv = process.env): JobDescriptionGeneratorConfig {
  const baseUrl = optionalText(env.OPENAI_BASE_URL)
  const apiKey = optionalText(env.OPENAI_API_KEY)
  const model = optionalText(env.OPENAI_MODEL)
  if (!baseUrl || !apiKey || !model) {
    throw new JobDescriptionGenerationError(
      'AI_NOT_CONFIGURED',
      'Job description generation requires OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL.',
    )
  }
  const timeoutMs = Number(env.OPENAI_TIMEOUT_MS ?? '30000')
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new JobDescriptionGenerationError('AI_NOT_CONFIGURED', 'OPENAI_TIMEOUT_MS must be a positive integer.')
  }
  try {
    new URL(baseUrl)
  } catch (error) {
    throw new JobDescriptionGenerationError('AI_NOT_CONFIGURED', 'OPENAI_BASE_URL must be a valid URL.', error)
  }
  return { baseUrl, apiKey, model, timeoutMs }
}

function parseModelContent(content: unknown): string {
  if (!isNonEmptyString(content)) {
    throw new JobDescriptionGenerationError('MODEL_RESPONSE_INVALID', 'Model response content is empty.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonContent(content))
  } catch (error) {
    throw new JobDescriptionGenerationError('MODEL_RESPONSE_INVALID', 'Model response content is not valid JSON.', error)
  }
  if (!isRecord(parsed) || !isNonEmptyString(parsed.content)) {
    throw new JobDescriptionGenerationError('MODEL_RESPONSE_INVALID', 'Model response does not match the job description schema.')
  }
  return parsed.content.trim()
}

function formatList(items: string[], ordered = false): string {
  return items.map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${item}`).join('\n')
}

function requirementLine(item: { label: string; description?: string; required?: boolean }): string {
  return item.description ? `${item.label}：${item.description}` : item.label
}

export function generateLocalJobDescription(input: JobDescriptionGenerationInput): GeneratedJobDescription {
  const jobTitle = input.jobTitle?.trim()
  if (!jobTitle) throw new JobDescriptionGenerationError('INVALID_INPUT', 'Job title is required.')
  const spec = input.spec
  const summary = spec?.summary?.trim() || `负责${jobTitle}相关工作的规划、执行与持续优化，支撑业务目标达成。`
  const responsibilities = (spec?.responsibilities ?? []).filter(isNonEmptyString)
  const requirements = (spec?.requirements ?? []).map(requirementLine).filter(isNonEmptyString)
  const skills = (spec?.skills ?? []).filter(isNonEmptyString)
  const fallbackResponsibilities = responsibilities.length ? responsibilities : [`负责${jobTitle}相关业务的分析、方案设计与落地`, '参与关键项目执行，跟进进度、质量和结果', '与相关部门协作，保证目标按期达成']
  const fallbackRequirements = requirements.length ? requirements : ['本科及以上学历，相关专业优先', '具备与岗位相匹配的项目经验', '具备良好的沟通与协作能力']
  const fallbackSkills = skills.length ? skills : ['业务理解', '方案设计', '沟通协作', '项目管理']
  return {
    language: 'zh-CN',
    content: [
      `岗位名称：${jobTitle}`,
      '',
      '岗位概述',
      summary,
      '',
      '主要职责',
      formatList(fallbackResponsibilities, true),
      '',
      '任职要求',
      formatList(fallbackRequirements),
      '',
      '技能要求',
      fallbackSkills.join('、'),
    ].join('\n'),
    generatedBy: 'local_fallback',
  }
}

export function createJobDescriptionGenerator(config: JobDescriptionGeneratorConfig, fetchImpl: FetchLike = fetch) {
  return {
    async generate(input: JobDescriptionGenerationInput): Promise<GeneratedJobDescription> {
      const jobTitle = input.jobTitle?.trim()
      if (!jobTitle) throw new JobDescriptionGenerationError('INVALID_INPUT', 'Job title is required.')

      let response: Response
      try {
        response = await fetchImpl(`${config.baseUrl.replace(/\/$/u, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.3,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: '你是企业招聘专家。请根据岗位名称和已有岗位说明书生成一份简洁、专业、可直接发布的简体中文 JD。返回 JSON 对象，仅包含 content 字段。content 使用纯文本，结构依次包含岗位名称、岗位概述、主要职责、任职要求、技能要求。不要编造公司名、薪资或地点，不要输出 Markdown 标记。',
              },
              { role: 'user', content: JSON.stringify({ jobTitle, spec: input.spec ?? null }) },
            ],
          }),
          signal: AbortSignal.timeout(config.timeoutMs),
        })
      } catch (error) {
        throw new JobDescriptionGenerationError('MODEL_REQUEST_FAILED', 'Job description model request failed.', error)
      }
      if (!response.ok) {
        throw new JobDescriptionGenerationError('MODEL_HTTP_ERROR', `Job description model returned HTTP ${response.status}.`)
      }
      let envelope: unknown
      try {
        envelope = await response.json()
      } catch (error) {
        throw new JobDescriptionGenerationError('MODEL_RESPONSE_INVALID', 'Model response envelope is not valid JSON.', error)
      }
      const content = isRecord(envelope)
        && Array.isArray(envelope.choices)
        && isRecord(envelope.choices[0])
        && isRecord(envelope.choices[0].message)
        ? envelope.choices[0].message.content
        : undefined
      return { language: 'zh-CN', content: parseModelContent(content), generatedBy: 'ai_assisted' }
    },
  }
}
