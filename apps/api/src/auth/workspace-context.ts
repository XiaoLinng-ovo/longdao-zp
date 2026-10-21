import { isPlatformManagementPath } from '../platform/access.js'
import type { Middleware } from '../http.js'
import { HttpError } from '../http.js'

// These APIs derive their enterprise from the authenticated session, not from client input.
export function isWorkspaceScopedPath(path: string): boolean {
  if (isPlatformManagementPath(path)) return false
  return [
    'departments', 'recruitment-requests', 'jobs', 'candidates', 'candidate-tags',
    'resumes', 'analysis-tasks', 'analysis-results', 'applications', 'interviews',
    'interviewer-options', 'interview-live-sessions', 'interview-live-segments',
    'offers', 'onboarding', 'dashboard', 'reports', 'workflow-events', 'admin', 'ai-skills',
  ].some((name) => path === `/api/v1/${name}` || path.startsWith(`/api/v1/${name}/`))
}

export function createWorkspaceContextMiddleware(requireWorkspace = process.env.NODE_ENV !== 'test'): Middleware {
  return async (context, next) => {
    if (context.auth && context.url.pathname.startsWith('/api/v1/')) {
      context.res.setHeader('cache-control', 'private, no-store')
      context.res.setHeader('vary', 'Cookie, Authorization, X-Workspace-Id')
    }
    if (!context.auth || !isWorkspaceScopedPath(context.url.pathname)) return next()
    const workspaceId = context.auth.user.workspaceId
    if (requireWorkspace && !workspaceId) {
      if (context.auth.user.workspaceAccessIssue) throw new HttpError(403, 'WORKSPACE_SERVICE_UNAVAILABLE', '当前企业已暂停、试用到期或归档，请切换可用企业或联系平台运营人员')
      throw new HttpError(409, 'WORKSPACE_REQUIRED', '请先选择一个企业，再访问招聘数据')
    }
    const expected = context.req.headers['x-workspace-id']
    const cookieSession = context.auth.method === 'session' && !context.req.headers.authorization
    // The header is an assertion only. It must never choose the repository's tenant.
    if (requireWorkspace && cookieSession && expected === undefined) {
      throw new HttpError(409, 'WORKSPACE_CONTEXT_REQUIRED', '页面企业信息已过期，请刷新页面后重试')
    }
    if (expected !== undefined && (Array.isArray(expected) || expected !== workspaceId)) {
      throw new HttpError(409, 'WORKSPACE_CONTEXT_CHANGED', '当前企业已在其他页面切换，请刷新页面后再操作')
    }
    await next()
  }
}
