import type { Middleware } from './http.js';
import { HttpError } from './http.js';
import { sendSuccess, type ApiMeta } from './response.js';
import { readBody, readJson } from './body.js';
import { RecruitingService } from './recruiting/service.js';
import { RecruitingWorkflowError } from './recruiting/workflow.js';
import { AdminService, AdminNotFoundError, AdminValidationError } from './admin/service.js';
import { createDatabasePool } from './db/connection.js';
import { authService } from './auth/middleware.js';
import type { Role } from './auth/types.js';
import { timingSafeEqual } from 'node:crypto';
import { DingTalkJobSyncError, DingTalkJobSyncService } from './integrations/dingtalk/job-sync.js';
import { PostgresDingTalkJobSyncRepository } from './integrations/dingtalk/postgres-job-sync.js';
import { MemoryDingTalkJobSyncRepository } from './integrations/dingtalk/memory-job-sync.js';
import { createConfiguredDingTalkApprovalClient } from './integrations/dingtalk/approval-client.js';
import { DingTalkApprovalWorkflow, DingTalkApprovalWorkflowError } from './integrations/dingtalk/approval-workflow.js';
import { PostgresDingTalkApprovalRepository } from './integrations/dingtalk/postgres-approval-workflow.js';
import { executeRecruitmentApprovalAction } from './integrations/dingtalk/approval-routing.js';
import { executeOfferApprovalAction } from './integrations/dingtalk/offer-approval.js';
import { createInterviewQuestionGenerator, InterviewQuestionGenerationError, loadInterviewQuestionGeneratorConfig } from './interviews/question-generator.js';
import { createInterviewAnswerAnalyzer, InterviewAnswerAnalysisError, loadInterviewAnswerAnalyzerConfig } from './interviews/answer-analyzer.js';
import { createFunAsrClient, FunAsrError, loadFunAsrConfig } from './interviews/funasr-client.js';
import { mapInterviewRoles, type ConfirmedSpeakerRoles } from './interviews/role-mapper.js';
import { LiveInterviewSessionRepository } from './interviews/live-session-repository.js';
import { buildAuthCookie, buildCsrfCookie, generateCsrfToken, isAllowedOrigin, validateCsrf, readCookie, parseAllowedOrigins, shouldProtectCsrf } from './auth/security.js';

const recruiting = new RecruitingService();
const liveInterviewSessions = new LiveInterviewSessionRepository(createDatabasePool());
const adminService = new AdminService(createDatabasePool());
const dingTalkJobSync = new DingTalkJobSyncService(
  process.env.NODE_ENV === 'test' ? new MemoryDingTalkJobSyncRepository() : new PostgresDingTalkJobSyncRepository(createDatabasePool()),
  { platformBaseUrl: process.env.PLATFORM_BASE_URL || 'http://127.0.0.1:5174' },
);
const dingTalkApprovalRepository = new PostgresDingTalkApprovalRepository(createDatabasePool());
const dingTalkApprovalClient = createConfiguredDingTalkApprovalClient();
const dingTalkApproval = dingTalkApprovalClient
  && process.env.DINGTALK_CALLBACK_TOKEN?.trim()
  && process.env.DINGTALK_CALLBACK_AES_KEY?.trim()
  && process.env.DINGTALK_CALLBACK_CORP_ID?.trim()
  ? new DingTalkApprovalWorkflow(dingTalkApprovalRepository, dingTalkApprovalClient, {
      callbackToken: process.env.DINGTALK_CALLBACK_TOKEN.trim(),
      callbackAesKey: process.env.DINGTALK_CALLBACK_AES_KEY.trim(),
      callbackCorpId: process.env.DINGTALK_CALLBACK_CORP_ID.trim(),
    })
  : undefined;
const usePostgres = process.env.NODE_ENV !== 'test';
const AUTH_COOKIE = 'smartrecruit_session';
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 12;
const DEFAULT_AUTH_ROLES: Role[] = ['recruiter', 'hiring_manager', 'approver', 'admin', 'hr_admin', 'interviewer'];
const ADMIN_ROLES: Role[] = ['admin', 'hr_admin'];
const RECRUITMENT_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const RECRUITMENT_APPROVAL_ROLES: Role[] = ['approver', 'hiring_manager', 'admin', 'hr_admin'];
const JOB_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const CANDIDATE_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const APPLICATION_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const INTERVIEW_WRITE_ROLES: Role[] = ['recruiter', 'hiring_manager', 'admin', 'hr_admin', 'interviewer'];
const OFFER_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const ONBOARDING_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];

function errorFromRecruiting(error: unknown): never {
  if (error instanceof RecruitingWorkflowError) throw new HttpError(error.status, error.code, error.message);
  if ((error as { code?: string }).code) {
    const cause = error as Error & { code: string; status?: number };
    throw new HttpError(cause.status ?? 500, cause.code, cause.message);
  }
  throw error;
}

function requireRole(auth: NonNullable<Parameters<Middleware>[0]['auth']>, roles: Role[]): void {
  try {
    authService.requirePermission(auth, roles);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FORBIDDEN') throw new HttpError(403, code, (error as Error).message);
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', (error as Error).message);
  }
}

function departmentScope(auth: NonNullable<Parameters<Middleware>[0]['auth']>): string | undefined {
  if (auth.user.role !== 'hiring_manager') return undefined;
  return auth.user.departmentId;
}

function filterByDepartment<T extends { departmentId: string }>(items: T[], scope: string | undefined): T[] {
  return scope ? items.filter((item) => item.departmentId === scope) : items;
}

function assertDepartmentScope(auth: NonNullable<Parameters<Middleware>[0]['auth']>, departmentId: string): void {
  const scope = departmentScope(auth);
  if (scope && departmentId !== scope) throw new HttpError(403, 'FORBIDDEN', '当前账号无权访问其他部门数据');
}

function actionFrom(path: string, prefix: string): string | undefined {
  const suffix = path.slice(prefix.length).replace(/^\//, '');
  return suffix && !suffix.includes('/') ? suffix.replaceAll('-', '_') : undefined;
}

function requireAuth(context: Parameters<Middleware>[0], roles: Role[] = DEFAULT_AUTH_ROLES): NonNullable<Parameters<Middleware>[0]['auth']> {
  try {
    authService.requirePermission(context.auth, roles);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FORBIDDEN') throw new HttpError(403, code, (error as Error).message);
    throw new HttpError(401, 'AUTHENTICATION_REQUIRED', (error as Error).message);
  }
  return context.auth!;
}

function parseIfMatch(context: Parameters<Middleware>[0]): number | undefined {
  const raw = context.req.headers['if-match']
  if (Array.isArray(raw) || raw === undefined) return undefined
  const value = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
  if (!/^\d+$/.test(value)) throw new HttpError(400, 'INVALID_IF_MATCH', 'If-Match 必须是版本号')
  return Number(value)
}

function assertVersion(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) throw new HttpError(409, 'VERSION_CONFLICT', '资源版本已变化，请刷新后重试', { expected, actual })
}

function setVersionEtag(context: Parameters<Middleware>[0], version: number): void {
  context.res.setHeader('etag', `"${version}"`)
}

function requireDingTalkToken(context: Parameters<Middleware>[0]): void {
  const configured = process.env.DINGTALK_INTEGRATION_TOKEN?.trim()
  const authorization = Array.isArray(context.req.headers.authorization) ? '' : context.req.headers.authorization?.trim()
  const match = authorization?.match(/^Bearer\s+(.+)$/i)
  const provided = match?.[1]?.trim()
  if (!configured || !provided) throw new HttpError(401, 'DINGTALK_AUTH_REQUIRED', '钉钉集成未授权')
  const actual = Buffer.from(provided); const expected = Buffer.from(configured)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'DINGTALK_AUTH_REQUIRED', '钉钉集成未授权')
}

/* ------------------------------------------------------------------ *
 * 统一列表分页结构
 * - 不传 page / pageSize：保持旧的数组响应（向后兼容）；
 * - 传参：data = { items, total, page, pageSize }，并在 meta.pagination 给出
 *   { page, pageSize, total, totalPages }（与 packages/contracts 的 PaginationMeta 同形）。
 * ------------------------------------------------------------------ */
function sendList<T>(context: Parameters<Middleware>[0], items: T[]): void {
  const rawPage = context.url.searchParams.get('page');
  const rawPageSize = context.url.searchParams.get('pageSize');
  if (rawPage === null && rawPageSize === null) {
    sendSuccess(context, items);
    return;
  }

  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawPageSize === null ? 20 : Number(rawPageSize);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'page 必须是大于 0 的整数，pageSize 必须是 1 到 100 的整数');
  }

  const start = (page - 1) * pageSize;
  const total = items.length;
  const meta: ApiMeta = { pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  sendSuccess(context, { items: items.slice(start, start + pageSize), total, page, pageSize }, 200, meta);
}

const routeMiddleware: Middleware = async (context, next) => {
  const { method } = context.req;
  const path = context.url.pathname;

  if (path === '/api/v1/health') {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET 请求');
    sendSuccess(context, {
      status: 'ok',
      service: context.config.appName,
      version: context.config.appVersion,
      uptimeSeconds: Math.floor(process.uptime())
    });
    return;
  }

  if (path === '/api/v1/ready') {
    sendSuccess(context, {
      status: 'ready',
      checks: {
        configuration: 'ok',
        auth: context.auth ? 'ok' : 'anonymous',
      }
    });
    return;
  }

  if (path === '/api/v1/auth/login' && method === 'POST') {
    const body = await readJson(context);
    const result = await authService.login({ email: String(body.email ?? ''), password: String(body.password ?? '') });
    const production = process.env.NODE_ENV === 'production';
    const csrfToken = generateCsrfToken();
    context.res.setHeader('set-cookie', [buildAuthCookie(result.token, { production, maxAge: SESSION_COOKIE_MAX_AGE }), buildCsrfCookie(csrfToken, { production, maxAge: SESSION_COOKIE_MAX_AGE })]);
    sendSuccess(context, {
      user: result.session.user,
      sessionId: result.session.sessionId,
      expiresAt: result.session.expiresAt,
    });
    return;
  }

  if (path === '/api/v1/auth/logout' && method === 'POST') {
    await authService.logout(context.auth?.sessionId ?? '');
    const production = process.env.NODE_ENV === 'production';
    context.res.setHeader('set-cookie', [buildAuthCookie('', { production, maxAge: 0 }), buildCsrfCookie('', { production, maxAge: 0 })]);
    sendSuccess(context, { ok: true });
    return;
  }

  if (path === '/api/v1/auth/csrf' && method === 'GET') {
    const production = process.env.NODE_ENV === 'production';
    const token = generateCsrfToken();
    context.res.setHeader('set-cookie', buildCsrfCookie(token, { production }));
    sendSuccess(context, { token });
    return;
  }

  if (path === '/api/v1/me') {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET 请求');
    if (!context.auth) throw new HttpError(401, 'AUTHENTICATION_REQUIRED', '未登录，请先完成身份认证');
    sendSuccess(context, {
      user: context.auth.user,
      sessionId: context.auth.sessionId,
      method: context.auth.method,
    });
    return;
  }

  if (path === '/api/v1/integrations/dingtalk/jobs' && method !== 'POST') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST 请求');
  }

  if (path === '/api/v1/integrations/dingtalk/jobs' && method === 'POST') {
    const contentType = Array.isArray(context.req.headers['content-type']) ? '' : context.req.headers['content-type'] ?? '';
    if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType.trim())) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '钉钉岗位同步仅支持 application/json');
    }
    requireDingTalkToken(context)
    try {
      const result = await dingTalkJobSync.publish(await readJson(context) as never)
      sendSuccess(context, result, result.status === 'draft' ? 201 : 200)
    } catch (error) {
      if (error instanceof DingTalkJobSyncError) throw new HttpError(error.status, error.code, error.message)
      throw error
    }
    return
  }

  if (path === '/api/v1/integrations/dingtalk/approvals/callback' && method === 'POST') {
    if (!dingTalkApproval) throw new HttpError(503, 'DINGTALK_APPROVAL_NOT_CONFIGURED', '钉钉审批回调尚未配置')
    const signature = context.url.searchParams.get('msg_signature') ?? context.url.searchParams.get('signature') ?? ''
    const timestamp = context.url.searchParams.get('timestamp') ?? ''
    const nonce = context.url.searchParams.get('nonce') ?? ''
    try {
      const result = await dingTalkApproval.handleCallback({ body: (await readBody(context)).raw, timestamp, nonce, signature })
      context.res.statusCode = 200
      context.res.setHeader('content-type', 'application/json; charset=utf-8')
      context.res.end(JSON.stringify(result.response))
    } catch (error) {
      if (error instanceof DingTalkApprovalWorkflowError) throw new HttpError(error.status, error.code, error.message)
      throw error
    }
    return
  }

  const protectedPaths = [
    '/api/v1/departments',
    '/api/v1/recruitment-requests',
    '/api/v1/jobs',
    '/api/v1/candidates',
    '/api/v1/candidate-tags',
    '/api/v1/resumes',
    '/api/v1/analysis-tasks',
    '/api/v1/analysis-results',
    '/api/v1/applications',
    '/api/v1/interviews',
    '/api/v1/offers',
    '/api/v1/onboarding',
    '/api/v1/dashboard/summary',

    '/api/v1/reports',
    '/api/v1/workflow-events',

    '/api/v1/admin'
  ];
  const isProtectedPath = protectedPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (!isProtectedPath) {
    await next();
    return;
  }

  try {
    if (shouldProtectCsrf(method, process.env.REQUIRE_CSRF)) {
      const origin = Array.isArray(context.req.headers.origin) ? undefined : context.req.headers.origin;
      const allowed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
      if (!isAllowedOrigin(origin, allowed)) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任');
      const headerToken = Array.isArray(context.req.headers['x-csrf-token']) ? undefined : context.req.headers['x-csrf-token'];
      const cookieHeader = Array.isArray(context.req.headers.cookie) ? undefined : context.req.headers.cookie;
      const cookieToken = readCookie(cookieHeader, 'smartrecruit_csrf', { production: process.env.NODE_ENV === 'production' });
      if (!validateCsrf(headerToken, cookieToken)) throw new HttpError(403, 'CSRF_TOKEN_INVALID', 'CSRF Token 无效');
    }
    const auth = requireAuth(context);

    if (path === '/api/v1/departments' && method === 'GET') { sendSuccess(context, await adminService.listDepartments(true)); return; }

    if (path === '/api/v1/recruitment-requests' && method === 'GET') {
      const requests = await recruiting.listRequests(context.url.searchParams.get('status') ?? undefined, context.url.searchParams.get('departmentId') ?? undefined);
      sendList(context, filterByDepartment(requests, departmentScope(auth))); return;
    }
    if (path === '/api/v1/recruitment-requests' && method === 'POST') {
      requireRole(auth, RECRUITMENT_WRITE_ROLES);
      sendSuccess(context, await recruiting.createRequest(await readJson(context) as never, auth.user.id), 201); return;
    }
    const requestMatch = path.match(/^\/api\/v1\/recruitment-requests\/([^/]+)(?:\/(.*))?$/);
    if (requestMatch) {
      const id = requestMatch[1]!; const suffix = requestMatch[2] ?? '';
      if (!suffix && method === 'GET') { const request = await recruiting.getRequest(id); assertDepartmentScope(auth, request.departmentId); setVersionEtag(context, request.version); sendSuccess(context, request); return; }
      if (suffix === 'approval' && method === 'GET') { const request = await recruiting.getRequest(id); assertDepartmentScope(auth, request.departmentId); sendSuccess(context, await recruiting.getRequestApproval(id)); return; }
      if (!suffix && method === 'PATCH') { requireRole(auth, RECRUITMENT_WRITE_ROLES); const request = await recruiting.getRequest(id); assertDepartmentScope(auth, request.departmentId); assertVersion(parseIfMatch(context), request.version); const result = await recruiting.updateRequest(id, await readJson(context) as never, auth.user.id); setVersionEtag(context, result.version); sendSuccess(context, result); return; }
      if (method === 'POST') {
        const requestAction = actionFrom(`/${suffix}`, '') ?? suffix.replaceAll('-', '_');
        const request = await recruiting.getRequest(id);
        assertDepartmentScope(auth, request.departmentId);
        requireRole(auth, ['approve', 'reject'].includes(requestAction) ? RECRUITMENT_APPROVAL_ROLES : RECRUITMENT_WRITE_ROLES);
        const reason = (await readJson(context)).reason;
        if (!dingTalkApproval) { sendSuccess(context, await recruiting.requestAction(id, requestAction, reason, auth.user.id)); return; }
        try {
          const result = await executeRecruitmentApprovalAction({
            requestId: request.id, action: requestAction, actorId: auth.user.id,
            request: { title: request.title, departmentId: request.departmentId, headcount: request.headcount },
            performLocalAction: () => recruiting.requestAction(id, requestAction, reason, auth.user.id),
            getCurrentInstanceId: async () => {
              const approval = await recruiting.getRequestApproval(id)
              if (!approval.current) throw new DingTalkApprovalWorkflowError('APPROVAL_INSTANCE_REQUIRED', '当前需求无可用审批实例', 409)
              return approval.current.id
            },
            resolveOriginatorUserId: (internalUserId) => dingTalkApprovalRepository.resolveExternalUserId(internalUserId),
            startExternalApproval: (approvalInput) => dingTalkApproval.start(approvalInput),
            assertLocalDecisionAllowed: (subjectType, subjectId) => dingTalkApproval.assertLocalDecisionAllowed(subjectType, subjectId),
          })
          sendSuccess(context, result)
        } catch (error) {
          if (error instanceof DingTalkApprovalWorkflowError) throw new HttpError(error.status, error.code, error.message)
          throw error
        }
        return;
      }
    }
    if (path === '/api/v1/jobs' && method === 'GET') {
      const jobs = await recruiting.listJobs(context.url.searchParams.get('status') ?? undefined, context.url.searchParams.get('recruitmentRequestId') ?? undefined, context.url.searchParams.get('departmentId') ?? undefined);
      sendList(context, filterByDepartment(jobs, departmentScope(auth))); return;
    }
    if (path === '/api/v1/jobs' && method === 'POST') {
      requireRole(auth, JOB_WRITE_ROLES);
      sendSuccess(context, await recruiting.createJob(await readJson(context) as never, auth.user.id), 201); return;
    }
    if (path === '/api/v1/candidates' && method === 'GET') { sendList(context, await recruiting.listCandidates(departmentScope(auth))); return; }
    if (path === '/api/v1/candidates' && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.createCandidate(await readJson(context) as never, auth.user.id), 201); return; }
    if (path === '/api/v1/candidate-tags' && method === 'GET') { sendList(context, await recruiting.listCandidateTags()); return; }
    const candidateDetailMatch = path.match(/^\/api\/v1\/candidates\/([^/]+)$/);
    if (candidateDetailMatch && method === 'GET') { await recruiting.assertCandidateInScope(candidateDetailMatch[1]!, departmentScope(auth)); const result = await recruiting.getCandidate(candidateDetailMatch[1]!); sendSuccess(context, result); return; }
    if (candidateDetailMatch && method === 'PATCH') { requireRole(auth, CANDIDATE_WRITE_ROLES); await recruiting.assertCandidateInScope(candidateDetailMatch[1]!, departmentScope(auth)); const current = await recruiting.getCandidate(candidateDetailMatch[1]!); assertVersion(parseIfMatch(context), current.updatedAt ? 1 : 1); const result = await recruiting.updateCandidate(candidateDetailMatch[1]!, await readJson(context) as never, auth.user.id); sendSuccess(context, result); return; }
    if (path === '/api/v1/resumes' && method === 'GET') { sendList(context, await recruiting.listResumes(context.url.searchParams.get('candidateId') ?? undefined, context.url.searchParams.get('applicationId') ?? undefined, departmentScope(auth))); return; }
    if (path === '/api/v1/resumes' && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.createResume(await readJson(context) as never, auth.user.id), 201); return; }
    if (path === '/api/v1/analysis-tasks' && method === 'GET') { sendList(context, await recruiting.listAnalysisTasks(context.url.searchParams.get('status') ?? undefined)); return; }
    const analysisTaskMatch = path.match(/^\/api\/v1\/analysis-tasks\/([^/]+)$/);
    if (analysisTaskMatch && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.processAnalysisTask(analysisTaskMatch[1]!)); return; }
    if (analysisTaskMatch && method === 'GET') { sendSuccess(context, await recruiting.getAnalysisTask(analysisTaskMatch[1]!)); return; }
    const analysisTaskResultMatch = path.match(/^\/api\/v1\/analysis-tasks\/([^/]+)\/result$/);
    if (analysisTaskResultMatch && method === 'GET') { sendSuccess(context, await recruiting.getAnalysisResult(analysisTaskResultMatch[1]!)); return; }
    if (path === '/api/v1/analysis-results' && method === 'GET') { sendList(context, await recruiting.listAnalysisResults(context.url.searchParams.get('resumeId') ?? undefined, context.url.searchParams.get('applicationId') ?? undefined)); return; }
    const analysisResultByIdMatch = path.match(/^\/api\/v1\/analysis-results\/([^/]+)$/);
    if (analysisResultByIdMatch && method === 'GET') { sendSuccess(context, await recruiting.getAnalysisResultById(analysisResultByIdMatch[1]!)); return; }
    if (analysisResultByIdMatch && method === 'PATCH') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.reviewAnalysisResult(analysisResultByIdMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
    const analysisResultActionMatch = path.match(/^\/api\/v1\/analysis-results\/([^/]+)\/review$/);
    if (analysisResultActionMatch && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.reviewAnalysisResult(analysisResultActionMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
    if (path === '/api/v1/applications' && method === 'GET') { sendList(context, await recruiting.listApplications(context.url.searchParams.get('candidateId') ?? undefined, context.url.searchParams.get('jobId') ?? undefined, departmentScope(auth))); return; }
    if (path === '/api/v1/dashboard/summary' && method === 'GET') { sendSuccess(context, await recruiting.getDashboardSummary(departmentScope(auth))); return; }
    if (path === '/api/v1/reports' && method === 'GET') { sendSuccess(context, await recruiting.getReports(departmentScope(auth))); return; }
    if (path === '/api/v1/reports/funnel' && method === 'GET') { sendSuccess(context, (await recruiting.getReports(departmentScope(auth))).funnel); return; }
    if (path === '/api/v1/reports/channels' && method === 'GET') { sendSuccess(context, (await recruiting.getReports(departmentScope(auth))).channels); return; }
    if (path === '/api/v1/reports/cycle-time' && method === 'GET') { sendSuccess(context, (await recruiting.getReports(departmentScope(auth))).recruitmentCycle); return; }

    if (path === '/api/v1/admin/users' && method === 'GET') { requireRole(auth, ADMIN_ROLES); sendList(context, await adminService.listUsers()); return; }
    if (path === '/api/v1/admin/departments' && method === 'GET') { requireRole(auth, ADMIN_ROLES); sendSuccess(context, await adminService.listDepartments()); return; }
    if (path === '/api/v1/admin/departments' && method === 'POST') { requireRole(auth, ADMIN_ROLES); sendSuccess(context, await adminService.createDepartment(await readJson(context) as never, auth.user.id, context.requestId), 201); return; }
    const adminDepartmentMatch = path.match(/^\/api\/v1\/admin\/departments\/([^/]+)$/);
    if (adminDepartmentMatch && method === 'PATCH') { requireRole(auth, ADMIN_ROLES); sendSuccess(context, await adminService.updateDepartment(adminDepartmentMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    const adminUserMatch = path.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);
    if (adminUserMatch && method === 'PATCH') { requireRole(auth, ADMIN_ROLES); sendSuccess(context, await adminService.updateUser(adminUserMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/roles' && method === 'GET') { requireRole(auth, ADMIN_ROLES); sendSuccess(context, await adminService.listRoles()); return; }
    const adminRoleMatch = path.match(/^\/api\/v1\/admin\/roles\/([^/]+)$/);
    if (adminRoleMatch && method === 'PATCH') { requireRole(auth, ADMIN_ROLES); sendSuccess(context, await adminService.updateRole(adminRoleMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/settings' && method === 'GET') { requireRole(auth, ADMIN_ROLES); sendSuccess(context, await adminService.getSettings()); return; }
    if (path === '/api/v1/admin/settings' && method === 'PATCH') { requireRole(auth, ADMIN_ROLES); sendSuccess(context, await adminService.updateSettings(await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/analysis-tasks' && method === 'GET') { requireRole(auth, ADMIN_ROLES); sendList(context, await recruiting.listAnalysisTasks(context.url.searchParams.get('status') ?? undefined)); return; }
    if (path === '/api/v1/admin/audit-logs' && method === 'GET') { requireRole(auth, ADMIN_ROLES); sendList(context, await adminService.listAuditLogs(Number(context.url.searchParams.get('limit') ?? '50'))); return; }
    if (path === '/api/v1/workflow-events' && method === 'GET') {
      const subjectTypeParam = context.url.searchParams.get('subjectType');
      const subjectType = subjectTypeParam === 'recruitment_request' || subjectTypeParam === 'job' || subjectTypeParam === 'offer' || subjectTypeParam === 'onboarding' || subjectTypeParam === 'candidate' || subjectTypeParam === 'application' || subjectTypeParam === 'interview' ? subjectTypeParam : undefined;
      const rawLimit = context.url.searchParams.get('limit');
      const limit = rawLimit ? Number(rawLimit) : undefined;
      if (rawLimit && (!Number.isInteger(limit) || (limit ?? 0) < 1)) throw new HttpError(400, 'VALIDATION_ERROR', 'limit 必须是大于 0 的整数');
      const filters: Parameters<RecruitingService['listWorkflowEvents']>[0] = {};
      if (subjectType) filters.subjectType = subjectType;
      if (limit) filters.limit = limit;
      sendSuccess(context, await recruiting.listWorkflowEvents(filters));
      return;
    }
    if (path === '/api/v1/applications' && method === 'POST') { requireRole(auth, APPLICATION_WRITE_ROLES); sendSuccess(context, await recruiting.createApplication(await readJson(context) as never, auth.user.id), 201); return; }
    if (path === '/api/v1/onboarding' && method === 'GET') { sendList(context, await recruiting.listOnboarding(departmentScope(auth))); return; }
    const onboardingMatch = path.match(/^\/api\/v1\/onboarding\/([^/]+)(?:\/(.*))?$/);
    if (onboardingMatch) {
      const onboardingId = onboardingMatch[1]!; const suffix = onboardingMatch[2] ?? '';
      if (!suffix && method === 'GET') { await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.getOnboarding(onboardingId)); return; }
      if (!suffix && method === 'PATCH') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.updateOnboarding(onboardingId, await readJson(context) as never, auth.user.id)); return; }
      if (method === 'POST') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); const body = await readJson(context); sendSuccess(context, await recruiting.onboardingAction(onboardingId, suffix.replaceAll('-', '_'), body.reason, auth.user.id)); return; }
    }    if (path === '/api/v1/offers' && method === 'GET') { sendList(context, await recruiting.listOffers(context.url.searchParams.get('status') ?? undefined, departmentScope(auth))); return; }
    if (path === '/api/v1/offers' && method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); sendSuccess(context, await recruiting.createOffer(await readJson(context) as never, auth.user.id), 201); return; }
    const offerMatch = path.match(/^\/api\/v1\/offers\/([^/]+)(?:\/(.*))?$/);
    if (offerMatch) { const id=offerMatch[1]!; const suffix=offerMatch[2] ?? ''; await recruiting.assertOfferInScope(id, departmentScope(auth)); if (!suffix && method === 'GET') { const result = await recruiting.getOffer(id); setVersionEtag(context, result.version); sendSuccess(context, result); return; } if (!suffix && method === 'PATCH') { requireRole(auth, OFFER_WRITE_ROLES); const current = await recruiting.getOffer(id); assertVersion(parseIfMatch(context), current.version); const result = await recruiting.updateOffer(id, await readJson(context) as never, auth.user.id); setVersionEtag(context, result.version); sendSuccess(context, result); return; } if (method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); const body=await readJson(context); const action=suffix.replaceAll('-', '_'); if (!dingTalkApproval || !usePostgres || !['submit_approval','approve','reject'].includes(action)) { sendSuccess(context, await recruiting.offerAction(id, action, body.reason, auth.user.id)); return; } const offer=await recruiting.getOffer(id); const version=offer.versions.find((item)=>item.id===offer.currentVersionId) ?? offer.versions.sort((a,b)=>b.version-a.version)[0]; if (!version) throw new HttpError(409,'OFFER_VERSION_REQUIRED','Offer 缺少当前版本'); try { const result=await executeOfferApprovalAction({ offerId:offer.id, action, actorId:auth.user.id, offer:{positionTitle:version.positionTitle,departmentId:version.departmentId,baseSalary:version.compensation.baseSalary}, performLocalAction:()=>recruiting.offerAction(id,action,body.reason,auth.user.id), getCurrentInstanceId:async()=>{ const found=await createDatabasePool().query(`WITH created AS (INSERT INTO approval_instances (id, subject_type, subject_id, version, status, current_step, created_by, updated_at) SELECT gen_random_uuid(), 'offer', $1::uuid, COALESCE(MAX(version), 0) + 1, 'pending', 1, $2::uuid, now() FROM approval_instances WHERE subject_type = 'offer' AND subject_id = $1::uuid RETURNING id) INSERT INTO approval_steps (id, approval_instance_id, step_no, approver_role_code, status) SELECT gen_random_uuid(), id, 1, 'approver', 'pending' FROM created RETURNING approval_instance_id AS id`,[offer.id,auth.user.id]); if (!found.rows[0]) throw new DingTalkApprovalWorkflowError('APPROVAL_INSTANCE_REQUIRED','当前 Offer 无可用审批实例',409); return String(found.rows[0].id) }, resolveOriginatorUserId:(userId)=>dingTalkApprovalRepository.resolveExternalUserId(userId), startExternalApproval:(input)=>dingTalkApproval.start(input), assertLocalDecisionAllowed:(subjectType,subjectId)=>dingTalkApproval.assertLocalDecisionAllowed(subjectType,subjectId) }); sendSuccess(context,result) } catch(error) { if(error instanceof DingTalkApprovalWorkflowError) throw new HttpError(error.status,error.code,error.message); throw error } return; } }
    if (path === '/api/v1/interviews' && method === 'GET') { sendList(context, await recruiting.listInterviews(context.url.searchParams.get('applicationId') ?? undefined, departmentScope(auth))); return; }
    if (path === '/api/v1/interviews' && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertApplicationInScope(String((await readJson(context)).applicationId ?? ''), departmentScope(auth)); sendSuccess(context, await recruiting.createInterview(await readJson(context) as never, auth.user.id), 201); return; }
    const liveSessionCreateMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/live-sessions$/);
    if (liveSessionCreateMatch && method === 'GET') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(liveSessionCreateMatch[1]!, departmentScope(auth)); sendSuccess(context, await liveInterviewSessions.findActive(liveSessionCreateMatch[1]!) ?? null); return; }
    if (liveSessionCreateMatch && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(liveSessionCreateMatch[1]!, departmentScope(auth)); sendSuccess(context, await liveInterviewSessions.create(liveSessionCreateMatch[1]!, auth.user.id), 201); return; }
    const liveSessionMatch = path.match(/^\/api\/v1\/interview-live-sessions\/([^/]+)(?:\/(segments|end))?$/);
    if (liveSessionMatch && method === 'GET' && !liveSessionMatch[2]) { requireRole(auth, INTERVIEW_WRITE_ROLES); const result=await liveInterviewSessions.get(liveSessionMatch[1]!); await recruiting.assertInterviewInScope(result.session.interviewId, departmentScope(auth)); sendSuccess(context,result); return; }
    if (liveSessionMatch && method === 'POST' && liveSessionMatch[2] === 'end') { requireRole(auth, INTERVIEW_WRITE_ROLES); const current=await liveInterviewSessions.get(liveSessionMatch[1]!); await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth)); sendSuccess(context,await liveInterviewSessions.end(liveSessionMatch[1]!)); return; }
    if (liveSessionMatch && method === 'POST' && liveSessionMatch[2] === 'segments') {
      requireRole(auth, INTERVIEW_WRITE_ROLES); const current=await liveInterviewSessions.get(liveSessionMatch[1]!); await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth)); const body=await readJson(context); const encoded=String(body.audioBase64 ?? ''); if(!encoded) throw new HttpError(400,'INVALID_INPUT','audioBase64 不能为空');
      try { const asr=createFunAsrClient(loadFunAsrConfig()); const chunkOffsetMs=Number(body.chunkOffsetMs ?? 0); if(!Number.isFinite(chunkOffsetMs)||chunkOffsetMs<0) throw new HttpError(400,'INVALID_INPUT','chunkOffsetMs 必须是非负数'); const transcribed=(await asr.transcribe(Buffer.from(encoded,'base64'),String(body.contentType ?? 'audio/webm'))).map((item)=>({...item,startMs:item.startMs+chunkOffsetMs,endMs:item.endMs+chunkOffsetMs})); const known:ConfirmedSpeakerRoles={}; current.segments.forEach((item)=>{if(item.role!=='unknown'&&item.confidence>=0.6) known[item.speakerId]=item.role}); const mapped=mapInterviewRoles(transcribed,known); const saved=[]; for(const item of mapped) saved.push(await liveInterviewSessions.addSegment(liveSessionMatch[1]!,{speakerId:item.speakerId,role:item.role,confidence:item.confidence,text:item.text,startMs:item.startMs,endMs:item.endMs})); sendSuccess(context,saved,201) } catch(error) { if(error instanceof FunAsrError) throw new HttpError(error.code==='NOT_CONFIGURED'?503:502,`FUNASR_${error.code}`,error.message); throw error } return;
    }
    const liveSegmentMatch = path.match(/^\/api\/v1\/interview-live-segments\/([^/]+)\/(role|analyze)$/);
    if (liveSegmentMatch && method === 'POST') { requireRole(auth,INTERVIEW_WRITE_ROLES); const body=await readJson(context); const analysisContext=await liveInterviewSessions.getAnalysisContext(liveSegmentMatch[1]!); await recruiting.assertInterviewInScope(analysisContext.interviewId,departmentScope(auth)); if(liveSegmentMatch[2]==='role'){ const role=String(body.role); if(role!=='interviewer'&&role!=='candidate') throw new HttpError(400,'INVALID_INPUT','role 必须是 interviewer 或 candidate'); const ids=Array.isArray(body.segmentIds)?body.segmentIds.map(String):[liveSegmentMatch[1]!]; sendSuccess(context,await liveInterviewSessions.correctUtteranceRole(liveSegmentMatch[1]!,ids,role)); return } if(analysisContext.segment.role!=='candidate'||analysisContext.segment.confidence<0.6) throw new HttpError(409,'CANDIDATE_ROLE_UNCONFIRMED','只有已确认的候选人回答才能进入 AI 分析'); try { const candidateAnswer=await liveInterviewSessions.getUtteranceText(liveSegmentMatch[1]!,Array.isArray(body.segmentIds)?body.segmentIds.map(String):[liveSegmentMatch[1]!]); const config=loadInterviewAnswerAnalyzerConfig(); const analyzer=createInterviewAnswerAnalyzer(config); const analysis=await analyzer.analyze({question:String(body.question ?? ''),candidateAnswer,jobTitle:analysisContext.jobTitle,jobRequirements:analysisContext.jobRequirements.length?analysisContext.jobRequirements:['岗位要求未结构化'],priorContext:Array.isArray(body.priorContext)?body.priorContext.map(String):[]}); await liveInterviewSessions.saveAnalysis(liveSegmentMatch[1]!,String(body.question ?? ''),analysis,config.model); sendSuccess(context,analysis) } catch(error) { if(error instanceof InterviewAnswerAnalysisError) throw new HttpError(error.code==='AI_NOT_CONFIGURED'?503:error.code==='INVALID_INPUT'?400:502,error.code,error.message); throw error } return; }
    const interviewMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)(?:\/(feedback|lock-feedback|conclude|questions))?$/);
    if (interviewMatch && method === 'GET' && !interviewMatch[2]) { await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); sendSuccess(context, await recruiting.getInterview(interviewMatch[1]!)); return; }
    if (interviewMatch && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); const body = await readJson(context); if (interviewMatch[2] === 'feedback') sendSuccess(context, await recruiting.submitFeedback(interviewMatch[1]!, body as never, auth.user.id)); else if (interviewMatch[2] === 'lock-feedback') sendSuccess(context, await recruiting.lockFeedback(interviewMatch[1]!, String(body.interviewerId ?? ''), auth.user.id)); else if (interviewMatch[2] === 'conclude') sendSuccess(context, await recruiting.concludeInterview(interviewMatch[1]!, String(body.outcome) as never, auth.user.id)); else if (interviewMatch[2] === 'questions') { try { const generator=createInterviewQuestionGenerator(loadInterviewQuestionGeneratorConfig()); sendSuccess(context,await generator.generate(body as never)) } catch(error) { if(error instanceof InterviewQuestionGenerationError) throw new HttpError(error.code==='AI_NOT_CONFIGURED'?503:error.code==='INVALID_INPUT'?400:502,error.code,error.message); throw error } } return; }
    const applicationMatch = path.match(/^\/api\/v1\/applications\/([^/]+)\/status$/);
    if (applicationMatch && method === 'POST') { requireRole(auth, APPLICATION_WRITE_ROLES); await recruiting.assertApplicationInScope(applicationMatch[1]!, departmentScope(auth)); const body = await readJson(context); sendSuccess(context, await recruiting.updateApplicationStatus(applicationMatch[1]!, String(body.status) as never, body.reason, auth.user.id)); return; }
    const jobMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)(?:\/(.*))?$/);
    if (jobMatch) {
      const id = jobMatch[1]!; const suffix = jobMatch[2] ?? '';
      const job = await recruiting.getJob(id); assertDepartmentScope(auth, job.departmentId);
      if (!suffix && method === 'GET') { setVersionEtag(context, job.version); sendSuccess(context, job); return; }
      if (!suffix && method === 'PATCH') { requireRole(auth, JOB_WRITE_ROLES); assertVersion(parseIfMatch(context), job.version); const result = await recruiting.updateJob(id, await readJson(context) as never, auth.user.id); setVersionEtag(context, result.version); sendSuccess(context, result); return; }
      if (suffix === 'spec' && method === 'POST') { requireRole(auth, JOB_WRITE_ROLES); sendSuccess(context, await recruiting.createSpec(id, await readJson(context) as never, auth.user.id)); return; }
      if (suffix === 'jd' && method === 'POST') { requireRole(auth, JOB_WRITE_ROLES); sendSuccess(context, await recruiting.createJd(id, await readJson(context) as never, auth.user.id)); return; }
      if (suffix === 'spec-versions' && method === 'GET') { sendSuccess(context, await recruiting.listJobSpecVersions(id)); return; }
      if (suffix === 'jd-versions' && method === 'GET') { sendSuccess(context, await recruiting.listJobDescriptionVersions(id)); return; }
      if (method === 'POST') { requireRole(auth, JOB_WRITE_ROLES); sendSuccess(context, await recruiting.jobAction(id, suffix.replaceAll('-', '_'), (await readJson(context)).reason, auth.user.id)); return; }
    }
  } catch (error) {
    errorFromRecruiting(error);
  }

  await next();
};

export const notFoundMiddleware: Middleware = async (context) => {
  throw new HttpError(404, 'NOT_FOUND', `未找到接口：${context.req.method} ${context.url.pathname}`);
};

export default routeMiddleware;
