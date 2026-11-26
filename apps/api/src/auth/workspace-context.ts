import { isPlatformManagementPath } from '../platform/access.js'
import { isSystemAdministrationPath } from './system-administrator.js'
import type { Middleware } from '../http.js'
import { HttpError } from '../http.js'
import { organizationSchemaName, runWithTenantContext } from '../db/tenant-context.js'

export interface WorkspaceSchemaRegistry {
  query<T extends Record<string, unknown> = any>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
}

export async function requireReadyWorkspaceSchema(schemas: WorkspaceSchemaRegistry, workspaceId: string): Promise<string> {
  const result = await schemas.query<{ schema_name: string; status: string; structure_ready: boolean }>(
    'SELECT schema_name,status,public.organization_schema_structure_ready(organization_id) AS structure_ready FROM public.organization_schemas WHERE organization_id=$1::uuid',
    [workspaceId],
  )
  const schema = result.rows[0]
  if (!schema || schema.status !== 'ready' || schema.structure_ready !== true || schema.schema_name !== organizationSchemaName(workspaceId)) {
    throw new HttpError(503, 'WORKSPACE_SCHEMA_UNAVAILABLE', '企业数据尚未初始化，请联系平台运营人员')
  }
  return schema.schema_name
}

// These APIs derive their enterprise from the authenticated session, not from client input.
export function isWorkspaceScopedPath(path: string): boolean {
  if (isPlatformManagementPath(path) || isSystemAdministrationPath(path)) return false
  return [
    'departments', 'recruitment-requests', 'jobs', 'candidates', 'candidate-tags',
    'resumes', 'resume-import-batches', 'analysis-tasks', 'analysis-results', 'applications', 'interviews',
    'interviewer-options', 'interview-live-sessions', 'interview-live-segments',
    'offers', 'offer-templates', 'onboarding', 'dashboard', 'reports', 'workflow-events', 'admin', 'ai-skills',
    'trial-usage',
  ].some((name) => path === `/api/v1/${name}` || path.startsWith(`/api/v1/${name}/`))
}

export function createWorkspaceContextMiddleware(
  requireWorkspace = process.env.NODE_ENV !== 'test',
  schemas?: WorkspaceSchemaRegistry,
  routeSchemas = process.env.TENANT_SCHEMA_ROUTING === 'on',
): Middleware {
  return async (context, next) => {
    if (context.auth && context.url.pathname.startsWith('/api/v1/')) {
      context.res.setHeader('cache-control', 'private, no-store')
      context.res.setHeader('vary', 'Cookie, Authorization, X-Workspace-Id')
    }
    if (!context.auth || !isWorkspaceScopedPath(context.url.pathname)) return next()
    const workspaceId = context.auth.user.workspaceId
    if (requireWorkspace && !workspaceId) {
      if (context.auth.user.workspaceAccessIssue) throw new HttpError(403, 'WORKSPACE_SERVICE_UNAVAILABLE', '当前企业已暂停、试用到期或归档，请联系企业管理员或平台运营人员')
      throw new HttpError(409, 'WORKSPACE_REQUIRED', '请先创建或加入企业，再访问招聘数据')
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
    if (!routeSchemas || !workspaceId) return next()
    if (!schemas) throw new HttpError(503, 'WORKSPACE_SCHEMA_UNAVAILABLE', '企业数据暂不可用，请联系平台运营人员')
    const schemaName = await requireReadyWorkspaceSchema(schemas, workspaceId)
    await runWithTenantContext({ organizationId: workspaceId, schemaName }, next)
  }
}
