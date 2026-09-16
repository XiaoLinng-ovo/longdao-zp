import type { Middleware } from './http.js';
import { HttpError } from './http.js';
import { sendSuccess } from './response.js';
import { RecruitingService } from './recruiting/service.js';
import { RecruitingWorkflowError } from './recruiting/workflow.js';
import { authService } from './auth/middleware.js';
import type { Role } from './auth/types.js';
import { buildAuthCookie, buildCsrfCookie, generateCsrfToken, isAllowedOrigin, validateCsrf, readCookie, parseAllowedOrigins, shouldProtectCsrf } from './auth/security.js';

const recruiting = new RecruitingService();
const AUTH_COOKIE = 'smartrecruit_session';
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 12;
const DEFAULT_AUTH_ROLES: Role[] = ['recruiter', 'hiring_manager', 'approver', 'admin', 'hr_admin', 'interviewer'];
const RECRUITMENT_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const RECRUITMENT_APPROVAL_ROLES: Role[] = ['approver', 'hiring_manager', 'admin', 'hr_admin'];
const JOB_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const CANDIDATE_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const APPLICATION_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const INTERVIEW_WRITE_ROLES: Role[] = ['recruiter', 'hiring_manager', 'admin', 'hr_admin', 'interviewer'];
const OFFER_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];
const ONBOARDING_WRITE_ROLES: Role[] = ['recruiter', 'admin', 'hr_admin'];

async function readJson(context: Parameters<Middleware>[0]): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of context.req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
    chunks.push(Buffer.from(chunk));
  }
  if (!Buffer.concat(chunks).length) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', '请求体必须是有效 JSON 对象');
  }
}

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

function paginateIfRequested<T>(context: Parameters<Middleware>[0], items: T[]): T[] | { items: T[]; total: number; page: number; pageSize: number } {
  const rawPage = context.url.searchParams.get('page');
  const rawPageSize = context.url.searchParams.get('pageSize');
  if (rawPage === null && rawPageSize === null) return items;

  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawPageSize === null ? 20 : Number(rawPageSize);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'page 必须是大于 0 的整数，pageSize 必须是 1 到 100 的整数');
  }

  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
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

  const protectedPaths = [
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
    '/api/v1/workflow-events'
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

    if (path === '/api/v1/recruitment-requests' && method === 'GET') {
      const requests = await recruiting.listRequests(context.url.searchParams.get('status') ?? undefined, context.url.searchParams.get('departmentId') ?? undefined);
      sendSuccess(context, paginateIfRequested(context, filterByDepartment(requests, departmentScope(auth)))); return;
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
      if (method === 'POST') { const requestAction = actionFrom(`/${suffix}`, '') ?? suffix.replaceAll('-', '_'); const request = await recruiting.getRequest(id); assertDepartmentScope(auth, request.departmentId); requireRole(auth, ['approve', 'reject'].includes(requestAction) ? RECRUITMENT_APPROVAL_ROLES : RECRUITMENT_WRITE_ROLES); sendSuccess(context, await recruiting.requestAction(id, requestAction, (await readJson(context)).reason, auth.user.id)); return; }
    }
    if (path === '/api/v1/jobs' && method === 'GET') {
      const jobs = await recruiting.listJobs(context.url.searchParams.get('status') ?? undefined, context.url.searchParams.get('recruitmentRequestId') ?? undefined, context.url.searchParams.get('departmentId') ?? undefined);
      sendSuccess(context, paginateIfRequested(context, filterByDepartment(jobs, departmentScope(auth)))); return;
    }
    if (path === '/api/v1/jobs' && method === 'POST') {
      requireRole(auth, JOB_WRITE_ROLES);
      sendSuccess(context, await recruiting.createJob(await readJson(context) as never, auth.user.id), 201); return;
    }
    if (path === '/api/v1/candidates' && method === 'GET') { sendSuccess(context, paginateIfRequested(context, await recruiting.listCandidates())); return; }
    if (path === '/api/v1/candidates' && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.createCandidate(await readJson(context) as never, auth.user.id), 201); return; }
    if (path === '/api/v1/candidate-tags' && method === 'GET') { sendSuccess(context, await recruiting.listCandidateTags()); return; }
    const candidateDetailMatch = path.match(/^\/api\/v1\/candidates\/([^/]+)$/);
    if (candidateDetailMatch && method === 'GET') { const result = await recruiting.getCandidate(candidateDetailMatch[1]!); sendSuccess(context, result); return; }
    if (candidateDetailMatch && method === 'PATCH') { requireRole(auth, CANDIDATE_WRITE_ROLES); const current = await recruiting.getCandidate(candidateDetailMatch[1]!); assertVersion(parseIfMatch(context), current.updatedAt ? 1 : 1); const result = await recruiting.updateCandidate(candidateDetailMatch[1]!, await readJson(context) as never, auth.user.id); sendSuccess(context, result); return; }
    if (path === '/api/v1/resumes' && method === 'GET') { sendSuccess(context, await recruiting.listResumes(context.url.searchParams.get('candidateId') ?? undefined, context.url.searchParams.get('applicationId') ?? undefined)); return; }
    if (path === '/api/v1/resumes' && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.createResume(await readJson(context) as never, auth.user.id), 201); return; }
    if (path === '/api/v1/analysis-tasks' && method === 'GET') { sendSuccess(context, await recruiting.listAnalysisTasks(context.url.searchParams.get('status') ?? undefined)); return; }
    const analysisTaskMatch = path.match(/^\/api\/v1\/analysis-tasks\/([^/]+)$/);
    if (analysisTaskMatch && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.processAnalysisTask(analysisTaskMatch[1]!)); return; }
    if (analysisTaskMatch && method === 'GET') { sendSuccess(context, await recruiting.getAnalysisTask(analysisTaskMatch[1]!)); return; }
    const analysisTaskResultMatch = path.match(/^\/api\/v1\/analysis-tasks\/([^/]+)\/result$/);
    if (analysisTaskResultMatch && method === 'GET') { sendSuccess(context, await recruiting.getAnalysisResult(analysisTaskResultMatch[1]!)); return; }
    if (path === '/api/v1/analysis-results' && method === 'GET') { sendSuccess(context, await recruiting.listAnalysisResults(context.url.searchParams.get('resumeId') ?? undefined, context.url.searchParams.get('applicationId') ?? undefined)); return; }
    const analysisResultByIdMatch = path.match(/^\/api\/v1\/analysis-results\/([^/]+)$/);
    if (analysisResultByIdMatch && method === 'GET') { sendSuccess(context, await recruiting.getAnalysisResultById(analysisResultByIdMatch[1]!)); return; }
    if (analysisResultByIdMatch && method === 'PATCH') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.reviewAnalysisResult(analysisResultByIdMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
    const analysisResultActionMatch = path.match(/^\/api\/v1\/analysis-results\/([^/]+)\/review$/);
    if (analysisResultActionMatch && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.reviewAnalysisResult(analysisResultActionMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
    if (path === '/api/v1/applications' && method === 'GET') { sendSuccess(context, paginateIfRequested(context, await recruiting.listApplications(context.url.searchParams.get('candidateId') ?? undefined, context.url.searchParams.get('jobId') ?? undefined))); return; }
    if (path === '/api/v1/dashboard/summary' && method === 'GET') { sendSuccess(context, await recruiting.getDashboardSummary()); return; }
    if (path === '/api/v1/reports' && method === 'GET') { sendSuccess(context, await recruiting.getReports()); return; }
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
    if (path === '/api/v1/onboarding' && method === 'GET') { sendSuccess(context, await recruiting.listOnboarding()); return; }
    const onboardingMatch = path.match(/^\/api\/v1\/onboarding\/([^/]+)(?:\/(.*))?$/);
    if (onboardingMatch) {
      const onboardingId = onboardingMatch[1]!; const suffix = onboardingMatch[2] ?? '';
      if (!suffix && method === 'GET') { sendSuccess(context, await recruiting.getOnboarding(onboardingId)); return; }
      if (!suffix && method === 'PATCH') { requireRole(auth, ONBOARDING_WRITE_ROLES); sendSuccess(context, await recruiting.updateOnboarding(onboardingId, await readJson(context) as never, auth.user.id)); return; }
      if (method === 'POST') { requireRole(auth, ONBOARDING_WRITE_ROLES); const body = await readJson(context); sendSuccess(context, await recruiting.onboardingAction(onboardingId, suffix.replaceAll('-', '_'), body.reason, auth.user.id)); return; }
    }    if (path === '/api/v1/offers' && method === 'GET') { sendSuccess(context, paginateIfRequested(context, await recruiting.listOffers(context.url.searchParams.get('status') ?? undefined))); return; }
    if (path === '/api/v1/offers' && method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); sendSuccess(context, await recruiting.createOffer(await readJson(context) as never, auth.user.id), 201); return; }
    const offerMatch = path.match(/^\/api\/v1\/offers\/([^/]+)(?:\/(.*))?$/);
    if (offerMatch) { const id=offerMatch[1]!; const suffix=offerMatch[2] ?? ''; if (!suffix && method === 'GET') { const result = await recruiting.getOffer(id); setVersionEtag(context, result.version); sendSuccess(context, result); return; } if (!suffix && method === 'PATCH') { requireRole(auth, OFFER_WRITE_ROLES); const current = await recruiting.getOffer(id); assertVersion(parseIfMatch(context), current.version); const result = await recruiting.updateOffer(id, await readJson(context) as never, auth.user.id); setVersionEtag(context, result.version); sendSuccess(context, result); return; } if (method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); const body=await readJson(context); sendSuccess(context, await recruiting.offerAction(id, suffix.replaceAll('-', '_'), body.reason, auth.user.id)); return; } }
    if (path === '/api/v1/interviews' && method === 'GET') { sendSuccess(context, await recruiting.listInterviews(context.url.searchParams.get('applicationId') ?? undefined)); return; }
    if (path === '/api/v1/interviews' && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); sendSuccess(context, await recruiting.createInterview(await readJson(context) as never, auth.user.id), 201); return; }
    const interviewMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)(?:\/(feedback|lock-feedback|conclude))?$/);
    if (interviewMatch && method === 'GET' && !interviewMatch[2]) { sendSuccess(context, await recruiting.getInterview(interviewMatch[1]!)); return; }
    if (interviewMatch && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); const body = await readJson(context); if (interviewMatch[2] === 'feedback') sendSuccess(context, await recruiting.submitFeedback(interviewMatch[1]!, body as never, auth.user.id)); else if (interviewMatch[2] === 'lock-feedback') sendSuccess(context, await recruiting.lockFeedback(interviewMatch[1]!, String(body.interviewerId ?? ''), auth.user.id)); else if (interviewMatch[2] === 'conclude') sendSuccess(context, await recruiting.concludeInterview(interviewMatch[1]!, String(body.outcome) as never, auth.user.id)); return; }
    const applicationMatch = path.match(/^\/api\/v1\/applications\/([^/]+)\/status$/);
    if (applicationMatch && method === 'POST') { requireRole(auth, APPLICATION_WRITE_ROLES); const body = await readJson(context); sendSuccess(context, await recruiting.updateApplicationStatus(applicationMatch[1]!, String(body.status) as never, body.reason, auth.user.id)); return; }
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


