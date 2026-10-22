import { BillingSandboxService } from './platform/billing-sandbox.js';
import { assertPlatformWriteSecurity } from './platform/access.js';
import { AiUsageService, usageKey } from './platform/ai-usage.js';
import { parseUsageFilters } from './platform/ai-usage-diagnostics.js';
import { EntitlementService } from './platform/entitlements.js';
import { PlatformService } from './platform/service.js';
import { EnterpriseAiStore, EnterpriseAiError, validateEnterpriseAiPatch, assertAiEndpointAllowed } from '@smartrecruit-pro/enterprise-ai';
import { testAiConnection } from './admin/ai-settings.js';
import type { Middleware } from './http.js';
import { HttpError } from './http.js';
import { sendSuccess, type ApiMeta } from './response.js';
import { readBody, readJson } from './body.js';
import { RecruitingService } from './recruiting/service.js';
import { RecruitingWorkflowError } from './recruiting/workflow.js';
import { RepositoryNotFoundError } from './recruiting/repositories/postgres-repository.js';
import { AdminService, AdminNotFoundError, AdminValidationError, type AiPromptSkillTarget } from './admin/service.js';
import { RecruitmentApprovalSettingsError, RecruitmentApprovalSettingsService } from './admin/recruitment-approval-settings.js';
import { AiSettingsValidationError } from './admin/ai-settings.js';
import { ChannelSettingsValidationError } from './integrations/channels/settings.js';
import type { ChannelProvider } from './integrations/channels/types.js';
import { createDatabasePool } from './db/connection.js';
import { authService } from './auth/middleware.js';
import { isWorkspaceScopedPath } from './auth/workspace-context.js';
import { WorkspaceInvitationsService, InvitationError } from './auth/workspace-invitations.js';
import { readSavedAccountSessions, buildSavedAccountsCookie } from './auth/saved-accounts.js';
import type { Role } from './auth/types.js';
import { timingSafeEqual } from 'node:crypto';
import { DingTalkJobSyncError, DingTalkJobSyncService } from './integrations/dingtalk/job-sync.js';
import { PostgresDingTalkJobSyncRepository } from './integrations/dingtalk/postgres-job-sync.js';
import { MemoryDingTalkJobSyncRepository } from './integrations/dingtalk/memory-job-sync.js';
import { createConfiguredDingTalkApprovalClient } from './integrations/dingtalk/approval-client.js';
import { DingTalkApprovalWorkflow, DingTalkApprovalWorkflowError } from './integrations/dingtalk/approval-workflow.js';
import { PostgresDingTalkApprovalRepository } from './integrations/dingtalk/postgres-approval-workflow.js';
import { mockDingTalkApprovalClient } from './integrations/dingtalk/mock-approval-client.js';
import { executePlatformRecruitmentApprovalAction, executeRecruitmentApprovalAction } from './integrations/dingtalk/approval-routing.js';
import { executeOfferApprovalAction } from './integrations/dingtalk/offer-approval.js';
import { createInterviewQuestionGenerator, generateLocalInterviewQuestions, InterviewQuestionGenerationError, loadInterviewQuestionGeneratorConfig } from './interviews/question-generator.js';
import { createInterviewAnswerAnalyzer, InterviewAnswerAnalysisError, loadInterviewAnswerAnalyzerConfig } from './interviews/answer-analyzer.js';

import { analyzeActualAnswer } from './interviews/actual-answer-analysis.js';
import { createJobSpecGenerator, generateLocalJobSpec, JobSpecGenerationError, loadJobSpecGeneratorConfig } from './recruiting/job-spec-generator.js';
import { createJobDescriptionGenerator, generateLocalJobDescription, JobDescriptionGenerationError, loadJobDescriptionGeneratorConfig } from './recruiting/job-description-generator.js';
import { FunAsrError, loadFunAsrConfig, probeFunAsrService } from './interviews/funasr-client.js';
import { FasterWhisperError, loadFasterWhisperConfig, probeFasterWhisperService } from './interviews/faster-whisper-client.js';
import { transcribeInterviewChunk } from './interviews/interview-transcriber.js';
import { mapInterviewRoles, scopeSpeakersToChunk, stableRoleSpeakerId, type ConfirmedSpeakerRoles, type SpeakerSegment } from './interviews/role-mapper.js';
import { SessionVoiceprintTracker } from './interviews/voiceprint-tracker.js';
import { mapAudioSourceRoles, parseAudioSource } from './interviews/audio-source.js';
import { reconcileTranscript, type TranscriptCheckpoint } from './interviews/transcript-checkpoint.js';
import { LiveInterviewSessionRepository } from './interviews/live-session-repository.js';
import { MemoryInterviewQuestionSetRepository, PostgresInterviewQuestionSetRepository } from './interviews/interview-question-set-repository.js';
import type { GeneratedInterviewQuestion } from './interviews/question-generator.js';
import { createConfiguredQuestionSheetService } from './interviews/question-sheet-runtime.js';
import { createConfiguredInterviewSummaryService } from './interviews/interview-summary-service.js';
import { createLiveInterviewAudioStorage } from './interviews/live-audio-storage.js';
import { InterviewAudioRecordingRepository } from './interviews/audio-recording-repository.js';
import { sendInterviewAudio } from './interviews/audio-response.js';
import { FullInterviewAudio, FullAudioError, type FullAudioSource } from './interviews/full-audio.js';
import { FullAudioTranscription } from './interviews/full-audio-transcription.js';
import { parseLiveSessionPath } from './interviews/live-route.js';
import { createObjectStorageFromEnv } from '@smartrecruit-pro/object-storage';
import { resolve } from 'node:path';
import { buildAuthCookie, buildCsrfCookie, generateCsrfToken, isAllowedOrigin, isAllowedResumeUploadOrigin, validateCsrf, readCookie, parseAllowedOrigins, shouldProtectCsrf } from './auth/security.js';

const recruitingService = new RecruitingService();
const liveInterviewSessions = new LiveInterviewSessionRepository(createDatabasePool());
const liveInterviewVoices = new SessionVoiceprintTracker();
const interviewQuestionSets = process.env.NODE_ENV === 'test'
  ? new MemoryInterviewQuestionSetRepository()
  : new PostgresInterviewQuestionSetRepository(createDatabasePool());
const platformService = new PlatformService(createDatabasePool());
const billingSandboxService = new BillingSandboxService(createDatabasePool());
const aiUsageService = new AiUsageService(createDatabasePool());
const entitlementService = new EntitlementService(createDatabasePool());
const enterpriseAi = new EnterpriseAiStore(createDatabasePool());
const questionSheets = createConfiguredQuestionSheetService();
const interviewSummaries = createConfiguredInterviewSummaryService();
const liveInterviewAudioStorage = createLiveInterviewAudioStorage(createObjectStorageFromEnv(process.env, resolve(process.cwd(), '../../data/interviews')));
const fullInterviewAudio = new FullInterviewAudio(liveInterviewAudioStorage);
const fullAudioTranscription = new FullAudioTranscription(liveInterviewAudioStorage);
const interviewAudioRecordings = new InterviewAudioRecordingRepository(createDatabasePool());
const adminService = new AdminService(createDatabasePool());
const workspaceInvitations = new WorkspaceInvitationsService(createDatabasePool());
const recruitmentApprovalSettings = new RecruitmentApprovalSettingsService(createDatabasePool());
const dingTalkJobSync = new DingTalkJobSyncService(
  process.env.NODE_ENV === 'test' ? new MemoryDingTalkJobSyncRepository() : new PostgresDingTalkJobSyncRepository(createDatabasePool()),
  { platformBaseUrl: process.env.PLATFORM_BASE_URL || 'http://127.0.0.1:5174' },
);
const dingTalkApprovalRepository = new PostgresDingTalkApprovalRepository(createDatabasePool());
const DINGTALK_MOCK_AES_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
function dingTalkApprovalMode(): 'mock' | 'real' | 'off' {
  const mode = (process.env.DINGTALK_APPROVAL_MODE ?? 'mock').trim().toLowerCase();
  return mode === 'real' || mode === 'off' ? mode : 'mock';
}
function isDingTalkMockMode(): boolean { return dingTalkApprovalMode() === 'mock'; }
function getDingTalkApproval(): DingTalkApprovalWorkflow | undefined {
  // 单元测试不应因为仓库根 .env 中的模拟开关而连 PostgreSQL。
  if (process.env.NODE_ENV === 'test') return undefined;
  if (isDingTalkMockMode()) {
    return new DingTalkApprovalWorkflow(dingTalkApprovalRepository, mockDingTalkApprovalClient, {
      callbackToken: 'mock-callback-token',
      callbackAesKey: DINGTALK_MOCK_AES_KEY,
      callbackCorpId: 'mock-corp-id',
    });
  }
  if (dingTalkApprovalMode() !== 'real') return undefined;
  const client = createConfiguredDingTalkApprovalClient();
  const callbackToken = process.env.DINGTALK_CALLBACK_TOKEN?.trim();
  const callbackAesKey = process.env.DINGTALK_CALLBACK_AES_KEY?.trim();
  const callbackCorpId = process.env.DINGTALK_CALLBACK_CORP_ID?.trim();
  return client && callbackToken && callbackAesKey && callbackCorpId
    ? new DingTalkApprovalWorkflow(dingTalkApprovalRepository, client, {
      callbackToken, callbackAesKey, callbackCorpId,
    })
  : undefined;
}
function getDingTalkCallbackWorkflow(): { workflow: DingTalkApprovalWorkflow; verificationOnly: boolean } | undefined {
  if (!isDingTalkMockMode()) {
    const workflow = getDingTalkApproval()
    return workflow ? { workflow, verificationOnly: false } : undefined
  }
  // Permit DingTalk's encrypted URL challenge in mock mode, but never apply real approval events.
  const callbackToken = process.env.DINGTALK_CALLBACK_TOKEN?.trim()
  const callbackAesKey = process.env.DINGTALK_CALLBACK_AES_KEY?.trim()
  const callbackCorpId = process.env.DINGTALK_CALLBACK_CORP_ID?.trim()
  if (!callbackToken || !callbackAesKey || !callbackCorpId) return undefined
  return {
    workflow: new DingTalkApprovalWorkflow(dingTalkApprovalRepository, mockDingTalkApprovalClient, { callbackToken, callbackAesKey, callbackCorpId }),
    verificationOnly: true,
  }
}
function resolveDingTalkOriginatorUserId(internalUserId: string): Promise<string> {
  return isDingTalkMockMode()
    ? Promise.resolve(`mock-user-${internalUserId}`)
    : dingTalkApprovalRepository.resolveExternalUserId(internalUserId);
}
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

function requirePlatformAdmin(auth: NonNullable<Parameters<Middleware>[0]['auth']>): void {
  if (auth.user.platformRole !== 'admin') throw new HttpError(403, 'PLATFORM_PERMISSION_REQUIRED', '此功能仅对平台管理员开放');
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
  if (!auth.user.departmentId?.trim()) throw new HttpError(403, 'DEPARTMENT_SCOPE_REQUIRED', '当前部门负责人未绑定部门，请联系企业管理员设置后重试');
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
    const funasrStatus = await (async () => {
      try {
        const config = loadFunAsrConfig()
        return await probeFunAsrService(config) ? 'ok' : 'unavailable'
      } catch {
        return 'unavailable'
      }
    })()
    const fasterWhisperStatus = await (async () => {
      if (!process.env.FASTER_WHISPER_BASE_URL?.trim()) return 'not_configured'
      try {
        const config = loadFasterWhisperConfig()
        return await probeFasterWhisperService(config) ? 'ok' : 'unavailable'
      } catch {
        return 'unavailable'
      }
    })()
    sendSuccess(context, {
      status: 'ready',
      checks: {
        configuration: 'ok',
        auth: context.auth ? 'ok' : 'anonymous',
        externalServices: {
          funasr: funasrStatus,
          fasterWhisper: fasterWhisperStatus,
          llm: 'requires_workspace_configuration',
          ocr: process.env.OCR_SERVICE_URL?.trim() ? 'ok' : 'unavailable',
        },
      }
    });
    return;
  }

  if (path === '/api/v1/auth/accounts' && method === 'GET') {
    requireAuth(context);
    const accounts = await readSavedAccountSessions(authService, context.req.headers.cookie, process.env.NODE_ENV === 'production');
    context.res.setHeader('cache-control', 'no-store');
    sendSuccess(context, accounts.map(({ auth }) => ({ user: auth.user, current: auth.sessionId === context.auth?.sessionId })));
    return;
  }

  if (path === '/api/v1/auth/accounts/switch' && method === 'POST') {
    const production = process.env.NODE_ENV === 'production';
    if (shouldProtectCsrf(method, process.env.REQUIRE_CSRF)) {
      const allowed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
      const origin = context.req.headers.origin;
      if (allowed.length && !isAllowedOrigin(origin, allowed, process.env.NODE_ENV === 'development')) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任');
      const headerToken = context.req.headers['x-csrf-token'];
      if (!validateCsrf(typeof headerToken === 'string' ? headerToken : undefined, readCookie(context.req.headers.cookie, 'smartrecruit_csrf', { production }))) {
        throw new HttpError(403, 'CSRF_TOKEN_INVALID', 'CSRF Token 无效');
      }
    }
    const body = await readJson(context);
    const accounts = await readSavedAccountSessions(authService, context.req.headers.cookie, production);
    const target = accounts.find(({ auth }) => auth.user.id === body.userId);
    if (!target) throw new HttpError(401, 'SAVED_ACCOUNT_EXPIRED', '该账号登录已失效，请重新添加账号');
    const workspaces = await authService.listWorkspaces(target.auth.user.id);
    context.res.setHeader('set-cookie', [
      buildAuthCookie(target.token, { production, maxAge: SESSION_COOKIE_MAX_AGE }),
      buildSavedAccountsCookie(accounts, { production, maxAge: SESSION_COOKIE_MAX_AGE }),
    ]);
    sendSuccess(context, { user: target.auth.user, sessionId: target.auth.sessionId, method: 'session', workspaces });
    return;
  }

  if (path === '/api/v1/auth/login' && method === 'POST') {
    const body = await readJson(context);
    const result = await authService.login({ email: String(body.email ?? ''), password: String(body.password ?? '') });
    const production = process.env.NODE_ENV === 'production';
    const csrfToken = generateCsrfToken();
    const accounts = await readSavedAccountSessions(authService, context.req.headers.cookie, production);
    accounts.push({ token: result.token, auth: { user: result.session.user, sessionId: result.session.sessionId, method: 'session' } });
    context.res.setHeader('set-cookie', [buildAuthCookie(result.token, { production, maxAge: SESSION_COOKIE_MAX_AGE }), buildCsrfCookie(csrfToken, { production, maxAge: SESSION_COOKIE_MAX_AGE }), buildSavedAccountsCookie(accounts, { production, maxAge: SESSION_COOKIE_MAX_AGE })]);
    sendSuccess(context, {
      user: result.session.user,
      sessionId: result.session.sessionId,
      expiresAt: result.session.expiresAt,
      workspaces: await authService.listWorkspaces(result.session.user.id),
    });
    return;
  }

  if (path === '/api/v1/auth/register' && method === 'POST') {
    const body = await readJson(context)
    const user = await authService.register({ name: String(body.name ?? ''), email: String(body.email ?? ''), password: String(body.password ?? '') })
    sendSuccess(context, { user }, 201)
    return
  }

  if (path === '/api/v1/auth/logout' && method === 'POST') {
    await authService.logout(context.auth?.sessionId ?? '');
    const production = process.env.NODE_ENV === 'production';
    const accounts = await readSavedAccountSessions(authService, context.req.headers.cookie, production);
    context.res.setHeader('set-cookie', [buildAuthCookie('', { production, maxAge: 0 }), buildCsrfCookie('', { production, maxAge: 0 }), buildSavedAccountsCookie(accounts.filter(({ auth }) => auth.sessionId !== context.auth?.sessionId), { production })]);
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

  const invitationManagement = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/(invitations|members)(?:\/([^/]+))?$/)
  const invitationJoin = path === '/api/v1/workspace-invitations/preview' || path === '/api/v1/workspace-invitations/accept'
  if (invitationManagement || invitationJoin) {
    const auth = requireAuth(context)
    if (!usePostgres) throw new HttpError(503, 'POSTGRES_REQUIRED', '企业邀请需要 PostgreSQL 数据库')
    if (shouldProtectCsrf(method, process.env.REQUIRE_CSRF)) {
      const origin = typeof context.req.headers.origin === 'string' ? context.req.headers.origin : undefined
      const allowed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
      if (allowed.length && !isAllowedOrigin(origin, allowed, process.env.NODE_ENV === 'development')) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任')
      const headerToken = typeof context.req.headers['x-csrf-token'] === 'string' ? context.req.headers['x-csrf-token'] : undefined
      const cookieHeader = typeof context.req.headers.cookie === 'string' ? context.req.headers.cookie : undefined
      if (!validateCsrf(headerToken, readCookie(cookieHeader, 'smartrecruit_csrf', { production: process.env.NODE_ENV === 'production' }))) throw new HttpError(403, 'CSRF_TOKEN_INVALID', 'CSRF Token 无效')
    }
    try {
      if (invitationJoin && method === 'POST') {
        const body = await readJson(context)
        sendSuccess(context, path.endsWith('/preview') ? await workspaceInvitations.preview(body.code, auth.user.id) : await workspaceInvitations.accept(body.code, auth.user.id))
        return
      }
      if (invitationManagement) {
        const workspaceId = invitationManagement[1]!, resource = invitationManagement[2]!, id = invitationManagement[3]
        if (resource === 'invitations') {
          if (!id && method === 'GET') { sendSuccess(context, await workspaceInvitations.list(workspaceId, auth.user.id)); return }
          if (!id && method === 'POST') { sendSuccess(context, await workspaceInvitations.create(workspaceId, auth.user.id, await readJson(context)), 201); return }
          if (id && method === 'DELETE') { sendSuccess(context, await workspaceInvitations.revoke(workspaceId, auth.user.id, id)); return }
        }
        if (resource === 'members') {
          if (!id && method === 'GET') { sendSuccess(context, await workspaceInvitations.members(workspaceId, auth.user.id)); return }
          if (id && method === 'PATCH') { sendSuccess(context, await workspaceInvitations.updateMember(workspaceId, auth.user.id, id, await readJson(context))); return }
        }
      }
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', '此邀请接口不支持该请求方法')
    } catch (error) {
      if (error instanceof InvitationError) throw new HttpError(error.status, error.code, error.message)
      throw error
    }
  }

  if (path === '/api/v1/workspaces') {
    const auth = requireAuth(context)
    if (method === 'GET') { sendSuccess(context, await authService.listWorkspaces(auth.user.id)); return }
    if (method === 'POST') {
      const body = await readJson(context)
      const kind = body.kind === 'production' ? 'production' : 'test'
      sendSuccess(context, await authService.createWorkspace(auth.user.id, { name: String(body.name ?? ''), kind }), 201)
      return
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET 或 POST 请求')
  }

  const workspaceEntitlements = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/entitlements$/)
  if (workspaceEntitlements && method === 'GET') {
    const auth = requireAuth(context)
    sendSuccess(context, await entitlementService.readEnterprise(auth.user.id, workspaceEntitlements[1]!)); return
  }

  const workspaceAction = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/(archive|reset|select)$/)
  if (workspaceAction) {
    const auth = requireAuth(context)
    const workspaceId = workspaceAction[1]!
    const action = workspaceAction[2]!
    if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST 请求')
    if (action === 'archive') { await authService.archiveWorkspace(auth.user.id, workspaceId); sendSuccess(context, { ok: true }); return }
    if (action === 'reset') { await authService.resetWorkspace(auth.user.id, workspaceId); sendSuccess(context, { ok: true }); return }
    const user = await authService.selectWorkspace(auth.sessionId, auth.user.id, workspaceId)
    sendSuccess(context, { user });
    return
  }

  if (path.startsWith('/api/v1/platform/')) {
    const auth = requireAuth(context)
    if (path === '/api/v1/platform/customers' && method === 'GET') { sendSuccess(context, await platformService.listCustomers(auth.user.id, context.url.searchParams)); return }
    if (path === '/api/v1/platform/audit-logs' && method === 'GET') { sendSuccess(context, await platformService.listAudit(auth.user.id)); return }
    if (path === '/api/v1/platform/plans' && method === 'GET') { sendSuccess(context, await entitlementService.listPlans(auth.user.id)); return }
    if (path === '/api/v1/platform/plans' && method === 'POST') { sendSuccess(context, await entitlementService.publish(auth.user.id, await readJson(context), context.requestId), 201); return }
    const entitlementAction = path.match(/^\/api\/v1\/platform\/customers\/([^/]+)\/entitlements$/)
    if (entitlementAction && method === 'GET') { sendSuccess(context, await entitlementService.readPlatform(auth.user.id, entitlementAction[1]!)); return }
    if (entitlementAction && method === 'PATCH') { sendSuccess(context, await entitlementService.assign(auth.user.id, entitlementAction[1]!, await readJson(context), context.requestId)); return }
    const customerAction = path.match(/^\/api\/v1\/platform\/customers\/([^/]+)\/lifecycle$/)
    if (customerAction && method === 'PATCH') {
      sendSuccess(context, await platformService.updateLifecycle(auth.user.id, customerAction[1]!, await readJson(context), context.requestId)); return
    }
    throw new HttpError(404, 'NOT_FOUND', '平台接口不存在')
  }

  if (path === '/api/v1/me') {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET 请求');
    if (!context.auth) throw new HttpError(401, 'AUTHENTICATION_REQUIRED', '未登录，请先完成身份认证');
    sendSuccess(context, {
      user: context.auth.user,
      sessionId: context.auth.sessionId,
      method: context.auth.method,
      workspaces: await authService.listWorkspaces(context.auth.user.id),
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
    const callbackWorkflow = getDingTalkCallbackWorkflow();
    if (!callbackWorkflow) throw new HttpError(503, 'DINGTALK_APPROVAL_NOT_CONFIGURED', '钉钉审批回调尚未配置')
    const signature = context.url.searchParams.get('msg_signature') ?? context.url.searchParams.get('signature') ?? ''
    const timestamp = context.url.searchParams.get('timestamp') ?? ''
    const nonce = context.url.searchParams.get('nonce') ?? ''
    try {
      const result = await callbackWorkflow.workflow.handleCallback({ body: (await readBody(context)).raw, timestamp, nonce, signature }, { verificationOnly: callbackWorkflow.verificationOnly })
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
    '/api/v1/interviewer-options',
    '/api/v1/interview-live-sessions',
    '/api/v1/interview-live-segments',
    '/api/v1/offers',
    '/api/v1/onboarding',
    '/api/v1/dashboard/summary',

    '/api/v1/reports',
    '/api/v1/workflow-events',

    '/api/v1/admin',
    '/api/v1/ai-skills'
  ];
  const isProtectedPath = protectedPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (!isProtectedPath) {
    await next();
    return;
  }

  try {
    if (shouldProtectCsrf(method, process.env.REQUIRE_CSRF)) {
      const allowed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
      if (allowed.length > 0) {
        const origin = Array.isArray(context.req.headers.origin) ? undefined : context.req.headers.origin;
        if (!isAllowedResumeUploadOrigin(origin, allowed, path, method, process.env.RESUME_UPLOAD_RELAX_ORIGIN, process.env.NODE_ENV === 'development')) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任');
      }
      const headerToken = Array.isArray(context.req.headers['x-csrf-token']) ? undefined : context.req.headers['x-csrf-token'];
      const cookieHeader = Array.isArray(context.req.headers.cookie) ? undefined : context.req.headers.cookie;
      const cookieToken = readCookie(cookieHeader, 'smartrecruit_csrf', { production: process.env.NODE_ENV === 'production' });
      if (!validateCsrf(headerToken, cookieToken)) throw new HttpError(403, 'CSRF_TOKEN_INVALID', 'CSRF Token 无效');
    }
    const auth = requireAuth(context);
    // 所有受保护的招聘域读写均绑定当前会话选择的企业，避免跨企业串读或误写。
    // PostgreSQL 模式下没有企业上下文必须失败关闭，不能退回无租户仓储，否则会泄露历史/其他企业数据。
    if (usePostgres && isWorkspaceScopedPath(path) && !auth.user.workspaceId) {
      throw new HttpError(409, 'WORKSPACE_REQUIRED', '请先选择一个企业，再访问招聘数据');
    }
    const recruiting = recruitingService.forOrganization(auth.user.workspaceId);
    const tenantSkills = () => adminService.forOrganization(auth.user.workspaceId);
    const requireAiAdmin = () => enterpriseAi.assertAdmin(auth.user.workspaceId, auth.user.id);
    const tenantAiEnv = () => enterpriseAi.runtimeEnv(auth.user.workspaceId);
    if (path === '/api/v1/admin/billing-sandbox' && method === 'GET') {
      await requireAiAdmin(); sendSuccess(context, await billingSandboxService.read(auth.user.id, auth.user.workspaceId!, Number(context.url.searchParams.get('page') ?? 1))); return;
    }
    if (path === '/api/v1/admin/billing-sandbox/orders' && method === 'POST') {
      await requireAiAdmin(); assertPlatformWriteSecurity(context);
      const body = await readJson(context);
      const key = context.req.headers['idempotency-key'];
      sendSuccess(context, await billingSandboxService.create(auth.user.id, auth.user.workspaceId!, body, typeof key === 'string' ? key : '')); return;
    }
    const simulationAction = path.match(/^\/api\/v1\/admin\/billing-sandbox\/orders\/([^/]+)\/simulate$/);
    if (simulationAction && method === 'POST') {
      await requireAiAdmin(); assertPlatformWriteSecurity(context);
      const body = await readJson(context) as { kind: import('./platform/mock-payment.js').SimulationEventKind; reason?: string };
      if (!body || typeof body !== 'object') throw new HttpError(400, 'INVALID_ACTION', '模拟操作无效');
      sendSuccess(context, await billingSandboxService.simulate(auth.user.id, auth.user.workspaceId!, simulationAction[1]!, body.kind, body.reason)); return;
    }

    if (path === '/api/v1/admin/ai-usage' && method === 'GET') {
      await requireAiAdmin(); sendSuccess(context, await aiUsageService.read(auth.user.id, auth.user.workspaceId!, Number(context.url.searchParams.get('page') ?? 1), parseUsageFilters(context.url.searchParams))); return;
    }

    const usageReviews = path.match(/^\/api\/v1\/admin\/ai-usage\/([^/]+)\/reviews$/);
    if (usageReviews && (method === 'GET' || method === 'POST')) {
      await requireAiAdmin();
      if (method === 'GET') sendSuccess(context, await aiUsageService.reviewHistory(auth.user.id, auth.user.workspaceId!, usageReviews[1]!));
      else {
        assertPlatformWriteSecurity(context);
        sendSuccess(context, await aiUsageService.addReview(auth.user.id, auth.user.workspaceId!, usageReviews[1]!, await readJson(context)));
      }
      return;
    }

    if (path === '/api/v1/admin/dingtalk-mock/instances' && method === 'GET') {
      requirePlatformAdmin(auth);
      if (!isDingTalkMockMode()) throw new HttpError(409, 'DINGTALK_MOCK_DISABLED', '当前不是模拟审批模式');
      sendSuccess(context, mockDingTalkApprovalClient.list());
      return;
    }
    const mockDecisionMatch = path.match(/^\/api\/v1\/admin\/dingtalk-mock\/instances\/([^/]+)\/(approve|reject)$/);
    if (mockDecisionMatch && method === 'POST') {
      requirePlatformAdmin(auth);
      if (!isDingTalkMockMode()) throw new HttpError(409, 'DINGTALK_MOCK_DISABLED', '当前不是模拟审批模式');
      const approval = getDingTalkApproval();
      if (!approval) throw new HttpError(503, 'DINGTALK_APPROVAL_NOT_CONFIGURED', '模拟审批尚未配置');
      const processInstanceId = decodeURIComponent(mockDecisionMatch[1]!);
      const decision = mockDecisionMatch[2] === 'approve' ? 'approved' : 'rejected';
      const body = await readJson(context);
      try {
        mockDingTalkApprovalClient.decide(processInstanceId, decision);
        const result = await approval.applyMockDecision({
          processInstanceId,
          decision,
          ...(typeof body.comment === 'string' && body.comment.trim() ? { comment: body.comment.trim() } : {}),
        });
        sendSuccess(context, { processInstanceId, decision, ...result });
      } catch (error) {
        if (error instanceof DingTalkApprovalWorkflowError) throw new HttpError(error.status, error.code, error.message);
        throw new HttpError(404, 'DINGTALK_MOCK_INSTANCE_NOT_FOUND', error instanceof Error ? error.message : '模拟审批实例不存在');
      }
      return;
    }

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
        const rawRequestAction = actionFrom(`/${suffix}`, '') ?? suffix.replaceAll('-', '_');
        // Keep the public /submit-approval endpoint compatible with the service workflow action name.
        const requestAction = rawRequestAction === 'submit_approval' ? 'submit' : rawRequestAction;
        const request = await recruiting.getRequest(id);
        assertDepartmentScope(auth, request.departmentId);
        requireRole(auth, ['approve', 'reject'].includes(requestAction) ? RECRUITMENT_APPROVAL_ROLES : RECRUITMENT_WRITE_ROLES);
        const reason = (await readJson(context)).reason;
        const dingTalkApproval = getDingTalkApproval();
        try {
          const startsNewApproval = requestAction === 'submit' || requestAction === 'resubmit';
          const approvalMode = startsNewApproval
            ? (await recruitmentApprovalSettings.getMode(auth.user.workspaceId)).mode
            : 'platform';
          if (startsNewApproval && approvalMode === 'dingtalk') {
            if (!dingTalkApproval) throw new HttpError(503, 'DINGTALK_APPROVAL_NOT_CONFIGURED', '企业已选择钉钉审批，但钉钉审批服务尚未配置');
            const result = await executeRecruitmentApprovalAction({
              requestId: request.id, action: requestAction, actorId: auth.user.id,
              request: {
                title: request.title,
                departmentId: request.departmentId,
                headcount: request.headcount,
                salaryRange: request.salaryRange,
                justification: request.justification,
              },
              performLocalAction: () => recruiting.requestAction(id, requestAction, reason, auth.user.id),
              getCurrentInstanceId: async () => {
                const approval = await recruiting.getRequestApproval(id)
                if (!approval.current) throw new DingTalkApprovalWorkflowError('APPROVAL_INSTANCE_REQUIRED', '当前需求无可用审批实例', 409)
                return approval.current.id
              },
              resolveOriginatorUserId: resolveDingTalkOriginatorUserId,
              startExternalApproval: (approvalInput) => dingTalkApproval.start(approvalInput),
              assertLocalDecisionAllowed: (subjectType, subjectId) => dingTalkApproval.assertLocalDecisionAllowed(subjectType, subjectId),
            })
            sendSuccess(context, result)
          } else {
            const result = await executePlatformRecruitmentApprovalAction({
              requestId: request.id,
              action: requestAction,
              performLocalAction: () => recruiting.requestAction(id, requestAction, reason, auth.user.id),
              assertLocalDecisionAllowed: async (subjectType, subjectId) => {
                if (process.env.NODE_ENV !== 'test' && await dingTalkApprovalRepository.hasActiveExternalApproval(subjectType, subjectId)) {
                  throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_ACTIVE', '该事项正在钉钉审批，必须由钉钉审批回调更新结果', 409)
                }
              },
            })
            sendSuccess(context, result)
          }
        } catch (error) {
          if (error instanceof DingTalkApprovalWorkflowError) throw new HttpError(error.status, error.code, error.message)
          if (error instanceof RecruitmentApprovalSettingsError) throw new HttpError(error.status, error.code, error.message)
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
    const candidateResumeApplicationMatch = path.match(/^\/api\/v1\/candidates\/([^/]+)\/resumes\/([^/]+)\/analyze-for-application$/);
    if (candidateResumeApplicationMatch && method === 'POST') {
      requireRole(auth, CANDIDATE_WRITE_ROLES);
      const input = await readJson(context) as { applicationId?: unknown };
      if (!input || typeof input.applicationId !== 'string' || !input.applicationId.trim()) throw new HttpError(400, 'VALIDATION_ERROR', '请选择目标申请');
      await recruiting.assertCandidateInScope(candidateResumeApplicationMatch[1]!, departmentScope(auth));
      await recruiting.assertApplicationInScope(input.applicationId, departmentScope(auth));
      sendSuccess(context, await recruiting.analyzeResumeForApplication(candidateResumeApplicationMatch[1]!, candidateResumeApplicationMatch[2]!, input.applicationId, auth.user.id), 202);
      return;
    }
    const candidateResumeReanalysisMatch = path.match(/^\/api\/v1\/candidates\/([^/]+)\/resumes\/([^/]+)\/reanalyze$/);
    if (candidateResumeReanalysisMatch && method === 'POST') {
      requireRole(auth, CANDIDATE_WRITE_ROLES);
      await recruiting.assertCandidateInScope(candidateResumeReanalysisMatch[1]!, departmentScope(auth));
      sendSuccess(context, await recruiting.reanalyzeResume(candidateResumeReanalysisMatch[1]!, candidateResumeReanalysisMatch[2]!, auth.user.id), 202);
      return;
    }
    const candidateResumeDocumentMatch = path.match(/^\/api\/v1\/candidates\/([^/]+)\/resumes\/([^/]+)\/original$/);
    if (candidateResumeDocumentMatch && method === 'GET') {
      await recruiting.assertCandidateInScope(candidateResumeDocumentMatch[1]!, departmentScope(auth));
      context.res.setHeader('cache-control', 'private, no-store');
      sendSuccess(context, await recruiting.getResumeDocument(candidateResumeDocumentMatch[1]!, candidateResumeDocumentMatch[2]!));
      return;
    }
    const candidateDetailMatch = path.match(/^\/api\/v1\/candidates\/([^/]+)$/);
    if (candidateDetailMatch && method === 'GET') { await recruiting.assertCandidateInScope(candidateDetailMatch[1]!, departmentScope(auth)); const result = await recruiting.getCandidate(candidateDetailMatch[1]!); sendSuccess(context, result); return; }
    if (candidateDetailMatch && method === 'DELETE') { requireRole(auth, CANDIDATE_WRITE_ROLES); await recruiting.assertCandidateInScope(candidateDetailMatch[1]!, departmentScope(auth)); await recruiting.deleteCandidate(candidateDetailMatch[1]!, auth.user.id); sendSuccess(context, { deleted: true }); return; }
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
    const analysisScoringMatch = path.match(/^\/api\/v1\/analysis-results\/([^/]+)\/scoring$/);
    if (analysisScoringMatch && method === 'PATCH') {
      requireRole(auth, CANDIDATE_WRITE_ROLES);
      const current = await recruiting.getAnalysisResultById(analysisScoringMatch[1]!);
      if (!current.applicationId) throw new RecruitingWorkflowError('APPLICATION_REQUIRED', '请先关联应聘岗位', 409);
      await recruiting.assertApplicationInScope(current.applicationId, departmentScope(auth));
      sendSuccess(context, await recruiting.updateResumeReview(current.id, await readJson(context) as never, auth.user.id)); return;
    }
    const analysisResultByIdMatch = path.match(/^\/api\/v1\/analysis-results\/([^/]+)$/);
    if (analysisResultByIdMatch && method === 'GET') { sendSuccess(context, await recruiting.getAnalysisResultById(analysisResultByIdMatch[1]!)); return; }
    if (analysisResultByIdMatch && method === 'PATCH') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.reviewAnalysisResult(analysisResultByIdMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
    const analysisResultActionMatch = path.match(/^\/api\/v1\/analysis-results\/([^/]+)\/review$/);
    if (analysisResultActionMatch && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.reviewAnalysisResult(analysisResultActionMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
    if (path === '/api/v1/applications' && method === 'GET') { sendList(context, await recruiting.listApplications(context.url.searchParams.get('candidateId') ?? undefined, context.url.searchParams.get('jobId') ?? undefined, departmentScope(auth))); return; }
    if (path === '/api/v1/dashboard/summary' && method === 'GET') { sendSuccess(context, await recruiting.getDashboardSummary(departmentScope(auth), ids => questionSheets.listDashboardReviews(ids))); return; }
    if (path === '/api/v1/reports' && method === 'GET') { sendSuccess(context, await recruiting.getReports(departmentScope(auth))); return; }
    if (path === '/api/v1/reports/funnel' && method === 'GET') { sendSuccess(context, (await recruiting.getReports(departmentScope(auth))).funnel); return; }
    if (path === '/api/v1/reports/channels' && method === 'GET') { sendSuccess(context, (await recruiting.getReports(departmentScope(auth))).channels); return; }
    if (path === '/api/v1/reports/cycle-time' && method === 'GET') { sendSuccess(context, (await recruiting.getReports(departmentScope(auth))).recruitmentCycle); return; }

    if (path === '/api/v1/ai-skills' && method === 'GET') {
      const targetType = context.url.searchParams.get('targetType')
      if (targetType !== null && targetType !== 'job_spec' && targetType !== 'jd' && targetType !== 'resume_score') throw new HttpError(400, 'VALIDATION_ERROR', 'targetType 必须是 job_spec、jd 或 resume_score')
      sendSuccess(context, await tenantSkills().listAiPromptSkills(true, (targetType ?? undefined) as AiPromptSkillTarget | undefined)); return;
    }
    if (path === '/api/v1/admin/ai-skills' && method === 'GET') { await requireAiAdmin(); sendSuccess(context, await tenantSkills().listAiPromptSkills()); return; }
    const assertScoringJobAccess = async (body: Record<string, unknown>) => {
      if (body.jobIds === undefined) return;
      if (!Array.isArray(body.jobIds) || body.jobIds.length > 200 || body.jobIds.some((id) => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
        throw new AdminValidationError('适用岗位必须是有效岗位 ID 数组，最多 200 个');
      }
      for (const id of new Set(body.jobIds as string[])) {
        const job = await recruiting.getJob(id);
        assertDepartmentScope(auth, job.departmentId);
      }
    };
    if (path === '/api/v1/admin/ai-skills' && method === 'POST') {
      await requireAiAdmin();
      try { const body = await readJson(context); await assertScoringJobAccess(body); sendSuccess(context, await tenantSkills().createAiPromptSkill(body as never, auth.user.id, context.requestId), 201); }
      catch (error) { if (error instanceof AdminValidationError) throw new HttpError(400, 'VALIDATION_ERROR', error.message); throw error; }
      return;
    }
    const adminAiSkillMatch = path.match(/^\/api\/v1\/admin\/ai-skills\/([^/]+)$/);
    if (adminAiSkillMatch && method === 'PATCH') {
      await requireAiAdmin();
      try { const body = await readJson(context); await assertScoringJobAccess(body); sendSuccess(context, await tenantSkills().updateAiPromptSkill(adminAiSkillMatch[1]!, body as never, auth.user.id, context.requestId)); }
      catch (error) { if (error instanceof AdminValidationError) throw new HttpError(400, 'VALIDATION_ERROR', error.message); if (error instanceof AdminNotFoundError) throw new HttpError(404, 'NOT_FOUND', error.message); throw error; }
      return;
    }
    if (adminAiSkillMatch && method === 'DELETE') {
      await requireAiAdmin();
      try { await tenantSkills().deleteAiPromptSkill(adminAiSkillMatch[1]!, auth.user.id, context.requestId); sendSuccess(context, { deleted: true }); }
      catch (error) { if (error instanceof AdminValidationError) throw new HttpError(400, 'VALIDATION_ERROR', error.message); if (error instanceof AdminNotFoundError) throw new HttpError(404, 'NOT_FOUND', error.message); throw error; }
      return;
    }

    if (path === '/api/v1/admin/users' && method === 'GET') { requirePlatformAdmin(auth); sendList(context, await adminService.listUsers()); return; }
    if (path === '/api/v1/admin/departments' && method === 'GET') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.listDepartments()); return; }
    if (path === '/api/v1/admin/departments' && method === 'POST') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.createDepartment(await readJson(context) as never, auth.user.id, context.requestId), 201); return; }
    const adminDepartmentMatch = path.match(/^\/api\/v1\/admin\/departments\/([^/]+)$/);
    if (adminDepartmentMatch && method === 'PATCH') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.updateDepartment(adminDepartmentMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (adminDepartmentMatch && method === 'DELETE') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.deleteDepartment(adminDepartmentMatch[1]!, auth.user.id, context.requestId)); return; }
    const adminUserMatch = path.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);
    if (adminUserMatch && method === 'PATCH') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.updateUser(adminUserMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/roles' && method === 'GET') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.listRoles()); return; }
    const adminRoleMatch = path.match(/^\/api\/v1\/admin\/roles\/([^/]+)$/);
    if (adminRoleMatch && method === 'PATCH') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.updateRole(adminRoleMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/settings' && method === 'GET') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.getSettings()); return; }
    if (path === '/api/v1/admin/settings' && method === 'PATCH') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.updateSettings(await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/dingtalk-settings' && method === 'GET') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.getDingTalkSettings()); return; }
    if (path === '/api/v1/admin/dingtalk-settings' && method === 'PATCH') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.updateDingTalkSettings(await readJson(context) as never, auth.user.id, context.requestId)); return; }
    // These settings use active-workspace owner/admin membership, not the separate global user_roles admin role.
    if (path === '/api/v1/admin/recruitment-approval-settings' && method === 'GET') {
      try { sendSuccess(context, await recruitmentApprovalSettings.getForAdmin(auth.user.workspaceId, auth.user.id)); }
      catch (error) {
        if (error instanceof RecruitmentApprovalSettingsError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
      return;
    }
    if (path === '/api/v1/admin/recruitment-approval-settings' && method === 'PATCH') {
      const body = await readJson(context);
      try {
        sendSuccess(context, await recruitmentApprovalSettings.update({ ...(auth.user.workspaceId ? { organizationId: auth.user.workspaceId } : {}), actorId: auth.user.id, mode: body.mode, requestId: context.requestId }));
      } catch (error) {
        if (error instanceof RecruitmentApprovalSettingsError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
      return;
    }
    if (path === '/api/v1/admin/dingtalk-approval-config' && method === 'GET') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.getDingTalkApprovalConfig()); return; }
    if (path === '/api/v1/admin/dingtalk-approval-config' && method === 'PATCH') {
      requirePlatformAdmin(auth);
      try { sendSuccess(context, await adminService.updateDingTalkApprovalConfig(await readJson(context) as never, auth.user.id, context.requestId)); }
      catch (error) {
        if (error instanceof AdminValidationError) throw new HttpError(400, 'VALIDATION_ERROR', error.message);
        if (error instanceof AdminNotFoundError) throw new HttpError(404, 'NOT_FOUND', error.message);
        throw error;
      }
      return;
    }
    if (path === '/api/v1/admin/dingtalk-connection-test' && method === 'POST') {
      requirePlatformAdmin(auth);
      const body = await readJson(context);
      sendSuccess(context, await adminService.testDingTalkConnection({
        ...(typeof body.appKey === 'string' ? { appKey: body.appKey } : {}),
        ...(typeof body.appSecret === 'string' ? { appSecret: body.appSecret } : {}),
      }));
      return;
    }
    if (path === '/api/v1/admin/resume-virus-scan' && method === 'GET') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.getResumeVirusScanSetting()); return; }
    if (path === '/api/v1/admin/resume-virus-scan' && method === 'PATCH') { requirePlatformAdmin(auth); const body = await readJson(context); if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', 'enabled 必须是布尔值'); sendSuccess(context, await adminService.updateResumeVirusScanSetting(body.enabled, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/ai-settings' && method === 'GET') { await requireAiAdmin(); context.res.setHeader('cache-control', 'no-store'); sendSuccess(context, await enterpriseAi.get(auth.user.workspaceId)); return; }
    if (path === '/api/v1/admin/ai-settings' && method === 'PATCH') {
      await requireAiAdmin();
      sendSuccess(context, await enterpriseAi.save(auth.user.workspaceId, await readJson(context), auth.user.id, context.requestId)); return;
    }
    if (path === '/api/v1/admin/ai-connection-test' && method === 'POST') {
      await requireAiAdmin();
      const body = await readJson(context);
      if (Object.keys(body).some(key => !['baseUrl', 'apiKey', 'timeoutMs'].includes(key))) throw new HttpError(400, 'VALIDATION_ERROR', '不支持的连接测试参数');
      const patch: Record<string, unknown> = {};
      if (body.baseUrl !== undefined) patch.OPENAI_BASE_URL = body.baseUrl;
      if (body.apiKey !== undefined) patch.OPENAI_API_KEY = body.apiKey;
      if (body.timeoutMs !== undefined) patch.OPENAI_TIMEOUT_MS = String(body.timeoutMs);
      validateEnterpriseAiPatch(patch);
      const env = { ...await tenantAiEnv(), ...patch };
      assertAiEndpointAllowed(env.OPENAI_BASE_URL ?? '');
      sendSuccess(context, await testAiConnection({}, env, (url, init) => fetch(url, { ...init, redirect: 'error' }))); return;
    }
    if (path === '/api/v1/admin/channel-settings' && method === 'GET') { requirePlatformAdmin(auth); sendSuccess(context, await adminService.getChannelSettings()); return; }
    if (path === '/api/v1/admin/channel-settings' && method === 'PATCH') {
      requirePlatformAdmin(auth);
      try {
        sendSuccess(context, await adminService.updateChannelSettings(await readJson(context) as Record<string, string>, auth.user.id, context.requestId));
      } catch (error) {
        if (error instanceof ChannelSettingsValidationError) throw new HttpError(400, error.code, error.message);
        throw error;
      }
      return;
    }
    const channelConnectionTestMatch = path.match(/^\/api\/v1\/admin\/channel-connections\/([^/]+)\/test$/);
    if (channelConnectionTestMatch && method === 'POST') {
      requirePlatformAdmin(auth);
      const provider = channelConnectionTestMatch[1] as ChannelProvider;
      sendSuccess(context, await adminService.testChannelConnection(provider));
      return;
    }
    if (path === '/api/v1/admin/analysis-tasks' && method === 'GET') { requireRole(auth, ADMIN_ROLES); sendList(context, await recruiting.listAnalysisTasks(context.url.searchParams.get('status') ?? undefined)); return; }
    if (path === '/api/v1/admin/audit-logs' && method === 'GET') { requirePlatformAdmin(auth); sendList(context, await adminService.listAuditLogs(Number(context.url.searchParams.get('limit') ?? '50'))); return; }
    if (path === '/api/v1/workflow-events' && method === 'GET') {
      const subjectTypeParam = context.url.searchParams.get('subjectType');
      const subjectType = subjectTypeParam === 'recruitment_request' || subjectTypeParam === 'job' || subjectTypeParam === 'offer' || subjectTypeParam === 'onboarding' || subjectTypeParam === 'candidate' || subjectTypeParam === 'application' || subjectTypeParam === 'interview' ? subjectTypeParam : undefined;
      const rawLimit = context.url.searchParams.get('limit');
      const limit = rawLimit ? Number(rawLimit) : undefined;
      if (rawLimit && (!Number.isInteger(limit) || (limit ?? 0) < 1)) throw new HttpError(400, 'VALIDATION_ERROR', 'limit 必须是大于 0 的整数');
      const filters: Parameters<RecruitingService['listWorkflowEvents']>[0] = {};
      if (subjectType) filters.subjectType = subjectType;
      const candidateId = context.url.searchParams.get('candidateId');
      if (candidateId) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateId)) throw new HttpError(400, 'VALIDATION_ERROR', 'candidateId 格式无效');
        await recruiting.assertCandidateInScope(candidateId, departmentScope(auth));
        filters.candidateId = candidateId;
        const departmentId = departmentScope(auth);
        if (departmentId) filters.departmentId = departmentId;
      }
      if (limit) filters.limit = limit;
      sendSuccess(context, await recruiting.listWorkflowEvents(filters));
      return;
    }
    if (path === '/api/v1/applications' && method === 'POST') { requireRole(auth, APPLICATION_WRITE_ROLES); sendSuccess(context, await recruiting.createApplication(await readJson(context) as never, auth.user.id), 201); return; }
    const applicationDeleteMatch = path.match(/^\/api\/v1\/applications\/([^/]+)$/);
    if (applicationDeleteMatch && method === 'DELETE') { requireRole(auth, APPLICATION_WRITE_ROLES); await recruiting.assertApplicationInScope(applicationDeleteMatch[1]!, departmentScope(auth)); await recruiting.deleteApplication(applicationDeleteMatch[1]!, auth.user.id); sendSuccess(context, { deleted: true }); return; }
    if (path === '/api/v1/onboarding' && method === 'GET') { sendList(context, await recruiting.listOnboarding(departmentScope(auth))); return; }
    const onboardingMatch = path.match(/^\/api\/v1\/onboarding\/([^/]+)(?:\/(.*))?$/);
    if (onboardingMatch) {
      const onboardingId = onboardingMatch[1]!; const suffix = onboardingMatch[2] ?? '';
      if (!suffix && method === 'GET') { await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.getOnboarding(onboardingId)); return; }
      if (!suffix && method === 'PATCH') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.updateOnboarding(onboardingId, await readJson(context) as never, auth.user.id)); return; }
      if (method === 'POST') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); const body = await readJson(context); sendSuccess(context, await recruiting.onboardingAction(onboardingId, suffix.replaceAll('-', '_'), body.reason, auth.user.id)); return; }
    }    if (path === '/api/v1/offers' && method === 'GET') { sendList(context, await recruiting.listOffers(context.url.searchParams.get('status') ?? undefined, departmentScope(auth))); return; }
    if (path === '/api/v1/offers/eligible-applications' && method === 'GET') { requireRole(auth, OFFER_WRITE_ROLES); sendList(context, await recruiting.listApplications(undefined, undefined, departmentScope(auth), true)); return; }
    if (path === '/api/v1/offers' && method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); sendSuccess(context, await recruiting.createOffer(await readJson(context) as never, auth.user.id), 201); return; }
    const offerMatch = path.match(/^\/api\/v1\/offers\/([^/]+)(?:\/(.*))?$/);
    if (offerMatch) { const id=offerMatch[1]!; const suffix=offerMatch[2] ?? ''; await recruiting.assertOfferInScope(id, departmentScope(auth)); if (!suffix && method === 'GET') { const result = await recruiting.getOffer(id); setVersionEtag(context, result.version); sendSuccess(context, result); return; } if (!suffix && method === 'PATCH') { requireRole(auth, OFFER_WRITE_ROLES); const current = await recruiting.getOffer(id); assertVersion(parseIfMatch(context), current.version); const result = await recruiting.updateOffer(id, await readJson(context) as never, auth.user.id); setVersionEtag(context, result.version); sendSuccess(context, result); return; } if (method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); const body=await readJson(context); const action=suffix.replaceAll('-', '_'); const dingTalkApproval = getDingTalkApproval(); if (!dingTalkApproval || !usePostgres || !['submit_approval','approve','reject'].includes(action)) { sendSuccess(context, await recruiting.offerAction(id, action, body.reason, auth.user.id)); return; } const offer=await recruiting.getOffer(id); const version=offer.versions.find((item)=>item.id===offer.currentVersionId) ?? offer.versions.sort((a,b)=>b.version-a.version)[0]; if (!version) throw new HttpError(409,'OFFER_VERSION_REQUIRED','Offer 缺少当前版本'); try { const result=await executeOfferApprovalAction({ offerId:offer.id, action, actorId:auth.user.id, offer:{positionTitle:version.positionTitle,departmentId:version.departmentId,baseSalary:version.compensation.baseSalary}, performLocalAction:()=>recruiting.offerAction(id,action,body.reason,auth.user.id), getCurrentInstanceId:async()=>{ const found=await createDatabasePool().query(`WITH created AS (INSERT INTO approval_instances (id, subject_type, subject_id, version, status, current_step, created_by, updated_at) SELECT gen_random_uuid(), 'offer', $1::uuid, COALESCE(MAX(version), 0) + 1, 'pending', 1, $2::uuid, now() FROM approval_instances WHERE subject_type = 'offer' AND subject_id = $1::uuid RETURNING id) INSERT INTO approval_steps (id, approval_instance_id, step_no, approver_role_code, status) SELECT gen_random_uuid(), id, 1, 'approver', 'pending' FROM created RETURNING approval_instance_id AS id`,[offer.id,auth.user.id]); if (!found.rows[0]) throw new DingTalkApprovalWorkflowError('APPROVAL_INSTANCE_REQUIRED','当前 Offer 无可用审批实例',409); return String(found.rows[0].id) }, resolveOriginatorUserId: resolveDingTalkOriginatorUserId, startExternalApproval:(input)=>dingTalkApproval.start(input), assertLocalDecisionAllowed:(subjectType,subjectId)=>dingTalkApproval.assertLocalDecisionAllowed(subjectType,subjectId) }); sendSuccess(context,result) } catch(error) { if(error instanceof DingTalkApprovalWorkflowError) throw new HttpError(error.status,error.code,error.message); throw error } return; } }
    if (path === '/api/v1/interviews' && method === 'GET') { sendList(context, await recruiting.listInterviews(context.url.searchParams.get('applicationId') ?? undefined, departmentScope(auth))); return; }
    if (path === '/api/v1/interviewer-options' && method === 'GET') { requireRole(auth, INTERVIEW_WRITE_ROLES); sendSuccess(context, await adminService.listInterviewerOptions(auth.user.workspaceId)); return; }
    if (path === '/api/v1/interviews' && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertApplicationInScope(String((await readJson(context)).applicationId ?? ''), departmentScope(auth)); sendSuccess(context, await recruiting.createInterview(await readJson(context) as never, auth.user.id), 201); return; }
    const summaryMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/summary$/);
    if (summaryMatch && (method === 'GET' || method === 'POST')) {
      requireRole(auth, INTERVIEW_WRITE_ROLES)
      await recruiting.assertInterviewInScope(summaryMatch[1]!, departmentScope(auth))
      sendSuccess(context, method === 'GET' ? await interviewSummaries.latest(summaryMatch[1]!) : await interviewSummaries.request(summaryMatch[1]!, auth.user.id), method === 'POST' ? 202 : 200)
      return
    }
    const audioRecordingMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/recordings(?:\/([0-9a-f-]{36}))?$/i);
    const fullAudioMatch = path.match(new RegExp('^/api/v1/interviews/([^/]+)/recordings/full$', 'i'));
    const fullAudioTranscriptionMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/recordings\/transcription$/i);
    if (fullAudioTranscriptionMatch && (method === 'GET' || method === 'POST')) {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      const interviewId = fullAudioTranscriptionMatch[1]!;
      await recruiting.assertInterviewInScope(interviewId, departmentScope(auth));
      const sessionId = context.url.searchParams.get('sessionId') || '';
      const source = context.url.searchParams.get('source') || 'all';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) || !['all','microphone','meeting','legacy'].includes(source))
        throw new HttpError(400, 'INVALID_INPUT', '录音场次或音源无效');
      const manifest = await interviewAudioRecordings.manifest(interviewId, sessionId);
      const fingerprint = fullInterviewAudio.fingerprint(manifest, source as FullAudioSource);
      const key = `interviews/${sessionId}/transcription/${source}-${fingerprint}.json`;
      const job = method === 'POST'
        ? await fullAudioTranscription.start(key, () => fullInterviewAudio.load(sessionId, manifest, source as FullAudioSource))
        : await fullAudioTranscription.get(key);
      sendSuccess(context, job);
      return;
    }
    if (fullAudioMatch && method === 'GET') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      const interviewId = fullAudioMatch[1]!;
      await recruiting.assertInterviewInScope(interviewId, departmentScope(auth));
      const sessionId = context.url.searchParams.get('sessionId') || '';
      const source = context.url.searchParams.get('source') || 'all';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) || !['all','microphone','meeting','legacy'].includes(source))
        throw new HttpError(400, 'INVALID_INPUT', '录音场次或音源无效');
      try {
        const manifest = await interviewAudioRecordings.manifest(interviewId, sessionId);
        const audio = await fullInterviewAudio.load(sessionId, manifest, source as FullAudioSource);
        sendInterviewAudio(context.res, audio, 'audio/mp4', context.req.headers.range);
      } catch (error) {
        if (error instanceof FullAudioError) throw new HttpError(error.status, 'FULL_AUDIO_UNAVAILABLE', error.message);
        throw error;
      }
      return;
    }
    if (audioRecordingMatch && method === 'GET') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      const interviewId = audioRecordingMatch[1]!;
      await recruiting.assertInterviewInScope(interviewId, departmentScope(auth));
      if (!audioRecordingMatch[2]) { sendSuccess(context, await interviewAudioRecordings.list(interviewId)); return; }
      const recording = await interviewAudioRecordings.find(interviewId, audioRecordingMatch[2]);
      if (!recording) throw new HttpError(404, 'AUDIO_NOT_FOUND', '未找到该面试的原音频');
      let audio: Buffer;
      try { audio = await liveInterviewAudioStorage.read(recording.objectKey); }
      catch (error) {
        const cause = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
        if (cause.code === 'ENOENT' || cause.name === 'NoSuchKey' || cause.$metadata?.httpStatusCode === 404)
          throw new HttpError(404, 'AUDIO_NOT_FOUND', '原音频文件不存在或已移除');
        throw error;
      }
      sendInterviewAudio(context.res, audio, recording.contentType, context.req.headers.range);
      return;
    }
    const liveSessionCreateMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/live-sessions$/);
    if (liveSessionCreateMatch && method === 'GET') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(liveSessionCreateMatch[1]!, departmentScope(auth)); sendSuccess(context, await liveInterviewSessions.findLatest(liveSessionCreateMatch[1]!) ?? null); return; }
    if (liveSessionCreateMatch && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(liveSessionCreateMatch[1]!, departmentScope(auth)); const existing = await liveInterviewSessions.findActive(liveSessionCreateMatch[1]!); if (existing) throw new HttpError(409, 'LIVE_SESSION_ALREADY_ACTIVE', '该面试已存在进行中的实时会话，请先结束当前会话再创建新的会话'); sendSuccess(context, await liveInterviewSessions.create(liveSessionCreateMatch[1]!, auth.user.id), 201); return; }
    const liveSessionPath = parseLiveSessionPath(path);
    if (liveSessionPath && method === 'GET' && !liveSessionPath.action) { requireRole(auth, INTERVIEW_WRITE_ROLES); const result=await liveInterviewSessions.get(liveSessionPath.sessionId); await recruiting.assertInterviewInScope(result.session.interviewId, departmentScope(auth)); sendSuccess(context,result); return; }
    if (liveSessionPath && method === 'POST' && liveSessionPath.action === 'end') {
      requireRole(auth, INTERVIEW_WRITE_ROLES)
      const current = await liveInterviewSessions.get(liveSessionPath.sessionId)
      await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth))
      const session = await liveInterviewSessions.end(liveSessionPath.sessionId)
      liveInterviewVoices.forget(liveSessionPath.sessionId)
      let summaryGeneration: { queued: boolean; reason?: string } = { queued: false }
      try {
        await interviewSummaries.request(current.session.interviewId, auth.user.id)
        summaryGeneration = { queued: true }
      } catch (error) {
        summaryGeneration = { queued: false, reason: error instanceof Error ? `面试已保存，但总结任务创建失败：${error.message}` : '总结任务创建失败，可在面试详情重试。' }
      }
      sendSuccess(context, { ...session, summaryGeneration })
      return
    }
    if (liveSessionPath && method === 'POST' && liveSessionPath.action === 'question') { requireRole(auth, INTERVIEW_WRITE_ROLES); const current=await liveInterviewSessions.get(liveSessionPath.sessionId); await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth)); const body=await readJson(context); const question=String(body.question ?? '').trim(); if(!question||question.length>2000) throw new HttpError(400,'INVALID_INPUT','问题不能为空且不能超过 2000 个字符'); const source=body.source==='ai_adopted'?'ai_adopted':'manual'; const segmentId=typeof body.segmentId==='string'?body.segmentId:null; sendSuccess(context,await liveInterviewSessions.setCurrentQuestion(liveSessionPath.sessionId,question,source,auth.user.id,segmentId)); return; }
    if (liveSessionPath && method === 'POST' && liveSessionPath.action === 'segments') {
      requireRole(auth, INTERVIEW_WRITE_ROLES); const current=await liveInterviewSessions.get(liveSessionPath.sessionId); await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth)); const body=await readJson(context);
      const manualText=String(body.text ?? '').trim();
      if(manualText) {
        if(manualText.length>5000) throw new HttpError(400,'INVALID_INPUT','text 不能超过 5000 个字符');
        const role=body.role==='interviewer'?'interviewer':'candidate';
        const startMs=Number(body.startMs ?? 0); const endMs=Number(body.endMs ?? startMs);
        if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||startMs<0||endMs<startMs) throw new HttpError(400,'INVALID_INPUT','startMs/endMs 不合法');
        sendSuccess(context,[await liveInterviewSessions.addSegment(liveSessionPath.sessionId,{speakerId:role==='interviewer'?'manual_interviewer':'manual_candidate',role,confidence:1,text:manualText,startMs,endMs})],201);
        return;
      }
      const encoded=String(body.audioBase64 ?? ''); if(!encoded) throw new HttpError(400,'INVALID_INPUT','audioBase64 不能为空');
      try {
        const chunkOffsetMs = Number(body.chunkOffsetMs ?? 0);
        if (!Number.isFinite(chunkOffsetMs) || chunkOffsetMs < 0) throw new HttpError(400, 'INVALID_INPUT', 'chunkOffsetMs 必须是非负数');
        let source;
        try { source = parseAudioSource(body.audioSource); }
        catch { throw new HttpError(400, 'INVALID_INPUT', '音频来源、角色或多人标记无效'); }
        const chunkEndMs = body.chunkEndMs === undefined ? undefined : Number(body.chunkEndMs);
        if (chunkEndMs !== undefined && (!Number.isSafeInteger(chunkEndMs) || chunkEndMs < chunkOffsetMs || chunkEndMs - chunkOffsetMs > 600000)) {
          throw new HttpError(400, 'INVALID_INPUT', '录音结束时间无效');
        }
        if (source && (chunkEndMs === undefined || !Number.isSafeInteger(chunkOffsetMs) || chunkEndMs <= chunkOffsetMs)) throw new HttpError(400, 'INVALID_INPUT', '独立音轨必须提供有效的真实开始和结束时间');
        let checkpoint: TranscriptCheckpoint | undefined;
        if (body.streamingTranscript !== undefined) {
          const value = body.streamingTranscript as Partial<TranscriptCheckpoint> | null;
          if (!value || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20000
            || typeof value.complete !== 'boolean' || !Number.isSafeInteger(value.endMs)
            || value.endMs! < chunkOffsetMs || value.endMs! - chunkOffsetMs > 600000) {
            throw new HttpError(400, 'INVALID_INPUT', '流式转写文本或录音时间范围无效');
          }
          checkpoint = value as TranscriptCheckpoint;
          if (chunkEndMs !== undefined && checkpoint.endMs !== chunkEndMs) throw new HttpError(400, 'INVALID_INPUT', '流式转写与音轨时间范围不一致');
          if (source && (value as TranscriptCheckpoint & { audioSource?: string }).audioSource !== source.id) throw new HttpError(400, 'INVALID_INPUT', '流式转写与音轨来源不一致');
        }
        const contentType = String(body.contentType ?? 'audio/webm');
        const audio = Buffer.from(encoded, 'base64');
        const audioObjectKey = await liveInterviewAudioStorage.store(liveSessionPath.sessionId, audio, contentType, chunkOffsetMs, source?.id);
        const recording = { sessionId: liveSessionPath.sessionId, objectKey: audioObjectKey, contentType,
          offsetMs: Math.floor(chunkOffsetMs), endMs: chunkEndMs ?? checkpoint?.endMs ?? null, byteLength: audio.byteLength,
          ...(source ? { audioSource: source.id, sourceRole: source.role, sourceMultipleSpeakers: source.multipleSpeakers } : {}) };
        // Save before ASR: silence or recognition failure must never hide an uploaded recording.
        await interviewAudioRecordings.save(recording);
        let recognized: SpeakerSegment[];
        try { recognized = await transcribeInterviewChunk(audio, contentType); }
        catch (error) { if (!(error instanceof FunAsrError) && !(error instanceof FasterWhisperError) || !checkpoint) throw error; recognized = []; }
        if (chunkEndMs !== undefined) {
          const duration = chunkEndMs - chunkOffsetMs;
          recognized = recognized.filter(row => row.startMs >= 0 && row.startMs <= duration)
            .map(row => ({ ...row, endMs: Math.min(duration, row.endMs) }));
        }
        const identified = liveInterviewVoices.identify(liveSessionPath.sessionId, reconcileTranscript(recognized, checkpoint, chunkOffsetMs), source?.id);
        const transcribed = scopeSpeakersToChunk(identified, chunkOffsetMs).map(item => ({ ...item, startMs: item.startMs + chunkOffsetMs, endMs: item.endMs + chunkOffsetMs }));
        if (chunkEndMs === undefined && !checkpoint && transcribed.length) await interviewAudioRecordings.save({ ...recording,
          endMs: Math.max(recording.offsetMs, ...transcribed.map(item => Math.ceil(item.endMs))) });
        // Another upload may have saved segments or a human correction while ASR was running.
        const latest = await liveInterviewSessions.get(liveSessionPath.sessionId);
        const known: ConfirmedSpeakerRoles = {};
        const inferred: ConfirmedSpeakerRoles = {};
        for (const item of latest.segments) {
          if (item.role === 'unknown') continue;
          if (item.confidence === 1) known[item.speakerId] = item.role;
          else if (/(^|:)voice_/.test(item.speakerId) && item.confidence >= 0.6) inferred[item.speakerId] = item.role;
        }
        const mapped = mapAudioSourceRoles(transcribed, source, known, inferred);
        const saved = [];
        for (const item of mapped) saved.push(await liveInterviewSessions.addSegment(liveSessionPath.sessionId, { speakerId: stableRoleSpeakerId(item), role: item.role, confidence: item.confidence, text: item.text, startMs: item.startMs, endMs: item.endMs, audioObjectKey, ...(item.audioSource ? { audioSource: item.audioSource } : {}) }));
        if (latest.session.status === 'completed') liveInterviewVoices.forget(liveSessionPath.sessionId);
        sendSuccess(context, saved, 201);
      } catch (error) {
        if (error instanceof FunAsrError) throw new HttpError(error.code === 'NOT_CONFIGURED' ? 503 : 502, `FUNASR_${error.code}`, error.message);
        if (error instanceof FasterWhisperError) throw new HttpError(error.code === 'NOT_CONFIGURED' ? 503 : 502, `FASTER_WHISPER_${error.code}`, error.message);
        throw error;
      }
      return;
    }
    const liveSegmentMatch = path.match(/^\/api\/v1\/interview-live-segments\/([^/]+)\/(role|analyze)$/);
    if (liveSegmentMatch && method === 'POST') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      const body = await readJson(context);
      const segmentId = liveSegmentMatch[1]!;
      const analysisContext = await liveInterviewSessions.getAnalysisContext(segmentId);
      await recruiting.assertInterviewInScope(analysisContext.interviewId, departmentScope(auth));
      const ids = Array.isArray(body.segmentIds) ? body.segmentIds.map(String) : [segmentId];
      if (liveSegmentMatch[2] === 'role') {
        const role = String(body.role);
        if (role !== 'interviewer' && role !== 'candidate') throw new HttpError(400, 'INVALID_INPUT', 'role 必须是 interviewer 或 candidate');
        sendSuccess(context, await liveInterviewSessions.correctUtteranceRole(segmentId, ids, role));
        return;
      }
      if (analysisContext.segment.role !== 'candidate' || analysisContext.segment.confidence < 0.6) throw new HttpError(409, 'CANDIDATE_ROLE_UNCONFIRMED', '只有已确认的候选人回答才能进入 AI 分析');
      try {
        await liveInterviewSessions.getUtteranceText(segmentId, ids);
        const saved = await liveInterviewSessions.get(analysisContext.segment.sessionId);
        let model = '';
        const result = await analyzeActualAnswer(saved.segments, ids, {
          jobTitle: analysisContext.jobTitle,
          jobRequirements: analysisContext.jobRequirements.length ? analysisContext.jobRequirements : ['岗位要求未结构化'],
        }, async input => {
          const resumeContext = await recruiting.getInterviewQuestionContext(analysisContext.interviewId).then(ctx => [ctx.anonymizedResume, ...ctx.analysisSummary]).catch(() => []);
          const config = loadInterviewAnswerAnalyzerConfig(await tenantAiEnv());
          model = config.model;
          return createInterviewAnswerAnalyzer(config).analyze({ ...input, resumeContext });
        });
        await liveInterviewSessions.saveAnalysis(segmentId, result.question, result.analysis, model);
        sendSuccess(context, result.analysis);
      } catch (error) {
        if (error instanceof InterviewAnswerAnalysisError) throw new HttpError(error.code === 'AI_NOT_CONFIGURED' ? 503 : error.code === 'INVALID_INPUT' ? 400 : 502, error.code, error.message);
        throw error;
      }
      return;
    }
    const resumeQuestionsMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/questions$/);
    if (resumeQuestionsMatch && method === 'GET') { await recruiting.assertInterviewInScope(resumeQuestionsMatch[1]!, departmentScope(auth)); const saved = await interviewQuestionSets.get(resumeQuestionsMatch[1]!); sendSuccess(context, saved ? { questions: saved.questions, engine: saved.engine, updatedAt: saved.updatedAt, advisoryOnly: true, applicationStatusMutation: 'none' } : null); return; }
    const interviewMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)(?:\/(feedback|lock-feedback|conclude|questions))?$/);
    if (interviewMatch && method === 'GET' && !interviewMatch[2]) { await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); sendSuccess(context, await recruiting.getInterview(interviewMatch[1]!)); return; }
    if (interviewMatch && method === 'PATCH' && !interviewMatch[2]) { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); sendSuccess(context, await recruiting.updateInterviewSchedule(interviewMatch[1]!, await readJson(context), auth.user.id)); return; }
    if (interviewMatch && method === 'DELETE' && !interviewMatch[2]) { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); await recruiting.deleteInterview(interviewMatch[1]!, auth.user.id); sendSuccess(context, { deleted: true }); return; }
    if (interviewMatch && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); const body = await readJson(context); if (interviewMatch[2] === 'feedback') sendSuccess(context, await recruiting.submitFeedback(interviewMatch[1]!, body as never, auth.user.id)); else if (interviewMatch[2] === 'lock-feedback') sendSuccess(context, await recruiting.lockFeedback(interviewMatch[1]!, String(body.interviewerId ?? ''), auth.user.id)); else if (interviewMatch[2] === 'conclude') sendSuccess(context, await recruiting.concludeInterview(interviewMatch[1]!, String(body.outcome) as never, auth.user.id)); else if (interviewMatch[2] === 'questions') {
      const input = await recruiting.getInterviewQuestionContext(interviewMatch[1]!);
      const requestedCount = body.questionCount === undefined ? input.questionCount : Number(body.questionCount);
      if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 20) throw new HttpError(400, 'INVALID_INPUT', 'questionCount 必须是 1 到 20 的整数');
      if (body.includeCommonQuestions !== undefined && typeof body.includeCommonQuestions !== 'boolean') throw new HttpError(400, 'INVALID_INPUT', 'includeCommonQuestions 必须是布尔值');
      const generationInput = { ...input, questionCount: requestedCount, includeCommonQuestions: body.includeCommonQuestions === true };
      if (context.res.destroyed) return;
      const controller = new AbortController();
      const disconnect = () => { if (!context.res.writableEnded) controller.abort(); };
      context.res.once('close', disconnect);
      try {
        let questionSet: { questions: GeneratedInterviewQuestion[]; engine: 'llm' | 'local_fallback'; advisoryOnly: true; applicationStatusMutation: 'none'; generationWarning?: string };
        try {
          const generator = createInterviewQuestionGenerator(loadInterviewQuestionGeneratorConfig(await tenantAiEnv()));
          const generated = await generator.generate(generationInput, controller.signal);
          questionSet = { ...generated, engine: 'llm' };
        } catch (error) {
          if (controller.signal.aborted) return;
          if (!(error instanceof InterviewQuestionGenerationError)) throw error;
          if (error.code === 'INVALID_INPUT') throw new HttpError(400, error.code, error.message);
          const reason = error.code === 'AI_NOT_CONFIGURED' ? '当前企业未完整配置模型地址、密钥和模型名称。'
            : error.code === 'MODEL_RESPONSE_INVALID' ? '模型返回的题目数量、分组或评分格式不完整。'
            : error.message;
          const previous = await interviewQuestionSets.get(interviewMatch[1]!);
          if (previous?.engine === 'llm' && previous.questions.length) throw new HttpError(502, error.code, reason + ' 已保留原题库，请重试。');
          questionSet = { ...generateLocalInterviewQuestions(generationInput), engine: 'local_fallback', generationWarning: reason };
        }
        if (controller.signal.aborted || context.res.destroyed) return;
        const saved = await interviewQuestionSets.save({ interviewId: interviewMatch[1]!, generatedBy: auth.user.id, engine: questionSet.engine, questions: questionSet.questions });
        sendSuccess(context, { ...questionSet, updatedAt: saved.updatedAt });
      } finally { context.res.off('close', disconnect); }
    } return; }
    const applicationMatch = path.match(/^\/api\/v1\/applications\/([^/]+)\/status$/);
    if (applicationMatch && method === 'POST') { requireRole(auth, APPLICATION_WRITE_ROLES); await recruiting.assertApplicationInScope(applicationMatch[1]!, departmentScope(auth)); const body = await readJson(context); sendSuccess(context, await recruiting.updateApplicationStatus(applicationMatch[1]!, String(body.status) as never, body.reason, auth.user.id)); return; }

    // 面试问题表（初试 2 张 / 复试 3 张）：读写沿用应聘的部门范围口径。
    const sheetListMatch = path.match(/^\/api\/v1\/applications\/([^/]+)\/question-sheets$/);
    if (sheetListMatch && method === 'GET') {
      await recruiting.assertApplicationInScope(sheetListMatch[1]!, departmentScope(auth));
      sendSuccess(context, await questionSheets.getApplicationView(sheetListMatch[1]!));
      return;
    }
    const sheetMatch = path.match(/^\/api\/v1\/applications\/([^/]+)\/question-sheets\/(initial|final)\/(hr_screen|hiring_department|business|hr|boss)(?:\/(.*))?$/);
    if (sheetMatch) {
      const applicationId = sheetMatch[1]!; const stage = sheetMatch[2] as 'initial' | 'final'; const sheetType = sheetMatch[3] as 'hr_screen' | 'hiring_department' | 'business' | 'hr' | 'boss'; const suffix = sheetMatch[4] ?? '';
      await recruiting.assertApplicationInScope(applicationId, departmentScope(auth));
      if (!suffix && method === 'POST') {
        requireRole(auth, INTERVIEW_WRITE_ROLES);
        sendSuccess(context, await questionSheets.requestGeneration(applicationId, stage, sheetType, auth.user.id));
        return;
      }
      if (suffix === 'submit' && method === 'POST') {
        requireRole(auth, INTERVIEW_WRITE_ROLES);
        const sheet = await questionSheets.requireSheet(applicationId, stage, sheetType);
        sendSuccess(context, await questionSheets.submit(sheet.id, auth.user.id));
        return;
      }
      if (suffix === 'lock' && method === 'POST') {
        requireRole(auth, INTERVIEW_WRITE_ROLES);
        const sheet = await questionSheets.requireSheet(applicationId, stage, sheetType);
        sendSuccess(context, await questionSheets.lock(sheet.id, auth.user.id));
        return;
      }
      if (suffix === 'unlock' && method === 'POST') {
        requireRole(auth, INTERVIEW_WRITE_ROLES);
        const sheet = await questionSheets.requireSheet(applicationId, stage, sheetType);
        sendSuccess(context, await questionSheets.unlock(sheet.id, auth.user.id));
        return;
      }
      if (suffix === 'questions' && method === 'POST') {
        requireRole(auth, INTERVIEW_WRITE_ROLES);
        const body = await readJson(context);
        const sheet = await questionSheets.requireSheet(applicationId, stage, sheetType);
        sendSuccess(context, await questionSheets.addManualQuestion(sheet.id, {
          question: String(body.question ?? '').trim(),
          ...(typeof body.dimension === 'string' ? { dimension: body.dimension } : {}),
          ...(typeof body.answerText === 'string' ? { answerText: body.answerText } : {}),
        }), 201);
        return;
      }
      const questionMatch = suffix.match(/^questions\/([^/]+)$/);
      if (questionMatch && method === 'PATCH') {
        requireRole(auth, INTERVIEW_WRITE_ROLES);
        const body = await readJson(context);
        const sheet = await questionSheets.requireSheet(applicationId, stage, sheetType);
        sendSuccess(context, await questionSheets.patchQuestion(sheet.id, questionMatch[1]!, {
          ...(body.finalTier === undefined ? {} : { finalTier: (body.finalTier === null ? null : String(body.finalTier)) as 'excellent' | 'pass' | 'below' | null }),
          ...(body.finalScore === undefined ? {} : { finalScore: body.finalScore === null ? null : Number(body.finalScore) }),
          ...(body.comment === undefined ? {} : { comment: body.comment === null ? null : String(body.comment) }),
        }, auth.user.id));
        return;
      }
      if (questionMatch && method === 'DELETE') {
        requireRole(auth, INTERVIEW_WRITE_ROLES);
        const sheet = await questionSheets.requireSheet(applicationId, stage, sheetType);
        await questionSheets.deleteQuestion(sheet.id, questionMatch[1]!);
        sendSuccess(context, { ok: true });
        return;
      }
    }
    const stageDecisionMatch = path.match(/^\/api\/v1\/applications\/([^/]+)\/stages\/(initial|final)\/decision$/);
    if (stageDecisionMatch && method === 'POST') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      await recruiting.assertApplicationInScope(stageDecisionMatch[1]!, departmentScope(auth));
      const body = await readJson(context);
      sendSuccess(context, await questionSheets.recordDecision(stageDecisionMatch[1]!, stageDecisionMatch[2] as 'initial' | 'final', String(body.decision ?? '') as never, auth.user.id));
      return;
    }
    const stageWeightsMatch = path.match(/^\/api\/v1\/applications\/([^/]+)\/stages\/(initial|final)\/weights$/);
    if (stageWeightsMatch && method === 'PATCH') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      await recruiting.assertApplicationInScope(stageWeightsMatch[1]!, departmentScope(auth));
      const body = await readJson(context);
      const rawSheets = body && typeof body.sheets === 'object' && body.sheets !== null ? body.sheets as Record<string, unknown> : {};
      const sheets: Record<string, number> = {};
      for (const [key, value] of Object.entries(rawSheets)) sheets[key] = Number(value);
      sendSuccess(context, await questionSheets.updateStageWeights(stageWeightsMatch[1]!, stageWeightsMatch[2] as 'initial' | 'final', { sheets, recording: Number(body.recording ?? 0) }, auth.user.id));
      return;
    }
    const jobMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)(?:\/(.*))?$/);
    if (jobMatch) {
      const id = jobMatch[1]!; const suffix = jobMatch[2] ?? '';
      const job = await recruiting.getJob(id); assertDepartmentScope(auth, job.departmentId);
      if (!suffix && method === 'GET') { setVersionEtag(context, job.version); sendSuccess(context, job); return; }
      if (!suffix && method === 'DELETE') { requireRole(auth, JOB_WRITE_ROLES); await recruiting.deleteJob(id, auth.user.id); sendSuccess(context, { deleted: true }); return; }
      if (!suffix && method === 'PATCH') { requireRole(auth, JOB_WRITE_ROLES); assertVersion(parseIfMatch(context), job.version); const result = await recruiting.updateJob(id, await readJson(context) as never, auth.user.id); setVersionEtag(context, result.version); sendSuccess(context, result); return; }
      if (suffix === 'spec/generate' && method === 'POST') {
        requireRole(auth, JOB_WRITE_ROLES);
        const body = await readJson(context);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
        const skillId = typeof body.skillId === 'string' ? body.skillId.trim() : undefined;
        if (prompt && prompt.length > 4000) throw new HttpError(400, 'VALIDATION_ERROR', '提示词不能超过 4000 个字符');
        const skill = skillId ? await tenantSkills().getAiPromptSkill(skillId, true) : undefined;
        if (skill && skill.targetType !== 'job_spec' && skill.targetType !== 'both') throw new HttpError(400, 'VALIDATION_ERROR', '所选 Skill 不适用于岗位说明书');
        const generationInput = { jobTitle: job.title, ...(prompt ? { prompt } : {}), ...(skill ? { skill: skill.content } : {}) };
        try {
          const config = loadJobSpecGeneratorConfig(await tenantAiEnv());
          const generateAndSave = async () => {
            const generated = await createJobSpecGenerator(config).generate(generationInput);
            return recruiting.createSpec(id, generated, auth.user.id);
          };
          const generated = usePostgres ? await aiUsageService.execute({ organizationId: auth.user.workspaceId!, actorId: auth.user.id,
            operation: 'job_spec', resourceId: id, key: usageKey(context.req.headers['idempotency-key'], context.requestId), input: generationInput, model: config.model, requestId: context.requestId }, generateAndSave) : await generateAndSave();
          sendSuccess(context, generated);
        } catch (error) {
          if (error instanceof JobSpecGenerationError) {
            if (error.code === 'AI_NOT_CONFIGURED') {
              sendSuccess(context, await recruiting.createSpec(id, generateLocalJobSpec({ jobTitle: job.title }), auth.user.id));
              return;
            }
            throw new HttpError(error.code === 'INVALID_INPUT' ? 400 : 502, error.code, error.message);
          }
          throw error;
        }
        return;
      }
      if (suffix === 'spec' && method === 'POST') { requireRole(auth, JOB_WRITE_ROLES); sendSuccess(context, await recruiting.createSpec(id, await readJson(context) as never, auth.user.id)); return; }
      if (suffix === 'jd/generate' && method === 'POST') {
        requireRole(auth, JOB_WRITE_ROLES);
        const body = await readJson(context);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : undefined;
        const skillId = typeof body.skillId === 'string' ? body.skillId.trim() : undefined;
        if (prompt && prompt.length > 4000) throw new HttpError(400, 'VALIDATION_ERROR', '提示词不能超过 4000 个字符');
        const skill = skillId ? await tenantSkills().getAiPromptSkill(skillId, true) : undefined;
        if (skill && skill.targetType !== 'jd' && skill.targetType !== 'both') throw new HttpError(400, 'VALIDATION_ERROR', '所选 Skill 不适用于 JD');
        const generationInput = {
          jobTitle: job.title,
          ...(prompt ? { prompt } : {}),
          ...(skill ? { skill: skill.content } : {}),
          ...(job.spec ? { spec: {
            summary: job.spec.summary,
            responsibilities: job.spec.responsibilities,
            requirements: job.spec.requirements,
            skills: job.spec.skills,
          } } : {}),
        };
        try {
          const config = loadJobDescriptionGeneratorConfig(await tenantAiEnv());
          const generateAndSave = async () => {
            const generated = await createJobDescriptionGenerator(config).generate(generationInput);
            return recruiting.createJd(id, generated, auth.user.id);
          };
          const generated = usePostgres ? await aiUsageService.execute({ organizationId: auth.user.workspaceId!, actorId: auth.user.id,
            operation: 'jd', resourceId: id, key: usageKey(context.req.headers['idempotency-key'], context.requestId), input: generationInput, model: config.model, requestId: context.requestId }, generateAndSave) : await generateAndSave();
          sendSuccess(context, generated);
        } catch (error) {
          if (error instanceof JobDescriptionGenerationError) {
            if (error.code === 'AI_NOT_CONFIGURED') {
              sendSuccess(context, await recruiting.createJd(id, generateLocalJobDescription(generationInput), auth.user.id));
              return;
            }
            throw new HttpError(error.code === 'INVALID_INPUT' ? 400 : 502, error.code, error.message);
          }
          throw error;
        }
        return;
      }
      if (suffix === 'jd' && method === 'POST') { requireRole(auth, JOB_WRITE_ROLES); sendSuccess(context, await recruiting.createJd(id, await readJson(context) as never, auth.user.id)); return; }
      if (suffix === 'spec-versions' && method === 'GET') { sendSuccess(context, await recruiting.listJobSpecVersions(id)); return; }
      if (suffix === 'jd-versions' && method === 'GET') { sendSuccess(context, await recruiting.listJobDescriptionVersions(id)); return; }
      if (method === 'POST') { requireRole(auth, JOB_WRITE_ROLES); sendSuccess(context, await recruiting.jobAction(id, suffix.replaceAll('-', '_'), (await readJson(context)).reason, auth.user.id)); return; }
    }
  } catch (error) {
    if (error instanceof EnterpriseAiError) throw new HttpError(error.status, error.code, error.message);
    if (error instanceof AdminValidationError) throw new HttpError(400, 'VALIDATION_ERROR', error.message);
    if (error instanceof AdminNotFoundError) throw new HttpError(404, 'NOT_FOUND', error.message);
    if (error instanceof RepositoryNotFoundError) throw new HttpError(404, 'NOT_FOUND', error.message);
    errorFromRecruiting(error);
  }

  await next();
};

export const notFoundMiddleware: Middleware = async (context) => {
  throw new HttpError(404, 'NOT_FOUND', `未找到接口：${context.req.method} ${context.url.pathname}`);
};

export default routeMiddleware;

