import { HttpError, type Middleware } from '../http.js'

export interface ResumeUploadLimits {
  concurrency: number
  workspaceConcurrency: number
  queueLimit: number
  workspaceQueueLimit: number
}

export function loadResumeUploadLimits(env: NodeJS.ProcessEnv = process.env): ResumeUploadLimits {
  const integer = (key: string, fallback: number, maximum: number) => {
    const value = env[key]?.trim()
    if (!value) return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${key} must be an integer between 1 and ${maximum}`)
    return parsed
  }
  return {
    concurrency: integer('RESUME_UPLOAD_CONCURRENCY', 6, 100),
    workspaceConcurrency: integer('RESUME_UPLOAD_WORKSPACE_CONCURRENCY', 3, 100),
    queueLimit: integer('RESUME_ANALYSIS_QUEUE_LIMIT', 2000, 100000),
    workspaceQueueLimit: integer('RESUME_ANALYSIS_WORKSPACE_QUEUE_LIMIT', 500, 100000),
  }
}

export function createResumeUploadAdmission(options: {
  limits?: ResumeUploadLimits
  queueDepth?: (workspaceId: string) => Promise<{ total: number; workspace: number }>
} = {}): Middleware {
  const limits = options.limits ?? loadResumeUploadLimits()
  const activeByWorkspace = new Map<string, number>()
  let active = 0
  return async (context, next) => {
    const path = context.url.pathname
    const upload = context.req.method === 'POST' && (
      /^\/api\/v1\/resume-import-batches\/[^/]+\/items\/[^/]+\/content$/.test(path)
      || path === '/api/v1/resumes'
      || /^\/api\/v1\/candidates\/[^/]+\/resumes$/.test(path)
    )
    const workspace = context.auth?.user.workspaceId
    if (!upload || !context.auth) { await next(); return }
    const key = workspace ?? context.auth.user.id
    const workspaceActive = activeByWorkspace.get(key) ?? 0
    const busy = (code: string, message: string, retryAfterSeconds = 2): never => {
      context.res.setHeader('retry-after', String(retryAfterSeconds))
      throw new HttpError(429, code, message, { retryable: true, retryAfterSeconds })
    }
    // Reserve before awaiting or reading the base64 body; reads and other routes stay independent.
    if (active >= limits.concurrency || workspaceActive >= limits.workspaceConcurrency) {
      busy('RESUME_UPLOAD_BUSY', '上传通道繁忙，正在等待可用通道')
    }
    active++
    activeByWorkspace.set(key, workspaceActive + 1)
    try {
      if (workspace && options.queueDepth) {
        const depth = await options.queueDepth(workspace)
        if (depth.total >= limits.queueLimit || depth.workspace >= limits.workspaceQueueLimit) {
          busy('RESUME_ANALYSIS_QUEUE_FULL', '简历解析队列已满，请稍后重试', 10)
        }
      }
      await next()
    } finally {
      active--
      const remaining = (activeByWorkspace.get(key) ?? 1) - 1
      if (remaining) activeByWorkspace.set(key, remaining)
      else activeByWorkspace.delete(key)
    }
  }
}
