import { BillingSandboxService } from './platform/billing-sandbox.js';
import { assertPlatformWriteSecurity } from './platform/access.js';
import { AiUsageService, usageKey } from './platform/ai-usage.js';
import { parseUsageFilters } from './platform/ai-usage-diagnostics.js';
import { EntitlementService } from './platform/entitlements.js';
import { PlatformService } from './platform/service.js';
import { PlatformUsersService } from './platform/users/service.js';
import { PlatformOperatorsService } from './admin/platform-operators.js';
import { OperationalRecoveryService } from './admin/operational-recovery.js';

import { mapTrialQuotaError, TrialQuotaService } from './platform/trial-quota.js';
import { EnterpriseAiStore, EnterpriseAiError, validateEnterpriseAiPatch, validateSelfServiceAiPatch, SELF_SERVICE_AI_BASE_URL, assertAiEndpointAllowed, meterAiOperation, createBillingFetch } from '@smartrecruit-pro/enterprise-ai';
import { readAiSettings, testAiConnection } from './admin/ai-settings.js';
import { decodePdfAttachment, readSmtpEnvSettings, renderRichEmailHtml, renderMarkdownEmail, sendSmtpMail, testSmtpConnection, updateSmtpEnvSettings } from './integrations/email/smtp.js';
import type { Middleware } from './http.js';
import { HttpError } from './http.js';
import { OfferEmailDeliveryStore } from './integrations/email/delivery-store.js';
import { sendSuccess, type ApiMeta } from './response.js';
import { readJson } from './body.js';
import { RecruitingService } from './recruiting/service.js';
import { offerTemplateFieldValues } from './recruiting/offer-template-fields.js';
import { RecruitingWorkflowError } from './recruiting/workflow.js';
import { NormalizedRecruitingRepository, RepositoryNotFoundError } from './recruiting/repositories/postgres-repository.js';
import { AdminService, AdminConflictError, AdminNotFoundError, AdminValidationError, type AiPromptSkillTarget } from './admin/service.js';
import { AiSettingsValidationError } from './admin/ai-settings.js';
import { ChannelSettingsValidationError } from './integrations/channels/settings.js';
import type { ChannelProvider } from './integrations/channels/types.js';
import type { Pool } from 'pg';
import { MemoryResumeImportStore, PostgresResumeImportStore, ResumeImportError, ResumeImportService } from './recruiting/resume-import.js';
import type { AuthService } from './auth/auth-service.js';
import { requireSystemAdministrator } from './auth/system-administrator.js';
import { isWorkspaceScopedPath } from './auth/workspace-context.js';
import { WorkspaceInvitationsService, InvitationError } from './auth/workspace-invitations.js';
import { readSavedAccountSessions, buildSavedAccountsCookie } from './auth/saved-accounts.js';
import { resolveAuthClientIp } from './auth/client-ip.js';
import type { AuthSession, Role } from './auth/types.js';
import { timingSafeEqual } from 'node:crypto';
import { DingTalkJobSyncError, DingTalkJobSyncService } from './integrations/dingtalk/job-sync.js';
import { PostgresDingTalkJobSyncRepository } from './integrations/dingtalk/postgres-job-sync.js';
import { MemoryDingTalkJobSyncRepository } from './integrations/dingtalk/memory-job-sync.js';
import { createInterviewQuestionGenerator, generateLocalInterviewQuestions, InterviewQuestionGenerationError, loadInterviewQuestionGeneratorConfig, questionsForInterviewGroup, replaceInterviewQuestionGroup, type InterviewQuestionConversationMessage, type InterviewQuestionGroup } from './interviews/question-generator.js';
import { createInterviewAnswerAnalyzer, InterviewAnswerAnalysisError, loadInterviewAnswerAnalyzerConfig } from './interviews/answer-analyzer.js';
import { createConfiguredLiveSemanticRoleReviewer } from './interviews/live-semantic-role-review.js';
import { analyzeActualAnswer } from './interviews/actual-answer-analysis.js';
import { selectUtteranceSegments } from './interviews/utterance-segments.js';
import { createJobSpecGenerator, generateLocalJobSpec, JobSpecGenerationError, loadJobSpecGeneratorConfig } from './recruiting/job-spec-generator.js';
import { createJobDescriptionGenerator, generateLocalJobDescription, JobDescriptionGenerationError, loadJobDescriptionGeneratorConfig } from './recruiting/job-description-generator.js';
import { FunAsrError, loadFunAsrConfig, probeFunAsrService } from './interviews/funasr-client.js';
import { FasterWhisperError, loadFasterWhisperConfig, probeFasterWhisperService } from './interviews/faster-whisper-client.js';
import { transcribeLiveInterviewChunk as transcribeInterviewChunk } from './interviews/interview-transcriber.js';
import { mapInterviewRoles, scopeSpeakersToChunk, stableRoleSpeakerId, type ConfirmedSpeakerRoles, type SpeakerSegment } from './interviews/role-mapper.js';
import { SessionVoiceprintTracker } from './interviews/voiceprint-tracker.js';
import { mapAudioSourceRoles, parseAudioSource } from './interviews/audio-source.js';
import { reconcileTranscript, type TranscriptCheckpoint } from './interviews/transcript-checkpoint.js';
import { LiveInterviewSessionRepository } from './interviews/live-session-repository.js';
import { MemoryInterviewQuestionSetRepository, PostgresInterviewQuestionSetRepository } from './interviews/interview-question-set-repository.js';
import type { GeneratedInterviewQuestion } from './interviews/question-generator.js';
import { createConfiguredQuestionSheetService } from './interviews/question-sheet-runtime.js';
import { createConfiguredQuestionPreparationService } from './interviews/question-preparation-runtime.js';
import { createConfiguredInterviewSummaryService } from './interviews/interview-summary-service.js';
import { createLiveInterviewAudioStorage } from './interviews/live-audio-storage.js';
import { InterviewAudioRecordingRepository } from './interviews/audio-recording-repository.js';
import { LiveAudioTranscriptionRepository } from './interviews/live-audio-transcription-repository.js';
import { sendInterviewAudio, sendInterviewAudioStream } from './interviews/audio-response.js';
import { FullInterviewAudio, FullAudioError, type FullAudioSource } from './interviews/full-audio.js';
import { FullAudioTranscription } from './interviews/full-audio-transcription.js';
import { createConfiguredPersistentFullAudioTranscription } from './interviews/persistent-full-audio.js';
import { managedInterviewAudioStorage } from './interviews/managed-audio-storage.js';
import { createVoiceHealthProbe } from './interviews/voice-health.js';
import { billedRecordingChunks } from './interviews/billed-recording.js';
import { parseLiveSessionPath } from './interviews/live-route.js';
import { createInterviewObjectStorageFromEnv } from '@smartrecruit-pro/object-storage';
import { buildAuthCookie, buildCsrfCookie, generateCsrfToken, isAllowedResumeUploadOrigin, validateCsrf, readCookie, shouldProtectCsrf } from './auth/security.js';
import { isAllowedRequestOrigin } from './auth/request-origin.js';
/**
 * 浏览器写请求一定会带 Origin；自动化脚本、健康检查与测试可能不带。
 * 生产环境或显式开启 REQUIRE_CSRF 时，缺失 Origin 仍视为不可信来源；
 * 其他环境交给 CSRF Token 校验兜底，避免本地工具与测试被误伤。
 */
function originIsStrict(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.REQUIRE_CSRF === 'true'
}

export function createRouteMiddleware(pool: Pool, authService: AuthService): { middleware: Middleware; close(): Promise<void> } {
const reviewLiveRoles = createConfiguredLiveSemanticRoleReviewer(pool);
const recruitingService = new RecruitingService(undefined, undefined, undefined,
  process.env.NODE_ENV === 'test' ? undefined : new NormalizedRecruitingRepository(pool));
const resumeImportPool = process.env.NODE_ENV === 'test' ? undefined : pool;
const memoryResumeImports = new MemoryResumeImportStore();
const liveInterviewSessions = new LiveInterviewSessionRepository(pool);
const liveInterviewVoices = new SessionVoiceprintTracker();
const interviewQuestionSets = process.env.NODE_ENV === 'test'
  ? new MemoryInterviewQuestionSetRepository()
  : new PostgresInterviewQuestionSetRepository(pool);
const platformService = new PlatformService(pool);
const platformUsers = new PlatformUsersService(pool);
const platformOperators = new PlatformOperatorsService(pool);
const operationalRecovery = new OperationalRecoveryService(pool);
const trialQuotaService = new TrialQuotaService(pool);
const billingSandboxService = new BillingSandboxService(pool);
const aiUsageService = new AiUsageService(pool);
const entitlementService = new EntitlementService(pool);
const enterpriseAi = new EnterpriseAiStore(pool);
const questionPreparations = createConfiguredQuestionPreparationService({ pool, recruiting: recruitingService, questions: interviewQuestionSets });
const questionSheets = createConfiguredQuestionSheetService(pool);
const interviewSummaries = createConfiguredInterviewSummaryService(pool);
const rawInterviewStorage = createInterviewObjectStorageFromEnv(process.env);
const liveInterviewAudioStorage = createLiveInterviewAudioStorage(process.env.NODE_ENV === 'test' ? rawInterviewStorage : managedInterviewAudioStorage(pool, rawInterviewStorage));
const fullInterviewAudio = new FullInterviewAudio(liveInterviewAudioStorage);
const fullAudioTranscription = new FullAudioTranscription(liveInterviewAudioStorage);
const persistentFullAudio = process.env.NODE_ENV === 'test' ? undefined : createConfiguredPersistentFullAudioTranscription(pool);
const probeVoiceHealth = createVoiceHealthProbe(process.env.NODE_ENV === 'test' ? 0 : 3000);
const interviewAudioRecordings = new InterviewAudioRecordingRepository(pool);
const liveAudioTranscriptions = new LiveAudioTranscriptionRepository(pool);
const adminService = new AdminService(pool);
const workspaceInvitations = new WorkspaceInvitationsService(pool);
const dingTalkJobSync = new DingTalkJobSyncService(
  process.env.NODE_ENV === 'test' ? new MemoryDingTalkJobSyncRepository() : new PostgresDingTalkJobSyncRepository(pool),
  { platformBaseUrl: process.env.PLATFORM_BASE_URL || 'http://127.0.0.1:5174' },
);
const usePostgres = process.env.NODE_ENV !== 'test';
const emailDeliveries = usePostgres ? new OfferEmailDeliveryStore(pool) : undefined;
const AUTH_COOKIE = 'smartrecruit_session';
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 12;
const DEFAULT_AUTH_ROLES: Role[] = ['recruiter', 'hiring_manager', 'approver', 'admin', 'hr_admin', 'interviewer'];
// 企业业务账号不再按招聘专员、部门负责人、审批人或面试官拆分权限。
// 这些角色值仍保留在数据库中用于兼容历史数据，但业务接口统一按“已认证企业用户”处理。
const ENTERPRISE_USER_ROLES: Role[] = [...DEFAULT_AUTH_ROLES];
const ADMIN_ROLES: Role[] = ENTERPRISE_USER_ROLES;
const RECRUITMENT_WRITE_ROLES: Role[] = ENTERPRISE_USER_ROLES;
const JOB_WRITE_ROLES: Role[] = ENTERPRISE_USER_ROLES;
const CANDIDATE_WRITE_ROLES: Role[] = ENTERPRISE_USER_ROLES;
const APPLICATION_WRITE_ROLES: Role[] = ENTERPRISE_USER_ROLES;
const INTERVIEW_WRITE_ROLES: Role[] = ENTERPRISE_USER_ROLES;
const OFFER_WRITE_ROLES: Role[] = ENTERPRISE_USER_ROLES;
const OFFER_EMAIL_SENDABLE_STATUSES = new Set(['draft', 'pending_approval', 'approved', 'sent', 'cancelled', 'accepted']);
const ONBOARDING_WRITE_ROLES: Role[] = ENTERPRISE_USER_ROLES;
const ONBOARDING_MATERIAL_WRITE_ROLES: Role[] = ENTERPRISE_USER_ROLES;
// SMTP is an external side effect. Serialize matching Offer sends per API process.
const offerEmailInFlight = new Set<string>();
// A resolved SMTP request can still be followed by a database failure. Do not let
// this API process send the same Offer again until an administrator verifies it.
const offerEmailDeliveryUncertain = new Set<string>();

function reportsDisabledError(): HttpError {
  return new HttpError(404, 'RECRUITMENT_REPORTS_DISABLED', '招聘报表当前未启用');
}

async function reportsEnabledForRequest(): Promise<boolean> {
  try {
    return await adminService.getRecruitmentReportsEnabled();
  } catch (error) {
    // The test server can run without PostgreSQL. Production must fail closed.
    if (process.env.NODE_ENV === 'test') return process.env.VITE_RECRUITMENT_REPORTS_ENABLED !== 'false';
    throw error;
  }
}

function authClientAddress(context: Parameters<Middleware>[0]): { ipAddress?: string } {
  const ipAddress = resolveAuthClientIp(
    context.req.socket.remoteAddress,
    context.req.headers['x-forwarded-for'],
  );
  return ipAddress ? { ipAddress } : {};
}

async function sendAuthenticatedSession(
  context: Parameters<Middleware>[0],
  result: { session: AuthSession; token: string; recoveryCodes?: string[] },
  status = 200,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const production = process.env.NODE_ENV === 'production';
  const csrfToken = generateCsrfToken();
  const accounts = (await readSavedAccountSessions(authService, context.req.headers.cookie, production))
    .filter(({ auth }) => auth.user.id !== result.session.user.id);
  accounts.push({
    token: result.token,
    auth: { user: result.session.user, sessionId: result.session.sessionId, method: 'session' },
  });
  context.res.setHeader('set-cookie', [
    buildAuthCookie(result.token, { production, maxAge: SESSION_COOKIE_MAX_AGE }),
    buildCsrfCookie(csrfToken, { production, maxAge: SESSION_COOKIE_MAX_AGE }),
    buildSavedAccountsCookie(accounts, { production, maxAge: SESSION_COOKIE_MAX_AGE }),
  ]);
  sendSuccess(context, {
    user: result.session.user,
    sessionId: result.session.sessionId,
    expiresAt: result.session.expiresAt,
    workspaces: await authService.listWorkspaces(result.session.user.id),
    ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
    ...extra,
  }, status);
}

function errorFromRecruiting(error: unknown): never {
  mapTrialQuotaError(error);
  if (error instanceof RecruitingWorkflowError) throw new HttpError(error.status, error.code, error.message);
  if ((error as { code?: string }).code) {
    const cause = error as Error & { code: string; status?: number };
    throw new HttpError(cause.status ?? 500, cause.code, cause.message);
  }
  throw error;
}

function resumeImportsFor(
  recruiting: RecruitingService,
  organizationId: string | undefined,
): ResumeImportService {
  const store = usePostgres && organizationId && resumeImportPool
    ? new PostgresResumeImportStore(resumeImportPool, organizationId)
    : memoryResumeImports;
  return new ResumeImportService(store, recruiting);
}

async function runResumeImportAction<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ResumeImportError) throw new HttpError(error.status, error.code, error.message);
    throw error;
  }
}

function requirePlatformAdmin(auth: NonNullable<Parameters<Middleware>[0]['auth']>): void {
  requireSystemAdministrator(auth);
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
  // 部门仅用于组织数据，不再作为企业业务账号的数据访问边界。
  return undefined;
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

/** Offer no longer uses approval. Retain legacy storage fields without exposing them to clients. */
function withoutOfferApproval<T extends object>(value: T): Omit<T, 'approval'> {
  const { approval: _approval, ...result } = value as T & { approval?: unknown }
  return result
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
      originPolicy: 'same-origin',
      uptimeSeconds: Math.floor(process.uptime())
    });
    return;
  }

  if (path === '/api/v1/ready') {
    const voice = await probeVoiceHealth()
    const funasrStatus = voice.funasr, fasterWhisperStatus = voice.fasterWhisper
    const ocrStatus = process.env.OCR_SERVICE_URL?.trim() ? 'ok' : 'unavailable'
    const llmStatus = readAiSettings().configured ? 'ok' : 'not_configured'
    const voiceReady = voice.capabilities.chunks
    const degradedReasons: string[] = []
    if (!voiceReady) degradedReasons.push('语音转写主引擎 FunASR 未就绪，备用引擎不能替代实时与片段转写')
    if (ocrStatus !== 'ok') degradedReasons.push('OCR 服务未配置，简历原件解析不可用')
    if (llmStatus !== 'ok') degradedReasons.push('LLM 未配置，AI 生成能力不可用')
    sendSuccess(context, {
      status: degradedReasons.length ? 'degraded' : 'ready',
      degradedReasons,
      checks: {
        voiceCapabilities: voice.capabilities,
        configurationOnly: ['llm', 'ocr'],
        configuration: 'ok',
        auth: context.auth ? 'ok' : 'anonymous',
        externalServices: {
          funasr: funasrStatus,
          fasterWhisper: fasterWhisperStatus,
          llm: llmStatus,
          ocr: ocrStatus,
        },
      }
    });
    return;
  }

  if (path === '/api/v1/system/features' && method === 'GET') {
    requireAuth(context);
    context.res.setHeader('cache-control', 'private, no-store');
    sendSuccess(context, { recruitmentReportsEnabled: await reportsEnabledForRequest() });
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
      const origin = context.req.headers.origin;
      if ((origin || originIsStrict()) && !isAllowedRequestOrigin(context.req)) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任');
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

  if (path === '/api/v1/auth/security-config' && method === 'GET') {
    context.res.setHeader('cache-control', 'no-store');
    sendSuccess(context, authService.getSecurityConfig());
    return;
  }

  if (path === '/api/v1/auth/registration/code' && method === 'POST') {
    const body = await readJson(context);
    sendSuccess(context, await authService.requestRegistrationCode({
      email: String(body.email ?? ''),
      ...authClientAddress(context),
      ...(body.turnstileToken === undefined ? {} : { turnstileToken: String(body.turnstileToken) }),
    }));
    return;
  }

  if (path === '/api/v1/auth/password-reset/request' && method === 'POST') {
    const body = await readJson(context);
    sendSuccess(context, await authService.requestPasswordReset({
      email: String(body.email ?? ''),
      ...authClientAddress(context),
      ...(body.turnstileToken === undefined ? {} : { turnstileToken: String(body.turnstileToken) }),
    }));
    return;
  }

  if (path === '/api/v1/auth/password-reset/confirm' && method === 'POST') {
    const body = await readJson(context);
    sendSuccess(context, await authService.confirmPasswordReset({
      email: String(body.email ?? ''),
      verificationCode: String(body.verificationCode ?? ''),
      password: String(body.password ?? ''),
      ...authClientAddress(context),
      ...(body.turnstileToken === undefined ? {} : { turnstileToken: String(body.turnstileToken) }),
    }));
    return;
  }

  if (['/api/v1/auth/account/email/code', '/api/v1/auth/account/email', '/api/v1/auth/account/password', '/api/v1/auth/account/password/code', '/api/v1/auth/account/password/verify'].includes(path)) {
    if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 POST 请求');
    if (context.auth?.method !== 'session') throw new HttpError(401, 'AUTHENTICATION_REQUIRED', '请登录账号后再进行安全设置');
    const body = await readJson(context);
    const proof = { currentPassword: body.currentPassword, ...authClientAddress(context) };
    if (path === '/api/v1/auth/account/password/verify') {
      sendSuccess(context, await authService.verifyAccountPasswordCode(context.auth, { verificationCode: body.verificationCode }));
      return;
    }
    if (path === '/api/v1/auth/account/password/code') {
      sendSuccess(context, await authService.requestAccountPasswordCode(context.auth, authClientAddress(context)));
      return;
    }
    if (path === '/api/v1/auth/account/email/code') {
      sendSuccess(context, await authService.requestEmailChangeCode(context.auth, { ...proof, newEmail: body.newEmail }));
      return;
    }
    const result = path === '/api/v1/auth/account/email'
      ? await authService.confirmEmailChange(context.auth, { ...proof, newEmail: body.newEmail, verificationCode: body.verificationCode })
      : await authService.changePassword(context.auth, { ...proof, newPassword: body.newPassword, verificationCode: body.verificationCode });
    const production = process.env.NODE_ENV === 'production';
    context.res.setHeader('set-cookie', [buildAuthCookie('', { production, maxAge: 0 }), buildCsrfCookie('', { production, maxAge: 0 })]);
    sendSuccess(context, result);
    return;
  }

  if (path === '/api/v1/auth/login' && method === 'POST') {
    const body = await readJson(context);
    const result = await authService.login({
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      ...authClientAddress(context),
    });
    if (result.kind === 'authenticated') {
      await sendAuthenticatedSession(context, result, 200, { kind: 'authenticated' });
    } else {
      sendSuccess(context, result, 202);
    }
    return;
  }

  if ((path === '/api/v1/auth/mfa/verify' || path === '/api/v1/auth/mfa/setup/confirm') && method === 'POST') {
    const body = await readJson(context);
    const verified = await authService.verifyMfa({
      challengeToken: String(body.challengeToken ?? ''),
      code: String(body.code ?? ''),
      ...authClientAddress(context),
    });
    await sendAuthenticatedSession(context, verified);
    return;
  }

  if (path === '/api/v1/auth/mfa/setup/start' && method === 'POST') {
    const auth = requireAuth(context);
    sendSuccess(context, await authService.startMfaSetup(auth.user));
    return;
  }

  if (path === '/api/v1/auth/register' && method === 'POST') {
    const body = await readJson(context);
    const registered = await authService.register({
      name: String(body.name ?? ''),
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
      companyName: String(body.companyName ?? ''),
      ...(body.invitationCode === undefined ? {} : { invitationCode: String(body.invitationCode) }),
      ...(body.phone === undefined ? {} : { phone: String(body.phone) }),
      verificationCode: String(body.verificationCode ?? ''),
      ...authClientAddress(context),
      ...(body.turnstileToken === undefined ? {} : { turnstileToken: String(body.turnstileToken) }),
    });
    await sendAuthenticatedSession(context, registered, 201, { workspace: registered.workspace });
    return;
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

  const invitationManagement = path.match(/^\/api\/v1\/workspaces\/([^/]+)\/(invitations|members)(?:\/([^/]+))?(?:\/(status|transfer))?$/)
  if (path === '/api/v1/workspace-invitations/summary' && method === 'POST') {
    if (!usePostgres) throw new HttpError(503, 'POSTGRES_REQUIRED', '企业邀请需要 PostgreSQL 数据库')
    const origin = typeof context.req.headers.origin === 'string' ? context.req.headers.origin : undefined
    if ((origin || originIsStrict()) && !isAllowedRequestOrigin(context.req)) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任')
    context.res.setHeader('cache-control', 'no-store')
    context.res.setHeader('referrer-policy', 'no-referrer')
    try { sendSuccess(context, await workspaceInvitations.summary((await readJson(context)).code, authClientAddress(context).ipAddress ?? 'unknown')) }
    catch (error) { if (error instanceof InvitationError) throw new HttpError(error.status,error.code,error.message); throw error }
    return
  }
  const invitationJoin = path === '/api/v1/workspace-invitations/preview' || path === '/api/v1/workspace-invitations/accept'
  if (invitationManagement || invitationJoin) {
    const auth = requireAuth(context)
    if (!usePostgres) throw new HttpError(503, 'POSTGRES_REQUIRED', '企业邀请需要 PostgreSQL 数据库')
    if (shouldProtectCsrf(method, process.env.REQUIRE_CSRF)) {
      const origin = typeof context.req.headers.origin === 'string' ? context.req.headers.origin : undefined
      if ((origin || originIsStrict()) && !isAllowedRequestOrigin(context.req)) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任')
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
          if (id && invitationManagement[4] === 'status' && method === 'PATCH') { sendSuccess(context, await workspaceInvitations.setMemberStatus(workspaceId, auth.user.id, id, await readJson(context))); return }
          if (id && invitationManagement[4] === 'transfer' && method === 'POST') {
            const body = await readJson(context)
            await authService.authorizeOwnershipTransfer(auth, body.currentPassword, authClientAddress(context).ipAddress)
            sendSuccess(context, await workspaceInvitations.transferOwnership(workspaceId, auth.user.id, id, body)); return
          }
          if (id && !invitationManagement[4] && method === 'PATCH') { sendSuccess(context, await workspaceInvitations.updateMember(workspaceId, auth.user.id, id, await readJson(context))); return }
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

  if (path === '/api/v1/admin/platform-operators' || path.startsWith('/api/v1/admin/platform-operators/')) {
    const auth = requireAuth(context)
    requireSystemAdministrator(auth)
    if (path === '/api/v1/admin/platform-operators' && method === 'GET') {
      sendSuccess(context, await platformOperators.list(auth.user.id, context.url.searchParams)); return
    }
    const operator = path.match(/^\/api\/v1\/admin\/platform-operators\/([^/]+)$/)
    if (operator && method === 'PATCH') {
      sendSuccess(context, await platformOperators.update(auth.user.id, operator[1]!, await readJson(context), context.requestId)); return
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持的平台运营授权操作')
  }

  if (path.startsWith('/api/v1/platform/')) {
    const auth = requireAuth(context)
    if (path === '/api/v1/platform/users' && method === 'GET') { sendSuccess(context, await platformUsers.list(auth.user.id, context.url.searchParams)); return }
    const platformUserMatch = path.match(/^\/api\/v1\/platform\/users\/([^/]+)$/)
    if (platformUserMatch && method === 'GET') { sendSuccess(context, await platformUsers.detail(auth.user.id, platformUserMatch[1]!)); return }
    const platformUserStatus = path.match(/^\/api\/v1\/platform\/users\/([^/]+)\/status$/)
    if (platformUserStatus && method === 'PATCH') { sendSuccess(context, await platformUsers.updateStatus(auth.user.id, platformUserStatus[1]!, await readJson(context), context.requestId)); return }
    const platformUserOwner = path.match(/^\/api\/v1\/platform\/users\/([^/]+)\/workspaces\/([^/]+)\/owner$/)
    if (platformUserOwner && method === 'PATCH') { sendSuccess(context, await platformUsers.appointWorkspaceOwner(auth.user.id, platformUserOwner[1]!, platformUserOwner[2]!, await readJson(context), context.requestId)); return }
    const platformUserAiAccess = path.match(/^\/api\/v1\/platform\/users\/([^/]+)\/workspaces\/([^/]+)\/ai-access$/)
    if (platformUserAiAccess && method === 'PATCH') { sendSuccess(context, await platformUsers.updateWorkspaceAiAccess(auth.user.id, platformUserAiAccess[1]!, platformUserAiAccess[2]!, await readJson(context), context.requestId, auth.user.workspaceId)); return }
    const platformUserProfile = path.match(/^\/api\/v1\/platform\/users\/([^/]+)\/profile$/)
    if (platformUserProfile && method === 'PATCH') { sendSuccess(context, await platformUsers.profile(auth.user.id, platformUserProfile[1]!, await readJson(context), context.requestId)); return }
    const platformUserRevoke = path.match(/^\/api\/v1\/platform\/users\/([^/]+)\/revoke-sessions$/)
    if (platformUserRevoke && method === 'POST') { sendSuccess(context, await platformUsers.revokeSessions(auth.user.id, platformUserRevoke[1]!, await readJson(context), context.requestId)); return }
    const platformUserReset = path.match(/^\/api\/v1\/platform\/users\/([^/]+)\/reset-password$/)
    if (platformUserReset && method === 'POST') {
      context.res.setHeader('Cache-Control', 'no-store')
      sendSuccess(context, await platformUsers.resetPassword(auth.user.id, platformUserReset[1]!, await readJson(context), context.requestId))
      return
    }
    const platformUserAiQuotaReset = path.match(/^\/api\/v1\/platform\/users\/([^/]+)\/workspaces\/([^/]+)\/reset-ai-generation-quota$/)
    if (platformUserAiQuotaReset && method === 'POST') {
      requireSystemAdministrator(auth);
      throw new HttpError(410, 'AI_TRIAL_RETIRED', 'AI 三次试用限制已取消，不再提供重置次数操作')
      return
    }
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
    if (!context.auth) throw new HttpError(401, 'AUTHENTICATION_REQUIRED', '未登录，请先完成身份认证');
    if (method === 'PATCH') {
      const user = await authService.updateCurrentUserProfile(context.auth.user, await readJson(context));
      sendSuccess(context, { user });
      return;
    }
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '仅支持 GET 或 PATCH 请求');
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
    throw new HttpError(410, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求审批流程已停用，钉钉审批回调不再接收')
  }

  const protectedPaths = [
    '/api/v1/trial-usage',
    '/api/v1/departments',
    '/api/v1/recruitment-requests',
    '/api/v1/jobs',
    '/api/v1/candidates',
    '/api/v1/candidate-tags',
    '/api/v1/resumes',
    '/api/v1/resume-import-batches',
    '/api/v1/analysis-tasks',
    '/api/v1/analysis-results',
    '/api/v1/applications',
    '/api/v1/interviews',
    '/api/v1/interviewer-options',
    '/api/v1/interview-live-sessions',
    '/api/v1/interview-live-segments',
    '/api/v1/offers',
    '/api/v1/offer-templates',
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
      const origin = Array.isArray(context.req.headers.origin) ? undefined : context.req.headers.origin;
      if ((origin || originIsStrict()) && !isAllowedRequestOrigin(context.req) &&
          !isAllowedResumeUploadOrigin(origin, [], path, method, process.env.RESUME_UPLOAD_RELAX_ORIGIN)) throw new HttpError(403, 'CSRF_ORIGIN_MISMATCH', '请求来源不受信任');
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
      requirePlatformAdmin(auth); sendSuccess(context, await billingSandboxService.read(auth.user.id, auth.user.workspaceId!, Number(context.url.searchParams.get('page') ?? 1))); return;
    }
    if (path === '/api/v1/admin/billing-sandbox/orders' && method === 'POST') {
      requirePlatformAdmin(auth); assertPlatformWriteSecurity(context);
      const body = await readJson(context);
      const key = context.req.headers['idempotency-key'];
      sendSuccess(context, await billingSandboxService.create(auth.user.id, auth.user.workspaceId!, body, typeof key === 'string' ? key : '')); return;
    }
    const simulationAction = path.match(/^\/api\/v1\/admin\/billing-sandbox\/orders\/([^/]+)\/simulate$/);
    if (simulationAction && method === 'POST') {
      requirePlatformAdmin(auth); assertPlatformWriteSecurity(context);
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
      throw new HttpError(410, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求审批流程已停用，钉钉模拟审批不再提供');
    }
    const mockDecisionMatch = path.match(/^\/api\/v1\/admin\/dingtalk-mock\/instances\/([^/]+)\/(approve|reject)$/);
    if (mockDecisionMatch && method === 'POST') {
      throw new HttpError(410, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求审批流程已停用，钉钉模拟审批不再提供');
    }

    if (path === '/api/v1/departments' && method === 'GET') {
      requireRole(auth, ADMIN_ROLES);
      const activeOnly = context.url.searchParams.get('activeOnly') !== 'false'
      sendSuccess(context, await adminService.forOrganization(auth.user.workspaceId).listDepartments(activeOnly)); return;
    }
    if (path === '/api/v1/departments' && method === 'POST') {
      await requireAiAdmin();
      sendSuccess(context, await adminService.forOrganization(auth.user.workspaceId).createDepartment(await readJson(context) as never, auth.user.id, context.requestId), 201); return;
    }
    const departmentMatch = path.match(/^\/api\/v1\/departments\/([^/]+)$/);
    if (departmentMatch && method === 'PATCH') {
      await requireAiAdmin();
      sendSuccess(context, await adminService.forOrganization(auth.user.workspaceId).updateDepartment(departmentMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return;
    }
    if (departmentMatch && method === 'DELETE') {
      await requireAiAdmin();
      sendSuccess(context, await adminService.forOrganization(auth.user.workspaceId).deleteDepartment(departmentMatch[1]!, auth.user.id, context.requestId)); return;
    }

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
      if (suffix === 'approval' && method === 'GET') { throw new HttpError(410, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求审批流程已停用，审批详情不再提供'); }
      if (!suffix && method === 'PATCH') { requireRole(auth, RECRUITMENT_WRITE_ROLES); const request = await recruiting.getRequest(id); assertDepartmentScope(auth, request.departmentId); assertVersion(parseIfMatch(context), request.version); const result = await recruiting.updateRequest(id, await readJson(context) as never, auth.user.id); setVersionEtag(context, result.version); sendSuccess(context, result); return; }
      if (method === 'POST') {
        const rawRequestAction = actionFrom(`/${suffix}`, '') ?? suffix.replaceAll('-', '_');
        // Keep the public /submit-approval endpoint compatible with the service workflow action name.
        const requestAction = rawRequestAction === 'submit_approval' ? 'submit' : rawRequestAction;
        if (requestAction === 'approve' || requestAction === 'reject') throw new HttpError(409, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求已取消审批，请直接提交需求')
        const request = await recruiting.getRequest(id);
        assertDepartmentScope(auth, request.departmentId);
        requireRole(auth, RECRUITMENT_WRITE_ROLES);
        const reason = (await readJson(context)).reason;
        sendSuccess(context, await recruiting.requestAction(id, requestAction, reason, auth.user.id))
        return;
      }
    }
    if (path === '/api/v1/jobs' && method === 'GET') {
      const jobs = await recruiting.listJobs(context.url.searchParams.get('status') ?? undefined, context.url.searchParams.get('recruitmentRequestId') ?? undefined, context.url.searchParams.get('departmentId') ?? undefined);
      sendList(context, filterByDepartment(jobs, departmentScope(auth))); return;
    }
    if (path === '/api/v1/trial-usage' && method === 'GET') {
      sendSuccess(context, await trialQuotaService.read(auth.user.workspaceId!));
      return;
    }
    if (path === '/api/v1/jobs' && method === 'POST') {
      requireRole(auth, JOB_WRITE_ROLES);
      sendSuccess(context, await recruiting.createJob(await readJson(context) as never, auth.user.id), 201); return;
    }
    if (path === '/api/v1/candidates' && method === 'GET') { sendList(context, await recruiting.listCandidates(departmentScope(auth))); return; }
    if (path === '/api/v1/candidates' && method === 'POST') { requireRole(auth, CANDIDATE_WRITE_ROLES); sendSuccess(context, await recruiting.createCandidate(await readJson(context) as never, auth.user.id), 201); return; }
    if (path === '/api/v1/candidate-tags' && method === 'GET') { sendList(context, await recruiting.listCandidateTags()); return; }
    if (path === '/api/v1/resume-import-batches' && method === 'GET') {
      const resumeImports = resumeImportsFor(recruiting, auth.user.workspaceId)
      sendList(context, await runResumeImportAction(() => resumeImports.listBatches(Number(context.url.searchParams.get('pageSize') ?? '20'))))
      return
    }
    if (path === '/api/v1/resume-import-batches' && method === 'POST') {
      requireRole(auth, CANDIDATE_WRITE_ROLES)
      const resumeImports = resumeImportsFor(recruiting, auth.user.workspaceId)
      const body = await readJson(context)
      sendSuccess(context, await runResumeImportAction(() => resumeImports.createBatch(body, auth.user.id)), 201)
      return
    }
    const resumeImportItemContentMatch = path.match(/^\/api\/v1\/resume-import-batches\/([^/]+)\/items\/([^/]+)\/content$/)
    if (resumeImportItemContentMatch && method === 'POST') {
      requireRole(auth, CANDIDATE_WRITE_ROLES)
      const resumeImports = resumeImportsFor(recruiting, auth.user.workspaceId)
      const body = await readJson(context)
      sendSuccess(context, await runResumeImportAction(() => resumeImports.uploadItem(
        resumeImportItemContentMatch[1]!,
        resumeImportItemContentMatch[2]!,
        body,
        auth.user.id,
      )))
      return
    }
    const resumeImportCancelMatch = path.match(/^\/api\/v1\/resume-import-batches\/([^/]+)\/cancel$/)
    if (resumeImportCancelMatch && method === 'POST') {
      requireRole(auth, CANDIDATE_WRITE_ROLES)
      const resumeImports = resumeImportsFor(recruiting, auth.user.workspaceId)
      sendSuccess(context, await runResumeImportAction(() => resumeImports.cancelBatch(resumeImportCancelMatch[1]!)))
      return
    }
    const resumeImportDetachMatch = path.match(/^\/api\/v1\/resume-import-batches\/([^/]+)\/detach-job$/)
    if (resumeImportDetachMatch && method === 'POST') {
      requireRole(auth, JOB_WRITE_ROLES)
      const resumeImports = resumeImportsFor(recruiting, auth.user.workspaceId)
      sendSuccess(context, await runResumeImportAction(() => resumeImports.detachJob(resumeImportDetachMatch[1]!)))
      return
    }
    const resumeImportBatchMatch = path.match(/^\/api\/v1\/resume-import-batches\/([^/]+)$/)
    if (resumeImportBatchMatch && method === 'GET') {
      const resumeImports = resumeImportsFor(recruiting, auth.user.workspaceId)
      sendSuccess(context, await runResumeImportAction(() => resumeImports.getBatch(resumeImportBatchMatch[1]!)))
      return
    }
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
    if (path === '/api/v1/dashboard/summary' && method === 'GET') {
      const period = Object.fromEntries(['from', 'to', 'timeZone'].flatMap(key => {
        const value = context.url.searchParams.get(key);
        return value === null ? [] : [[key, value]];
      }));
      sendSuccess(context, await recruiting.getDashboardSummary(departmentScope(auth), ids => questionSheets.listDashboardReviews(ids), period)); return;
    }
    if (path === '/api/v1/reports' && method === 'GET') { if (!(await reportsEnabledForRequest())) throw reportsDisabledError(); sendSuccess(context, await recruiting.getReports(departmentScope(auth), Object.fromEntries(['from', 'to', 'jobId', 'channel', 'status'].map((key) => [key, context.url.searchParams.get(key) || undefined])))); return; }
    if (path === '/api/v1/reports/funnel' && method === 'GET') { if (!(await reportsEnabledForRequest())) throw reportsDisabledError(); const filters = Object.fromEntries(['from', 'to', 'jobId', 'channel', 'status'].map((key) => [key, context.url.searchParams.get(key) || undefined])); sendSuccess(context, (await recruiting.getReports(departmentScope(auth), filters)).funnel); return; }
    if (path === '/api/v1/reports/channels' && method === 'GET') { if (!(await reportsEnabledForRequest())) throw reportsDisabledError(); const filters = Object.fromEntries(['from', 'to', 'jobId', 'channel', 'status'].map((key) => [key, context.url.searchParams.get(key) || undefined])); sendSuccess(context, (await recruiting.getReports(departmentScope(auth), filters)).channels); return; }
    if (path === '/api/v1/reports/cycle-time' && method === 'GET') { if (!(await reportsEnabledForRequest())) throw reportsDisabledError(); const filters = Object.fromEntries(['from', 'to', 'jobId', 'channel', 'status'].map((key) => [key, context.url.searchParams.get(key) || undefined])); sendSuccess(context, (await recruiting.getReports(departmentScope(auth), filters)).recruitmentCycle); return; }

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

    if (path === '/api/v1/admin/users' && method === 'GET') { requireSystemAdministrator(auth); sendList(context, await adminService.listUsers()); return; }
    if (path === '/api/v1/admin/account-organizations' && method === 'GET') { requireSystemAdministrator(auth); sendList(context, await adminService.listAccountOrganizations()); return; }
    if (path === '/api/v1/admin/users' && method === 'POST') {
      requireSystemAdministrator(auth);
      context.res.setHeader('Cache-Control', 'no-store');
      sendSuccess(context, await adminService.createUser(await readJson(context) as never, auth.user.id, context.requestId), 201);
      return;
    }
    if (path === '/api/v1/admin/departments' && method === 'GET') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.listDepartments()); return; }
    if (path === '/api/v1/admin/departments' && method === 'POST') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.createDepartment(await readJson(context) as never, auth.user.id, context.requestId), 201); return; }
    const adminDepartmentMatch = path.match(/^\/api\/v1\/admin\/departments\/([^/]+)$/);
    if (adminDepartmentMatch && method === 'PATCH') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.updateDepartment(adminDepartmentMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (adminDepartmentMatch && method === 'DELETE') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.deleteDepartment(adminDepartmentMatch[1]!, auth.user.id, context.requestId)); return; }
    const adminUserMatch = path.match(/^\/api\/v1\/admin\/users\/([^/]+)$/);
    if (adminUserMatch && method === 'PATCH') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.updateUser(adminUserMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/roles' && method === 'GET') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.listRoles()); return; }
    const adminRoleMatch = path.match(/^\/api\/v1\/admin\/roles\/([^/]+)$/);
    if (adminRoleMatch && method === 'PATCH') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.updateRole(adminRoleMatch[1]!, await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/settings' && method === 'GET') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.getSettings()); return; }
    if (path === '/api/v1/admin/settings' && method === 'PATCH') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.updateSettings(await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/dingtalk-settings' && method === 'GET') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.getDingTalkSettings()); return; }
    if (path === '/api/v1/admin/dingtalk-settings' && method === 'PATCH') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.updateDingTalkSettings(await readJson(context) as never, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/recruitment-approval-settings' && method === 'GET') {
      throw new HttpError(410, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求审批流程已停用，审批设置不再提供');
    }
    if (path === '/api/v1/admin/recruitment-approval-settings' && method === 'PATCH') {
      throw new HttpError(410, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求审批流程已停用，审批设置不再提供');
    }
    if (path === '/api/v1/admin/dingtalk-approval-config' && method === 'GET') { throw new HttpError(410, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求审批流程已停用，钉钉招聘审批配置不再提供'); }
    if (path === '/api/v1/admin/dingtalk-approval-config' && method === 'PATCH') {
      throw new HttpError(410, 'RECRUITMENT_APPROVAL_DISABLED', '招聘需求审批流程已停用，钉钉招聘审批配置不再提供');
    }
    if (path === '/api/v1/admin/dingtalk-connection-test' && method === 'POST') {
      requireSystemAdministrator(auth);
      const body = await readJson(context);
      sendSuccess(context, await adminService.testDingTalkConnection({
        ...(typeof body.appKey === 'string' ? { appKey: body.appKey } : {}),
        ...(typeof body.appSecret === 'string' ? { appSecret: body.appSecret } : {}),
      }));
      return;
    }
    if (path === '/api/v1/admin/email-deliveries' && method === 'GET') {
      requireSystemAdministrator(auth)
      context.res.setHeader('cache-control', 'no-store')
      sendList(context, emailDeliveries ? await emailDeliveries.listUnresolved() : [])
      return
    }
    if (path === '/api/v1/admin/operational-recovery' && method === 'GET') {
      requireSystemAdministrator(auth)
      context.res.setHeader('cache-control','no-store')
      sendSuccess(context,await operationalRecovery.list())
      return
    }
    const recoveryResolution=path.match(/^\/api\/v1\/admin\/operational-recovery\/(cleanup|audio)\/([0-9a-f-]{36})\/resolve$/i)
    if (recoveryResolution && method==='POST') {
      requireSystemAdministrator(auth)
      const body=await readJson(context)
      if (typeof body.action!=='string' || typeof body.note!=='string') throw new HttpError(400,'VALIDATION_ERROR','请填写核对操作及依据')
      sendSuccess(context,await operationalRecovery.resolve(recoveryResolution[1]!,recoveryResolution[2]!,body.action,body.note,auth.user.id,typeof body.version==='string' ? body.version : ''))
      return
    }
    const deliveryResolution = path.match(new RegExp('^/api/v1/admin/email-deliveries/([0-9a-f-]{36})/resolve$', 'i'))
    if (deliveryResolution && method === 'POST') {
      requireSystemAdministrator(auth)
      const body = await readJson(context)
      if (!emailDeliveries) throw new HttpError(503, 'POSTGRES_REQUIRED', '邮件核对需要数据库')
      if (!['completed', 'not_sent'].includes(String(body.status)) || typeof body.note !== 'string' || body.note.trim().length < 5 || body.note.length > 2000)
        throw new HttpError(400, 'VALIDATION_ERROR', '请填写核对结果及至少五个字符的核对说明')
      const offerId = await emailDeliveries.resolve(deliveryResolution[1]!, body.status as 'completed' | 'not_sent', auth.user.id, body.note.trim())
      offerEmailDeliveryUncertain.delete(offerId)
      sendSuccess(context, { resolved: true })
      return
    }
    if (path === '/api/v1/admin/smtp-settings' && method === 'GET') { requireSystemAdministrator(auth); context.res.setHeader('cache-control', 'no-store'); sendSuccess(context, await readSmtpEnvSettings()); return; }
    if (path === '/api/v1/admin/smtp-settings' && method === 'PATCH') {
      requireSystemAdministrator(auth)
      try { sendSuccess(context, await updateSmtpEnvSettings(undefined, await readJson(context) as never)) }
      catch (error) { throw new HttpError(400, 'VALIDATION_ERROR', error instanceof Error ? error.message : 'SMTP 配置保存失败') }
      return
    }
    if (path === '/api/v1/admin/smtp-connection-test' && method === 'POST') {
      requireSystemAdministrator(auth)
      const result = await testSmtpConnection(await readJson(context) as never)
      sendSuccess(context, result, result.ok ? 200 : 400)
      return
    }
    if (path === '/api/v1/admin/smtp-test-email' && method === 'POST') {
      requireSystemAdministrator(auth)
      const body = await readJson(context)
      if (Object.keys(body).some((key) => key !== 'to') || typeof body.to !== 'string') throw new HttpError(400, 'VALIDATION_ERROR', '请提供收件人邮箱')
      try {
        await sendSmtpMail({
          to: body.to,
          subject: '智能招聘平台 SMTP 测试邮件',
          markdown: '# SMTP 配置验证\n\n这是一封由智能招聘平台发送的测试邮件。若您能收到此邮件，说明 SMTP 配置已可用于发送 Offer 邮件。',
        })
        sendSuccess(context, { ok: true, message: '测试邮件已提交给 SMTP 服务，请检查收件箱' })
      } catch (error) {
        throw new HttpError(400, 'SMTP_TEST_EMAIL_FAILED', error instanceof Error ? `发送测试邮件失败：${error.message}` : '发送测试邮件失败')
      }
      return
    }
    if (path === '/api/v1/admin/resume-virus-scan' && method === 'GET') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.getResumeVirusScanSetting()); return; }
    if (path === '/api/v1/admin/resume-virus-scan' && method === 'PATCH') { requireSystemAdministrator(auth); const body = await readJson(context); if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', 'enabled 必须是布尔值'); sendSuccess(context, await adminService.updateResumeVirusScanSetting(body.enabled, auth.user.id, context.requestId)); return; }
    if (path === '/api/v1/admin/enterprise-ai-source' && method === 'PATCH') {
      await requireAiAdmin();
      context.res.setHeader('cache-control', 'private, no-store');
      sendSuccess(context, await enterpriseAi.selectSource(auth.user.workspaceId, await readJson(context), auth.user.id, context.requestId)); return;
    }
    if (path === '/api/v1/admin/enterprise-ai-settings' && (method === 'GET' || method === 'PATCH')) {
      await requireAiAdmin();
      context.res.setHeader('cache-control', 'private, no-store');
      sendSuccess(context, method === 'GET'
        ? await enterpriseAi.getSelfService(auth.user.workspaceId)
        : await enterpriseAi.saveSelfService(auth.user.workspaceId, await readJson(context), auth.user.id, context.requestId));
      return;
    }
    if (path === '/api/v1/admin/enterprise-ai-connection-test' && method === 'POST') {
      await requireAiAdmin();
      const body = await readJson(context);
      validateSelfServiceAiPatch(body);
      const env = body.OPENAI_API_KEY?.trim()
        ? {} : await enterpriseAi.selfServiceConnectionEnv(auth.user.workspaceId);
      context.res.setHeader('cache-control', 'private, no-store');
      sendSuccess(context, await testAiConnection({ baseUrl: SELF_SERVICE_AI_BASE_URL,
        ...(body.OPENAI_API_KEY !== undefined ? { apiKey: body.OPENAI_API_KEY } : {}),
      }, env));
      return;
    }
    if (path === '/api/v1/admin/ai-settings' && method === 'GET') { requireSystemAdministrator(auth); context.res.setHeader('cache-control', 'no-store'); sendSuccess(context, await adminService.getAiSettings()); return; }
    if (path === '/api/v1/admin/ai-settings' && method === 'PATCH') {
      requireSystemAdministrator(auth);
      try {
        sendSuccess(context, await adminService.updateAiSettings(await readJson(context), auth.user.id, context.requestId));
      } catch (error) {
        if (error instanceof AiSettingsValidationError) throw new HttpError(400, 'VALIDATION_ERROR', error.message);
        throw error;
      }
      return;
    }
    if (path === '/api/v1/admin/ai-sharing' && method === 'GET') {
      requireSystemAdministrator(auth);
      context.res.setHeader('cache-control', 'no-store');
      sendSuccess(context, await adminService.getAiSharingSettings());
      return;
    }
    if (path === '/api/v1/admin/ai-sharing' && method === 'PATCH') {
      requireSystemAdministrator(auth);
      const body = await readJson(context);
      if (typeof body.enabled !== 'boolean' || Object.keys(body).some((key) => key !== 'enabled')) {
        throw new HttpError(400, 'VALIDATION_ERROR', 'enabled 必须是布尔值');
      }
      sendSuccess(context, await adminService.updateAiSharingSettings(body.enabled, auth.user.id, context.requestId));
      return;
    }
    if (path === '/api/v1/admin/ai-connection-test' && method === 'POST') {
      requireSystemAdministrator(auth);
      const body = await readJson(context);
      if (Object.keys(body).some(key => !['baseUrl', 'apiKey', 'timeoutMs'].includes(key))) throw new HttpError(400, 'VALIDATION_ERROR', '不支持的连接测试参数');
      const patch: Record<string, unknown> = {};
      if (body.baseUrl !== undefined) patch.OPENAI_BASE_URL = body.baseUrl;
      if (body.apiKey !== undefined) patch.OPENAI_API_KEY = body.apiKey;
      if (body.timeoutMs !== undefined) patch.OPENAI_TIMEOUT_MS = String(body.timeoutMs);
      validateEnterpriseAiPatch(patch);
      sendSuccess(context, await testAiConnection({
        ...(typeof body.baseUrl === 'string' ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
        ...(body.timeoutMs !== undefined ? { timeoutMs: Number(body.timeoutMs) } : {}),
      }, process.env, (url, init) => fetch(url, { ...init, redirect: 'error' }))); return;
    }
    if (path === '/api/v1/admin/channel-settings' && method === 'GET') { requireSystemAdministrator(auth); sendSuccess(context, await adminService.getChannelSettings()); return; }
    if (path === '/api/v1/admin/channel-settings' && method === 'PATCH') {
      requireSystemAdministrator(auth);
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
      requireSystemAdministrator(auth);
      const provider = channelConnectionTestMatch[1] as ChannelProvider;
      sendSuccess(context, await adminService.testChannelConnection(provider));
      return;
    }
    if (path === '/api/v1/admin/analysis-tasks' && method === 'GET') { requireRole(auth, ADMIN_ROLES); sendList(context, await recruiting.listAnalysisTasks(context.url.searchParams.get('status') ?? undefined)); return; }
    if (path === '/api/v1/admin/audit-logs' && method === 'GET') { requireSystemAdministrator(auth); sendList(context, await adminService.listAuditLogs(Number(context.url.searchParams.get('limit') ?? '50'))); return; }
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
    if (applicationDeleteMatch && method === 'DELETE') { requireRole(auth, APPLICATION_WRITE_ROLES); await recruiting.assertApplicationInScope(applicationDeleteMatch[1]!, departmentScope(auth)); const result = await recruiting.deleteApplication(applicationDeleteMatch[1]!, auth.user.id); sendSuccess(context, { deleted: true, ...result }); return; }
    if (path === '/api/v1/onboarding' && method === 'GET') { sendList(context, await recruiting.listOnboarding(departmentScope(auth))); return; }
    if (path === '/api/v1/onboarding/workbench' && method === 'GET') { sendList(context, await recruiting.listOnboardingWorkbench(departmentScope(auth))); return; }
    if (path === '/api/v1/onboarding/reports' && method === 'GET') { sendSuccess(context, await recruiting.listOnboardingReport(departmentScope(auth))); return; }
    const onboardingMatch = path.match(/^\/api\/v1\/onboarding\/([^/]+)(?:\/(.*))?$/);
    if (onboardingMatch) {
      const onboardingId = onboardingMatch[1]!; const suffix = onboardingMatch[2] ?? '';
      if (!suffix && method === 'GET') { await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.getOnboarding(onboardingId)); return; }
      if (!suffix && method === 'PATCH') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.updateOnboarding(onboardingId, await readJson(context) as never, auth.user.id)); return; }
      if (suffix === 'tasks' && method === 'GET') { await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendList(context, await recruiting.listOnboardingTasks(onboardingId)); return; }
      if (suffix === 'tasks' && method === 'POST') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.createOnboardingTask(onboardingId, await readJson(context) as never, auth.user.id), 201); return; }
      const onboardingTaskMatch = suffix.match(/^tasks\/([^/]+)$/);
      if (onboardingTaskMatch && method === 'PATCH') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.updateOnboardingTask(onboardingId, onboardingTaskMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
      if (suffix === 'materials' && method === 'GET') { await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendList(context, await recruiting.listOnboardingMaterials(onboardingId)); return; }
      if (suffix === 'materials' && method === 'POST') { requireRole(auth, ONBOARDING_MATERIAL_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.createOnboardingMaterial(onboardingId, await readJson(context) as never, auth.user.id), 201); return; }
      const onboardingMaterialMatch = suffix.match(/^materials\/([^/]+)$/);
      if (onboardingMaterialMatch && method === 'PATCH') { requireRole(auth, ONBOARDING_MATERIAL_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.updateOnboardingMaterial(onboardingId, onboardingMaterialMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
      if (suffix === 'reminders' && method === 'GET') { await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendList(context, await recruiting.listOnboardingReminders(onboardingId)); return; }
      if (suffix === 'reminders/refresh' && method === 'POST') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.refreshOnboardingReminders(onboardingId, auth.user.id)); return; }
      if (suffix === 'integrations' && method === 'GET') { await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendList(context, await recruiting.listOnboardingIntegrations(onboardingId)); return; }
      const onboardingIntegrationMatch = suffix.match(/^integrations\/([^/]+)$/);
      if (onboardingIntegrationMatch && method === 'PATCH') { requireRole(auth, ONBOARDING_WRITE_ROLES); await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth)); sendSuccess(context, await recruiting.updateOnboardingIntegration(onboardingId, onboardingIntegrationMatch[1]!, await readJson(context) as never, auth.user.id)); return; }
      if (method === 'POST') {
        requireRole(auth, ONBOARDING_WRITE_ROLES);
        await recruiting.assertOnboardingInScope(onboardingId, departmentScope(auth));
        const body = await readJson(context);
        const reason = body && typeof body === 'object' && 'reason' in body ? (body as Record<string, unknown>).reason ?? body : body;
        sendSuccess(context, await recruiting.onboardingAction(onboardingId, suffix.replaceAll('-', '_'), reason, auth.user.id));
        return;
      }
    }
    if (path === '/api/v1/offer-templates' && method === 'GET') { requireRole(auth, OFFER_WRITE_ROLES); sendList(context, await recruiting.listOfferTemplates()); return; }
    if (path === '/api/v1/offer-templates' && method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); sendSuccess(context, await recruiting.createOfferTemplate(await readJson(context) as never, auth.user.id), 201); return; }
    const offerTemplateMatch = path.match(/^\/api\/v1\/offer-templates\/([^/]+)$/)
    if (offerTemplateMatch && method === 'PATCH') { requireRole(auth, OFFER_WRITE_ROLES); sendSuccess(context, await recruiting.updateOfferTemplate(offerTemplateMatch[1]!, await readJson(context) as never)); return; }
    if (offerTemplateMatch && method === 'DELETE') { requireRole(auth, OFFER_WRITE_ROLES); await recruiting.deleteOfferTemplate(offerTemplateMatch[1]!); sendSuccess(context, { deleted: true }); return; }
    if (path === '/api/v1/offers' && method === 'GET') { sendList(context, (await recruiting.listOffers(context.url.searchParams.get('status') ?? undefined, departmentScope(auth))).map(withoutOfferApproval)); return; }
    if (path === '/api/v1/offers/eligible-applications' && method === 'GET') { requireRole(auth, OFFER_WRITE_ROLES); sendList(context, await recruiting.listApplications(undefined, undefined, departmentScope(auth), true)); return; }
    if (path === '/api/v1/offers' && method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); sendSuccess(context, withoutOfferApproval(await recruiting.createOffer(await readJson(context) as never, auth.user.id)), 201); return; }
    const offerEmailMatch = path.match(/^\/api\/v1\/offers\/([^/]+)\/(send-email|email-preview)$/)
    if (offerEmailMatch && method === 'POST') {
      requireRole(auth, OFFER_WRITE_ROLES)
      const requestedId = offerEmailMatch[1]!
      if (offerEmailInFlight.has(requestedId)) throw new HttpError(409, 'OFFER_EMAIL_SENDING', '该 Offer 邮件正在发送，请勿重复提交')
      if (offerEmailDeliveryUncertain.has(requestedId)) throw new HttpError(409, 'OFFER_EMAIL_STATUS_UNKNOWN', '该 Offer 的邮件投递结果待核实，请勿直接重试')
      offerEmailInFlight.add(requestedId)
      let canonicalId: string | undefined
      let canonicalLockHeld = false
      try {
        const current = await recruiting.getOffer(requestedId)
        canonicalId = current.id
        if (canonicalId !== requestedId) {
          if (offerEmailInFlight.has(canonicalId)) throw new HttpError(409, 'OFFER_EMAIL_SENDING', '该 Offer 邮件正在发送，请勿重复提交')
          if (offerEmailDeliveryUncertain.has(canonicalId)) throw new HttpError(409, 'OFFER_EMAIL_STATUS_UNKNOWN', '该 Offer 的邮件投递结果待核实，请勿直接重试')
          offerEmailInFlight.add(canonicalId)
          canonicalLockHeld = true
        }
        await recruiting.assertApplicationInScope(current.applicationId, departmentScope(auth))
        if (!OFFER_EMAIL_SENDABLE_STATUSES.has(current.status)) throw new HttpError(409, 'OFFER_EMAIL_NOT_READY', 'Offer 已结束，不能继续发送邮件；如需重新沟通，请创建新修订或新 Offer')
        if (current.status === 'cancelled') {
          const hasReplacement = (await recruiting.listOffers(undefined, departmentScope(auth)))
            .some((offer) => offer.applicationId === current.applicationId && offer.id !== current.id && offer.status !== 'cancelled')
          if (hasReplacement) throw new HttpError(409, 'OFFER_REPLACEMENT_EXISTS', '该申请已有新的有效 Offer，请先处理新 Offer，不能再发送已取消的旧 Offer')
        }
        const body = await readJson(context)
        if (body.versionId !== undefined && body.versionId !== current.currentVersionId) throw new HttpError(409, 'OFFER_VERSION_CONFLICT', 'Offer 已有新版本，请刷新并重新预览')
        const offerContext = await recruiting.getOfferEmailContext(current.id)
        let expiresAt: string | undefined
        if (body.expiresAt !== undefined) {
          if (typeof body.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(body.expiresAt) || !Number.isFinite(Date.parse(body.expiresAt)) || Date.parse(body.expiresAt) <= Date.now()) throw new HttpError(400, 'OFFER_EXPIRY_INVALID', '有效期必须是晚于当前时间的完整日期时间')
          expiresAt = new Date(body.expiresAt).toISOString()
        }
        const materialLabels: Record<string, string> = {
          graduation_certificate: '毕业证书、学位证书',
          id_card: '身份证',
          previous_employment_release: '上家公司劳动合同解除证明或者离职证明',
          previous_employment_payroll: '上家单位一年工资流水',
          photo: '一寸照片一张',
          medical_report: '体检报告',
          bank_card: '工资卡',
        }
        const materialItems = offerContext.materials.map((item) => {
          const [code, ...details] = item.split(':')
          const bankName = details.join(':').trim()
          if (code === 'other' && bankName) return bankName
          return code === 'bank_card' && bankName ? `${bankName}工资卡` : materialLabels[code ?? ''] ?? item
        })
        const onboardingMaterials = materialItems.map((item, index) => `${index + 1}. ${item}；`).join('\n')
        const bankCard = offerContext.materials.find((item) => item.startsWith('bank_card:'))
        const bankName = bankCard ? bankCard.slice('bank_card:'.length).trim() : ''
        const values: Record<string, string> = {
          ...offerTemplateFieldValues(offerContext.templateFields),
          candidateName: offerContext.candidateName, '候选人姓名': offerContext.candidateName, '称谓': '您好', candidateEmail: offerContext.candidateEmail,
          positionTitle: offerContext.positionTitle, jobTitle: offerContext.positionTitle, '岗位名称': offerContext.positionTitle, offerCode: offerContext.offerCode,
          department: offerContext.department,
          startDate: offerContext.startDate ?? '', '报到日期': offerTemplateFieldValues(offerContext.templateFields)['报到日期'] || offerContext.startDate || '', reportDate: offerTemplateFieldValues(offerContext.templateFields)['报到日期'] || offerContext.startDate || '',
          reportingLocation: offerContext.reportingLocation ?? '', '报到地点': offerContext.reportingLocation ?? '',
          '报到地址': offerContext.reportingLocation ?? '', '报到地点/房间号': offerContext.reportingLocation ?? '',
          invoiceTitle: offerContext.invoiceTitle ?? '', '发票抬头': offerContext.invoiceTitle ?? '',
          taxNumber: offerContext.taxNumber ?? '', '企业税号': offerContext.taxNumber ?? '',
          employmentType: offerContext.employmentType === 'full_time' ? '全职' : '实习',
          probationSalary: offerContext.probationSalary?.toLocaleString('zh-CN') ?? '', '试用期月薪': offerContext.probationSalary?.toLocaleString('zh-CN') ?? '', '试用期工资': offerContext.probationSalary?.toLocaleString('zh-CN') ?? '',
          formalSalary: offerContext.baseSalary.toLocaleString('zh-CN'), baseSalary: offerContext.baseSalary.toLocaleString('zh-CN'),
          '转正后月薪': offerContext.baseSalary.toLocaleString('zh-CN'), '转正后工资': offerContext.baseSalary.toLocaleString('zh-CN'),
          bonus: offerContext.bonus?.toLocaleString('zh-CN') ?? '', benefits: offerContext.benefits.join('、'), '其他福利或约定': offerContext.benefits.join('、'),
          materials: onboardingMaterials, onboardingMaterials, '入职材料': onboardingMaterials,
          otherOnboardingMaterials: materialItems.join('、'), '其他入职材料': materialItems.join('、'),
          bankName, '工资卡银行名称': bankName,
          photoQuantity: offerContext.materials.includes('photo') ? '1' : '', '照片数量': offerContext.materials.includes('photo') ? '1' : '',
          companyName: process.env.COMPANY_NAME?.trim() ?? '',
        }
        const normalizeReportingLocationTemplate = (value: string) => value.replace(/杭州市余杭区(?:城投未来之星|未来科技城)\s*C2\s*幢\s*(?:21\s*楼\s*)?2105\s*室/gu, '{{报到地点}}')
        const resolveVariable = (rawKey: string) => {
          const key = rawKey.trim()
          if (!Object.hasOwn(values, key) || !values[key]?.trim()) throw new HttpError(400, 'OFFER_TEMPLATE_UNRESOLVED', `请先补全 Offer 信息或邮件正文中的模板变量：${key}`)
          return values[key] ?? ''
        }
        const interpolate = (value: string) => normalizeReportingLocationTemplate(value).replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (_, rawKey: string) => resolveVariable(rawKey))
        const escapeHtmlValue = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
        const interpolateHtml = (value: string) => normalizeReportingLocationTemplate(value).replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (_, rawKey: string) => escapeHtmlValue(resolveVariable(rawKey)).replace(/\r?\n/gu, '<br>'))
        const recipient = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : offerContext.candidateEmail
        if (!recipient) throw new HttpError(409, 'CANDIDATE_EMAIL_REQUIRED', '候选人尚未填写邮箱，请填写收件人邮箱后发送')
        const attachment = decodePdfAttachment(body.attachment)
        const html = typeof body.html === 'string' ? interpolateHtml(body.html) : ''
        const markdown = !html && typeof body.markdown === 'string' ? interpolate(body.markdown) : ''
        const subject = interpolate(typeof body.subject === 'string' ? body.subject : '')
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)) throw new HttpError(400, 'EMAIL_RECIPIENT_INVALID', '收件人邮箱格式无效')
        if (!subject.trim() || subject.length > 200 || /\r|\n/u.test(subject)) throw new HttpError(400, 'EMAIL_SUBJECT_INVALID', '邮件主题不能为空、不能包含换行符，且不能超过 200 个字符')
        if (!(html || markdown).trim()) throw new HttpError(400, 'EMAIL_BODY_REQUIRED', '邮件正文不能为空')
        if ((html || markdown).length > 50_000) throw new HttpError(400, 'EMAIL_BODY_TOO_LONG', '邮件正文不能超过 50000 个字符')
        if (offerEmailMatch[2] === 'email-preview') {
          sendSuccess(context, { to: recipient, subject, html: html ? renderRichEmailHtml(html) : renderMarkdownEmail(markdown), versionId: current.currentVersionId })
          return
        }
        const sendAction = current.status === 'cancelled' ? 'resend_cancelled' : ['sent', 'accepted'].includes(current.status) ? 'resend' : 'send'
        const deliveryMetadata = { recipient, subject, html: html ? renderRichEmailHtml(html) : renderMarkdownEmail(markdown), attachmentName: attachment?.filename ?? null }
        const delivery = emailDeliveries ? await emailDeliveries.begin(auth.user.workspaceId!, current.id, current.currentVersionId!, current.version, { action: sendAction, ...(expiresAt ? { expiresAt } : {}), metadata: deliveryMetadata }) : undefined
        try {
        await sendSmtpMail({
          to: recipient,
          subject,
          ...(delivery ? { messageId: delivery.messageId } : {}),
          ...(html ? { html } : { markdown }),
          ...(attachment ? { attachment } : {}),
        })
        if (delivery) await emailDeliveries!.setStatus(delivery.id, 'accepted')
        } catch {
          if (delivery) await emailDeliveries!.setStatus(delivery.id, 'unknown').catch(() => undefined)
          offerEmailDeliveryUncertain.add(current.id)
          throw new HttpError(502, 'OFFER_EMAIL_STATUS_UNKNOWN', '无法确认邮件服务器是否受理，请先核对投递记录，不要直接重试')
        }
        try {
          const sentOffer = await recruiting.offerAction(current.id, sendAction, undefined, auth.user.id, expiresAt, current.currentVersionId, deliveryMetadata)
          offerEmailDeliveryUncertain.delete(current.id)
          sendSuccess(context, withoutOfferApproval(sentOffer))
        } catch {
          if (delivery) await emailDeliveries!.setStatus(delivery.id, 'unknown').catch(() => undefined)
          offerEmailDeliveryUncertain.add(current.id)
          throw new HttpError(502, 'OFFER_EMAIL_STATUS_UNKNOWN', '邮件服务器已受理邮件，但 Offer 状态未能更新。请先核实邮件投递结果，不要直接重试。')
        }
      } catch (error) {
        if (error instanceof HttpError) throw error
        if (error instanceof RecruitingWorkflowError) throw new HttpError(error.status, error.code, error.message)
        throw new HttpError(502, 'OFFER_EMAIL_SEND_FAILED', error instanceof Error ? error.message : 'Offer 邮件发送失败')
      } finally {
        offerEmailInFlight.delete(requestedId)
        if (canonicalLockHeld && canonicalId) offerEmailInFlight.delete(canonicalId)
      }
      return
    }
    const offerMatch = path.match(/^\/api\/v1\/offers\/([^/]+)(?:\/(.*))?$/);
    if (offerMatch && method === 'POST' && offerMatch[2]?.replaceAll('-', '_') === 'resend_cancelled') {
      throw new HttpError(409, 'OFFER_EMAIL_REQUIRED', '请通过邮件编辑窗口重新发送 Offer，邮件服务器接收成功后才会更新状态')
    }
    if (offerMatch) { const id=offerMatch[1]!; const suffix=offerMatch[2] ?? ''; await recruiting.assertOfferInScope(id, departmentScope(auth)); if (!suffix && method === 'GET') { const result = await recruiting.getOffer(id); setVersionEtag(context, result.version); sendSuccess(context, withoutOfferApproval(result)); return; } if (!suffix && method === 'PATCH') { requireRole(auth, OFFER_WRITE_ROLES); const current = await recruiting.getOffer(id); if (offerEmailInFlight.has(current.id)) throw new HttpError(409, 'OFFER_EMAIL_SENDING', '邮件正在发送，请稍后再修订'); assertVersion(parseIfMatch(context), current.version); const result = await recruiting.updateOffer(id, await readJson(context) as never, auth.user.id, current.version); setVersionEtag(context, result.version); sendSuccess(context, withoutOfferApproval(result)); return; } if (method === 'POST') { requireRole(auth, OFFER_WRITE_ROLES); const body=await readJson(context); const action=suffix.replaceAll('-', '_'); if (action === 'send' || action === 'resend') throw new HttpError(409, 'OFFER_EMAIL_REQUIRED', '请通过邮件编辑窗口发送 Offer，系统会在 SMTP 成功接收后更新状态'); if (['submit_approval', 'approve', 'reject'].includes(action)) throw new HttpError(409, 'OFFER_APPROVAL_DISABLED', 'Offer 无需审批，请直接发送邮件'); sendSuccess(context, withoutOfferApproval(await recruiting.offerAction(id, action, body.reason, auth.user.id, undefined, typeof body.versionId === 'string' ? body.versionId : undefined))); return; } }
    if (path === '/api/v1/interviews' && method === 'GET') {
      const rows = await recruiting.listInterviews(context.url.searchParams.get('applicationId') ?? undefined, departmentScope(auth));
      const preparation = await questionPreparations.repository.list(rows.map(row => row.id));
      sendList(context, rows.map(row => ({ ...row, questionPreparation: preparation.get(row.id) }))); return;
    }
    if (path === '/api/v1/interviewer-options' && method === 'GET') { requireRole(auth, INTERVIEW_WRITE_ROLES); sendSuccess(context, await adminService.listInterviewerOptions(auth.user.workspaceId)); return; }
    if (path === '/api/v1/interviews' && method === 'POST') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      await recruiting.assertApplicationInScope(String((await readJson(context)).applicationId ?? ''), departmentScope(auth));
      const created = await recruiting.createInterview(await readJson(context) as never, auth.user.id);
      // PostgreSQL enqueues in the same transaction as the invitation. Test/local mode uses memory.
      if (!usePostgres) await questionPreparations.repository.enqueue(created.id, auth.user.id);
      sendSuccess(context, created, 201); return;
    }
    const preparationMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/question-preparation$/);
    if (preparationMatch && (method === 'GET' || method === 'POST')) {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      await recruiting.assertInterviewInScope(preparationMatch[1]!, departmentScope(auth));
      const result = method === 'POST'
        ? await questionPreparations.request(preparationMatch[1]!, auth.user.id, true)
        : await questionPreparations.status(preparationMatch[1]!, context.url.searchParams.get('materials') === '1');
      sendSuccess(context, result, method === 'POST' && ['queued', 'generating'].includes(result.status) ? 202 : 200); return;
    }
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
      const job = persistentFullAudio
        ? method === 'POST'
          ? await persistentFullAudio.enqueue({ organizationId: auth.user.workspaceId!, interviewId, sessionId, key, source: source as FullAudioSource, fingerprint })
          : await persistentFullAudio.get(auth.user.workspaceId!, key)
        : method === 'POST'
          ? await fullAudioTranscription.start(key, signal => fullInterviewAudio.loadStream(sessionId, manifest, source as FullAudioSource, signal), billedRecordingChunks(await tenantAiEnv(), sessionId, source + ":" + fingerprint))
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
      const controller = new AbortController()
      const abort = () => controller.abort()
      context.res.once('close', abort)
      if (context.res.destroyed) abort()
      try {
        const manifest = await interviewAudioRecordings.manifest(interviewId, sessionId);
        const audio = await fullInterviewAudio.loadStream(sessionId, manifest, source as FullAudioSource, controller.signal);
        await sendInterviewAudioStream(context.res, audio, 'audio/mp4', context.req.headers.range, controller.signal);
      } catch (error) {
        if (error instanceof FullAudioError) throw new HttpError(error.status, 'FULL_AUDIO_UNAVAILABLE', error.message);
        throw error;
      } finally { context.res.off('close', abort) }
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
    if (liveSessionCreateMatch && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(liveSessionCreateMatch[1]!, departmentScope(auth)); sendSuccess(context, await liveInterviewSessions.create(liveSessionCreateMatch[1]!, auth.user.id), 201); return; }
    const liveSessionPath = parseLiveSessionPath(path);
    if (liveSessionPath && method === 'GET' && liveSessionPath.action === 'transcription') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      const current = await liveInterviewSessions.get(liveSessionPath.sessionId);
      await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth));
      // Read progress first, so a completed queue cannot accompany an older transcript snapshot.
      const progress = await liveAudioTranscriptions.progress(liveSessionPath.sessionId);
      const latest = await liveInterviewSessions.get(liveSessionPath.sessionId);
      sendSuccess(context, { ...progress, ...latest });
      return;
    }
    if (liveSessionPath && method === 'GET' && !liveSessionPath.action) { requireRole(auth, INTERVIEW_WRITE_ROLES); const result=await liveInterviewSessions.get(liveSessionPath.sessionId); await recruiting.assertInterviewInScope(result.session.interviewId, departmentScope(auth)); sendSuccess(context,result); return; }
    if (liveSessionPath && method === 'POST' && liveSessionPath.action === 'end') {
      requireRole(auth, INTERVIEW_WRITE_ROLES)
      const current = await liveInterviewSessions.get(liveSessionPath.sessionId)
      await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth))
      const session = await liveInterviewSessions.end(liveSessionPath.sessionId)
      liveInterviewVoices.forget(liveSessionPath.sessionId)
      let summaryGeneration: { queued: boolean; reason?: string } = { queued: false }
      try {
        if (session.status === 'completed') {
        await interviewSummaries.request(current.session.interviewId, auth.user.id)
        summaryGeneration = { queued: true }
        }
      } catch (error) {
        summaryGeneration = { queued: false, reason: error instanceof Error ? `面试已保存，但总结任务创建失败：${error.message}` : '总结任务创建失败，可在面试详情重试。' }
      }
      sendSuccess(context, { ...session, summaryGeneration })
      return
    }
    if (liveSessionPath && method === 'POST' && liveSessionPath.action === 'roles') {
      requireRole(auth, INTERVIEW_WRITE_ROLES)
      const current = await liveInterviewSessions.get(liveSessionPath.sessionId)
      await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth))
      const body = await readJson(context)
      if (typeof body.versionId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.versionId)
        || !Array.isArray(body.turnIds) || !body.turnIds.length || body.turnIds.length > 1000
        || body.turnIds.some(id => typeof id !== 'string' || id.length > 200)
        || (body.role !== 'candidate' && body.role !== 'interviewer')) throw new HttpError(400, 'INVALID_INPUT', '转写版本、片段或说话角色无效')
      sendSuccess(context, await liveInterviewSessions.correctTranscriptRoles(liveSessionPath.sessionId, body.versionId, body.turnIds as string[], body.role, auth.user.id))
      return
    }
    if (liveSessionPath && method === 'POST' && liveSessionPath.action === 'question') { requireRole(auth, INTERVIEW_WRITE_ROLES); const current=await liveInterviewSessions.get(liveSessionPath.sessionId); await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth)); const body=await readJson(context); const question=String(body.question ?? '').trim(); if(!question||question.length>2000) throw new HttpError(400,'INVALID_INPUT','问题不能为空且不能超过 2000 个字符'); const source=body.source==='ai_adopted'?'ai_adopted':'manual'; const segmentId=typeof body.segmentId==='string'?body.segmentId:null; sendSuccess(context,await liveInterviewSessions.setCurrentQuestion(liveSessionPath.sessionId,question,source,auth.user.id,segmentId)); return; }
    if (liveSessionPath && method === 'POST' && liveSessionPath.action === 'segments') {
      requireRole(auth, INTERVIEW_WRITE_ROLES); const current=await liveInterviewSessions.get(liveSessionPath.sessionId); await recruiting.assertInterviewInScope(current.session.interviewId, departmentScope(auth)); const body=await readJson(context);
      if (['completed', 'failed'].includes(current.session.status)) throw new HttpError(409, 'LIVE_SESSION_CLOSED', '录音会话已结束，不能追加发言或录音');
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
        if (body.backgroundTranscription === true && (chunkEndMs === undefined || chunkEndMs <= chunkOffsetMs)) throw new HttpError(400, 'INVALID_INPUT', '后台转写必须提供录音时间范围');
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
        await interviewAudioRecordings.save(recording, body.backgroundTranscription === true ? { ...(checkpoint ? { checkpoint } : {}) } : undefined);
        if (body.backgroundTranscription === true) {
          sendSuccess(context, [], 202);
          return;
        }
        let recognized: SpeakerSegment[];
        try { recognized = await transcribeInterviewChunk(audio, contentType); }
        catch (error) {
          if ((!(error instanceof FunAsrError) && !(error instanceof FasterWhisperError))
            || !checkpoint?.complete || !checkpoint.text.trim()) throw error;
          recognized = [];
        }
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
          if ((!item.roleReview && item.confidence === 1) || (item.speakerConfirmed && /(^|:)voice_/.test(item.speakerId))) known[item.speakerId] = item.role;
          else if (/(^|:)voice_/.test(item.speakerId) && item.confidence >= 0.6 && !item.roleReview) inferred[item.speakerId] = item.role;
        }
        const mapped = await reviewLiveRoles(liveSessionPath.sessionId, mapAudioSourceRoles(transcribed, source, known, inferred), latest.segments);
        const saved = [];
        for (const item of mapped) saved.push(await liveInterviewSessions.addSegment(liveSessionPath.sessionId, { speakerId: stableRoleSpeakerId(item), role: item.role, confidence: item.confidence, text: item.text, startMs: item.startMs, endMs: item.endMs, audioObjectKey, ...(item.roleReview ? { roleReview: item.roleReview } : {}), ...(item.transcriptComparison ? { transcriptComparison: item.transcriptComparison } : {}), ...(item.audioSource ? { audioSource: item.audioSource } : {}) }));
        if (latest.session.status === 'completed') liveInterviewVoices.forget(liveSessionPath.sessionId);
        sendSuccess(context, saved, 201);
      } catch (error) {
        if (error instanceof FunAsrError) throw new HttpError(error.code === 'NOT_CONFIGURED' ? 503 : 502, `FUNASR_${error.code}`, error.message);
        if (error instanceof FasterWhisperError) throw new HttpError(error.code === 'NOT_CONFIGURED' ? 503 : 502, `FASTER_WHISPER_${error.code}`, error.message);
        throw error;
      }
      return;
    }
    const liveSegmentMatch = path.match(/^\/api\/v1\/interview-live-segments\/([^/]+)\/(role|analyze|refinement)$/);
    if (liveSegmentMatch && method === 'POST') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      const body = await readJson(context);
      const segmentId = liveSegmentMatch[1]!;
      const analysisContext = await liveInterviewSessions.getAnalysisContext(segmentId);
      await recruiting.assertInterviewInScope(analysisContext.interviewId, departmentScope(auth));
      if (liveSegmentMatch[2] === 'refinement') {
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 50000
          || typeof body.expectedText !== 'string' || !body.expectedText.trim() || body.expectedText.length > 50000
          || !Array.isArray(body.sourceSegments) || !body.sourceSegments.length || body.sourceSegments.length > 100
          || body.sourceSegments.some(source => !source || typeof source !== 'object' || Array.isArray(source)
            || !['id', 'text', 'role', 'speakerId'].every(key => typeof (source as Record<string, unknown>)[key] === 'string'))
          || new Set(body.sourceSegments.map(source => source.id)).size !== body.sourceSegments.length
          || !body.sourceSegments.some(source => source.id === segmentId)) {
          throw new HttpError(400, 'INVALID_INPUT', '请输入有效的整理文本（最多 50000 字符），并提供完整的原始分段。');
        }
        sendSuccess(context, await liveInterviewSessions.updateRefinement(segmentId, { text: body.text, expectedText: body.expectedText, sourceSegments: body.sourceSegments }, auth.user.id));
        return;
      }
      const ids = Array.isArray(body.segmentIds) ? body.segmentIds.map(String) : [segmentId];
      if (liveSegmentMatch[2] === 'role') {
        const role = String(body.role);
        if (role !== 'interviewer' && role !== 'candidate') throw new HttpError(400, 'INVALID_INPUT', 'role 必须是 interviewer 或 candidate');
        sendSuccess(context, await liveInterviewSessions.correctUtteranceRole(segmentId, ids, role));
        return;
      }
      if (!['candidate', 'interviewer'].includes(analysisContext.segment.role) || analysisContext.segment.confidence < 0.6) throw new HttpError(409, 'CANDIDATE_ROLE_UNCONFIRMED', '请先确认发言属于候选人还是面试官，再进行 AI 分析');
      try {
        if (analysisContext.segment.role === 'candidate') await liveInterviewSessions.getUtteranceText(segmentId, ids);
        const saved = await liveInterviewSessions.get(analysisContext.segment.sessionId);
        const selectedIds = selectUtteranceSegments(saved.segments, segmentId, ids).map(segment => segment.id);
        let model = '';
        const result = await analyzeActualAnswer(saved.segments, selectedIds, {
          jobTitle: analysisContext.jobTitle,
          jobRequirements: analysisContext.jobRequirements.length ? analysisContext.jobRequirements : ['岗位要求未结构化'],
        }, async input => {
          const resumeContext = input.speechRole === 'interviewer' ? [] : await recruiting.getInterviewQuestionContext(analysisContext.interviewId).then(ctx => [ctx.anonymizedResume, ...ctx.analysisSummary]).catch(() => []);
          const billingEnv = await tenantAiEnv();
          const config = loadInterviewAnswerAnalyzerConfig(billingEnv);
          model = config.model;
          const analysisInput = { ...input, resumeContext };
          return meterAiOperation(billingEnv, 'answer_analysis', usageKey(context.req.headers['idempotency-key'], context.requestId), {segmentId, analysisInput}, () => createInterviewAnswerAnalyzer(config, createBillingFetch(billingEnv)).analyze(analysisInput));
        });
        await liveInterviewSessions.saveAnalysis(segmentId, result.question, result.analysis, model);
        sendSuccess(context, result.analysis);
      } catch (error) {
        if ((error as { code?: string }).code === 'INVALID_UTTERANCE_SEGMENTS') throw new HttpError(409, 'ANALYSIS_SEGMENTS_INVALID', '发言分段不连续、重叠或说话人待确认，请核实后再分析。');
        if (error instanceof InterviewAnswerAnalysisError) throw new HttpError(error.code.startsWith('ANALYSIS_') ? 409 : error.code === 'AI_NOT_CONFIGURED' ? 503 : error.code === 'INVALID_INPUT' ? 400 : 502, error.code, error.message);
        throw error;
      }
      return;
    }
    const resumeQuestionsMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/questions$/);
    if (resumeQuestionsMatch && method === 'GET') { await recruiting.assertInterviewInScope(resumeQuestionsMatch[1]!, departmentScope(auth)); const saved = await interviewQuestionSets.get(resumeQuestionsMatch[1]!); sendSuccess(context, saved ? { questions: saved.questions.map(question => ({ ...question, sourceEngine: question.sourceEngine ?? saved.engine })), engine: saved.engine, updatedAt: saved.updatedAt, advisoryOnly: true, applicationStatusMutation: 'none' } : null); return; }
    const correctConclusionMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)\/correct-conclusion$/);
    if (correctConclusionMatch && method === 'POST') {
      requireRole(auth, INTERVIEW_WRITE_ROLES);
      await recruiting.assertInterviewInScope(correctConclusionMatch[1]!, departmentScope(auth));
      const body = await readJson(context);
      if (typeof body.outcome !== 'string' || !['continue', 'offer', 'reject', 'cancelled'].includes(body.outcome)) {
        throw new HttpError(400, 'INVALID_INPUT', '请选择有效的面试结论');
      }
      if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 1000) {
        throw new HttpError(400, 'INVALID_INPUT', '请填写不超过 1000 个字符的更正原因');
      }
      sendSuccess(context, await recruiting.correctInterviewConclusion(correctConclusionMatch[1]!, body.outcome as 'continue' | 'offer' | 'reject' | 'cancelled', body.reason, auth.user.id));
      return;
    }
    const interviewMatch = path.match(/^\/api\/v1\/interviews\/([^/]+)(?:\/(feedback|lock-feedback|conclude|complete|questions))?$/);
    if (interviewMatch && method === 'GET' && !interviewMatch[2]) { await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); sendSuccess(context, await recruiting.getInterview(interviewMatch[1]!)); return; }
    if (interviewMatch && method === 'PATCH' && !interviewMatch[2]) { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); sendSuccess(context, await recruiting.updateInterviewSchedule(interviewMatch[1]!, await readJson(context), auth.user.id)); return; }
    if (interviewMatch && method === 'DELETE' && !interviewMatch[2]) { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); await recruiting.deleteInterview(interviewMatch[1]!, auth.user.id); sendSuccess(context, { deleted: true }); return; }
    if (interviewMatch && method === 'POST') { requireRole(auth, INTERVIEW_WRITE_ROLES); await recruiting.assertInterviewInScope(interviewMatch[1]!, departmentScope(auth)); const body = await readJson(context); if (interviewMatch[2] === 'feedback') sendSuccess(context, await recruiting.submitFeedback(interviewMatch[1]!, body as never, auth.user.id)); else if (interviewMatch[2] === 'lock-feedback') sendSuccess(context, await recruiting.lockFeedback(interviewMatch[1]!, String(body.interviewerId ?? ''), auth.user.id)); else if (interviewMatch[2] === 'complete') sendSuccess(context, await recruiting.completeInterview(interviewMatch[1]!, String(body.outcome) as never, auth.user.id)); else if (interviewMatch[2] === 'conclude') sendSuccess(context, await recruiting.concludeInterview(interviewMatch[1]!, String(body.outcome) as never, auth.user.id)); else if (interviewMatch[2] === 'questions') {
      if (body.refinement !== undefined) {
        const rawRefinement = body.refinement;
        if (!rawRefinement || typeof rawRefinement !== 'object' || Array.isArray(rawRefinement)) throw new HttpError(400, 'INVALID_INPUT', 'refinement 格式无效');
        const refinementBody = rawRefinement as Record<string, unknown>;
        const groups: InterviewQuestionGroup[] = ['ai', 'hr', 'department', 'boss'];
        if (typeof refinementBody.group !== 'string' || !groups.includes(refinementBody.group as InterviewQuestionGroup)) throw new HttpError(400, 'INVALID_INPUT', '请选择有效的题库分组');
        const group = refinementBody.group as InterviewQuestionGroup;
        const messages = refinementBody.messages;
        if (!Array.isArray(messages) || messages.some(message => !message || typeof message !== 'object' || Array.isArray(message) || !['user', 'assistant'].includes(String((message as Record<string, unknown>).role)) || typeof (message as Record<string, unknown>).content !== 'string')) {
          throw new HttpError(400, 'INVALID_INPUT', '对话内容格式无效');
        }
        const interview = await recruiting.getInterview(interviewMatch[1]!);
        const latestLiveSession = await liveInterviewSessions.findLatest(interviewMatch[1]!);
        if (interview.status === 'completed' || interview.status === 'cancelled' || latestLiveSession?.session.status === 'completed') {
          throw new HttpError(409, 'INTERVIEW_CLOSED', '面试已结束或取消，只能查看已保存题库，不能继续生成。');
        }
        const saved = await interviewQuestionSets.get(interviewMatch[1]!);
        const input = await recruiting.getInterviewQuestionContext(interviewMatch[1]!);
        const isAvailableGroup = group === 'ai' || group === 'hr' || group === 'department' || (group === 'boss' && input.stage === 'final');
        if (!isAvailableGroup) throw new HttpError(400, 'INVALID_INPUT', '该面试阶段没有此题库分组');
        const currentGroup = questionsForInterviewGroup(saved?.questions ?? [], group);
        if (refinementBody.target !== undefined) {
          throw new HttpError(400, 'QUESTION_EDIT_UNSUPPORTED', '对话仅生成新题，不修改原题库。请使用“重新生成当前表”更新整表。');
        }
        // The bank is optional context; discussion never waits for or writes preparation results.
        const generationInput = { ...input, questionCount: currentGroup.length || input.questionCount, includeCommonQuestions: true };
        const controller = new AbortController();
        const disconnect = () => { if (!context.res.writableEnded) controller.abort(); };
        context.res.once('close', disconnect);
        try {
          let refined;
          try {
            const billingEnv = await tenantAiEnv();
            const generator = createInterviewQuestionGenerator(loadInterviewQuestionGeneratorConfig(billingEnv), createBillingFetch(billingEnv));
            refined = await meterAiOperation(billingEnv, 'interview_questions', usageKey(context.req.headers['idempotency-key'], context.requestId), {mode:'discussion', interviewId:interviewMatch[1], generationInput, group, currentGroup, messages}, () => generator.discuss(generationInput, group, currentGroup, messages as InterviewQuestionConversationMessage[], controller.signal));
          } catch (error) {
            if (controller.signal.aborted) return;
            if (!(error instanceof InterviewQuestionGenerationError)) throw error;
            console.warn('interview-question-refinement-failed', { code: error.code, group });
            if (error.code === 'INVALID_INPUT') throw new HttpError(400, error.code, error.message);
            const reason = error.code === 'AI_NOT_CONFIGURED' ? '当前企业未完整配置模型地址、密钥和模型名称。' : error.message;
            throw new HttpError(error.code === 'AI_NOT_CONFIGURED' ? 503 : 502, error.code, reason + ' 原题库保持不变。');
          }
          if (controller.signal.aborted || context.res.destroyed) return;
          sendSuccess(context, { questions: saved?.questions ?? [], engine: saved?.engine ?? 'llm', advisoryOnly: true, applicationStatusMutation: 'none', mode: 'discussion', bankUpdated: false, assistantMessage: refined.assistantMessage, ...(saved ? { updatedAt: saved.updatedAt } : {}) });
        } finally { context.res.off('close', disconnect); }
        return;
      }
      const input = await recruiting.getInterviewQuestionContext(interviewMatch[1]!);
      const requestedCount = body.questionCount === undefined ? input.questionCount : Number(body.questionCount);
      if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > 20) throw new HttpError(400, 'INVALID_INPUT', 'questionCount 必须是 1 到 20 的整数');
      if (body.includeCommonQuestions !== undefined && typeof body.includeCommonQuestions !== 'boolean') throw new HttpError(400, 'INVALID_INPUT', 'includeCommonQuestions 必须是布尔值');
      const requestedGroup = body.group as InterviewQuestionGroup | undefined;
      if (requestedGroup !== undefined && (!['ai', 'hr', 'department', 'boss'].includes(requestedGroup) || (requestedGroup === 'boss' && input.stage !== 'final'))) throw new HttpError(400, 'INVALID_INPUT', '当前面试轮次不包含所选面试表');
      const generationInput = { ...input, questionCount: requestedCount, includeCommonQuestions: requestedGroup !== undefined || body.includeCommonQuestions === true };
      if (context.res.destroyed) return;
      const controller = new AbortController();
      const disconnect = () => { if (!context.res.writableEnded) controller.abort(); };
      context.res.once('close', disconnect);
      const generationStartedAt = Date.now();
      try {
        let questionSet: { questions: GeneratedInterviewQuestion[]; engine: 'llm' | 'local_fallback'; advisoryOnly: true; applicationStatusMutation: 'none'; generationWarning?: string };
        const previous = await interviewQuestionSets.get(interviewMatch[1]!);
        try {
          const billingEnv = await tenantAiEnv();
          const generator = createInterviewQuestionGenerator(loadInterviewQuestionGeneratorConfig(billingEnv), createBillingFetch(billingEnv));
          const generated = await meterAiOperation(billingEnv, 'interview_questions', usageKey(context.req.headers['idempotency-key'], context.requestId), {mode:'generate', interviewId:interviewMatch[1], generationInput, requestedGroup}, () => requestedGroup ? generator.generateGroup(generationInput, requestedGroup, controller.signal) : generator.generate(generationInput, controller.signal));
          questionSet = { ...generated, engine: 'llm' };
        } catch (error) {
          if (controller.signal.aborted) return;
          if (!(error instanceof InterviewQuestionGenerationError)) throw error;
          if (error.code === 'INVALID_INPUT') throw new HttpError(400, error.code, error.message);
          const reason = error.code === 'AI_NOT_CONFIGURED' ? '当前企业未完整配置模型地址、密钥和模型名称。'
            : error.message;
          console.warn('interview-question-generation-failed', { code: error.code, group: requestedGroup ?? 'all', elapsedMs: Date.now() - generationStartedAt });
          if (requestedGroup || previous?.engine === 'llm' || previous?.questions.some(question => question.sourceEngine === 'llm')) throw new HttpError(error.code === 'AI_NOT_CONFIGURED' ? 503 : 502, error.code, reason + ' 已保留原题库，请重试。');
          questionSet = { ...generateLocalInterviewQuestions(generationInput), engine: 'local_fallback', generationWarning: reason };
        }
        if (controller.signal.aborted || context.res.destroyed) return;
        questionSet.questions = questionSet.questions.map(question => ({ ...question, sourceEngine: questionSet.engine }));
        if (requestedGroup) {
          const baseQuestions = previous?.questions.length ? previous.questions.map(question => ({ ...question, sourceEngine: question.sourceEngine ?? previous.engine })) : generateLocalInterviewQuestions(generationInput).questions.map(question => ({ ...question, sourceEngine: 'local_fallback' as const }));
          questionSet.questions = questionsForInterviewGroup(baseQuestions, requestedGroup).length
            ? replaceInterviewQuestionGroup(baseQuestions, requestedGroup, questionSet.questions)
            : [...baseQuestions, ...questionSet.questions];
          questionSet.engine = questionSet.questions.every(question => question.sourceEngine === 'llm') ? 'llm' : 'local_fallback';
        }
        const saved = await interviewQuestionSets.save({ interviewId: interviewMatch[1]!, generatedBy: auth.user.id, engine: questionSet.engine, questions: questionSet.questions });
        console.info('interview-question-generation-completed', { group: requestedGroup ?? 'all', elapsedMs: Date.now() - generationStartedAt, questionCount: requestedGroup ? questionsForInterviewGroup(questionSet.questions, requestedGroup).length : questionSet.questions.length });
        sendSuccess(context, { ...questionSet, updatedAt: saved.updatedAt });
      } finally { context.res.off('close', disconnect); }
    } return; }
    const applicationResumeMatch = path.match(/^\/api\/v1\/applications\/([^/]+)\/resume$/);
    if (applicationResumeMatch && method === 'GET') {
      await recruiting.assertApplicationInScope(applicationResumeMatch[1]!, departmentScope(auth));
      context.res.setHeader('cache-control', 'private, no-store');
      sendSuccess(context, await recruiting.getApplicationResume(applicationResumeMatch[1]!));
      return;
    }
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
      if (suffix === 'related-records' && method === 'GET') { requireRole(auth, JOB_WRITE_ROLES); sendList(context, await recruiting.listJobRelatedRecords(id)); return; }
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
          const billingEnv = await tenantAiEnv();
          const config = loadJobSpecGeneratorConfig(billingEnv);
          const operationKey = usageKey(context.req.headers['idempotency-key'], context.requestId);
          const generateAndSave = async () => {
            const generated = await createJobSpecGenerator(config, createBillingFetch(billingEnv)).generate(generationInput);
            return recruiting.createSpec(id, generated, auth.user.id);
          };
          const measured = () => meterAiOperation(billingEnv,'job_spec',operationKey,generationInput,generateAndSave);
          const generated = usePostgres ? await aiUsageService.execute({ organizationId: auth.user.workspaceId!, actorId: auth.user.id,
            operation: 'job_spec', resourceId: id, key: operationKey, input: generationInput, model: config.model, requestId: context.requestId }, measured) : await measured();
          sendSuccess(context, generated);
        } catch (error) {
          if (error instanceof JobSpecGenerationError) {
            // Some OpenAI-compatible providers return HTTP 200 with truncated or
            // schema-incompatible content. Keep generation usable without ever
            // persisting unvalidated model output.
            if (error.code === 'AI_NOT_CONFIGURED' || error.code === 'MODEL_RESPONSE_INVALID') {
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
          const billingEnv = await tenantAiEnv();
          const config = loadJobDescriptionGeneratorConfig(billingEnv);
          const operationKey = usageKey(context.req.headers['idempotency-key'], context.requestId);
          const generateAndSave = async () => {
            const generated = await createJobDescriptionGenerator(config, createBillingFetch(billingEnv)).generate(generationInput);
            return recruiting.createJd(id, generated, auth.user.id);
          };
          const measured = () => meterAiOperation(billingEnv,'jd',operationKey,generationInput,generateAndSave);
          const generated = usePostgres ? await aiUsageService.execute({ organizationId: auth.user.workspaceId!, actorId: auth.user.id,
            operation: 'jd', resourceId: id, key: operationKey, input: generationInput, model: config.model, requestId: context.requestId }, measured) : await measured();
          sendSuccess(context, generated);
        } catch (error) {
          if (error instanceof JobDescriptionGenerationError) {
            // A malformed model response is not safe to persist, but it should
            // not make the user lose the existing deterministic JD fallback.
            if (error.code === 'AI_NOT_CONFIGURED' || error.code === 'MODEL_RESPONSE_INVALID') {
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
    if (error instanceof AdminConflictError) throw new HttpError(409, 'CONFLICT', error.message);
    if (error instanceof RepositoryNotFoundError) throw new HttpError(404, 'NOT_FOUND', error.message);
    errorFromRecruiting(error);
  }

  await next();
};

return { middleware: routeMiddleware, close: async () => {
  const work = await Promise.allSettled([fullAudioTranscription.close(), fullInterviewAudio.close(), persistentFullAudio?.close(),
    questionPreparations.close(), questionSheets.close(), interviewSummaries.close()]);
  const resources = await Promise.allSettled([rawInterviewStorage.close?.(), recruitingService.close()]);
  const errors = [...work, ...resources].filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, '接口资源回收失败');
} };
}

export const notFoundMiddleware: Middleware = async (context) => {
  throw new HttpError(404, 'NOT_FOUND', `未找到接口：${context.req.method} ${context.url.pathname}`);
};


