import { createHash, randomBytes } from 'node:crypto'
import { LocalAuthSessionStore } from './session-store.js'
import type {
  AccountSessionIdentity,
  AuthContext,
  AuthenticatedRegisterResult,
  LoginInput,
  LoginResult,
  MfaChallenge,
  ProfileContact,
  ProfileUpdateInput,
  RegisterInput,
  Role,
  SessionUser,
  WorkspaceCreateInput,
  WorkspaceSummary,
} from './types.js'
import { PostgresSessionRepository } from './session-repository.js'
import { createDatabasePool } from '../db/connection.js'
import { loadDatabaseConfig } from '../db/config.js'
import type { Pool } from 'pg'
import { EmailVerificationService } from './verification-service.js'
import { hashPassword, verifyPassword } from './password.js'
import { normalizeRegistrationInput } from './registration.js'
import { assertVerificationSecret, hashVerificationCode, normalizeVerificationCode, normalizeVerificationEmail, safeHashEqual } from './verification-code.js'
import { buildTotpUri, consumeRecoveryCode, createRecoveryCodes, decryptMfaSecret, encryptMfaSecret, generateTotpSecret, verifyTotp } from './totp.js'
import { loadTurnstileConfig, verifyTurnstile } from './turnstile.js'

import { isSystemAdministrator, requireSystemAdministrator } from './system-administrator.js'

export type AuthSessionStore = Pick<
  LocalAuthSessionStore,
  | 'findUserByEmailPassword'
  | 'findUserById'
  | 'updateUserProfile'
  | 'findUserForPasswordAuthentication'
  | 'hasUserByEmail'
  | 'isLoginEmailTaken'
  | 'getAccountPasswordHash'
  | 'changeAccountCredentials'
  | 'verifyAccountPasswordCode'
  | 'createEmailVerificationChallenge'
  | 'invalidateVerificationChallenge'
  | 'markVerificationChallengeDelivered'
  | 'registerUserWithVerification'
  | 'resetPasswordWithVerification'
  | 'startLoginAttempt'
  | 'finishLoginAttempt'
  | 'getMfaCredential'
  | 'createMfaChallenge'
  | 'findMfaChallengeByTokenHash'
  | 'recordMfaChallengeFailure'
  | 'completeMfaChallenge'
  | 'invalidateMfaChallenge'
  | 'revokeAllSessions'
  | 'createSession'
  | 'findSessionByToken'
  | 'deleteSession'
  | 'listWorkspaces'
  | 'createWorkspace'
  | 'archiveWorkspace'
  | 'resetWorkspace'
  | 'selectWorkspace'
>

export interface AuthServiceOptions {
  env?: NodeJS.ProcessEnv
  verificationService?: EmailVerificationService
  turnstileFetcher?: typeof fetch
}
export function createAuthSessionStore(env: NodeJS.ProcessEnv = process.env, sharedPool?: Pool): AuthSessionStore {
  const hasDatabase = Boolean(env.DATABASE_URL?.trim() || env.PGPASSWORD?.trim())
  if (env.NODE_ENV === 'production' && !hasDatabase) {
    throw new Error('Production authentication requires database configuration')
  }
  if (hasDatabase) {
    const pool = sharedPool ?? createDatabasePool(loadDatabaseConfig(env))
    return new PostgresSessionRepository(pool)
  }
  return new LocalAuthSessionStore()
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const authError = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status })
const issueChallengeToken = () => randomBytes(32).toString('base64url')

export class AuthService {
  private readonly sessionStore: AuthSessionStore
  private readonly env: NodeJS.ProcessEnv
  private readonly verificationService: EmailVerificationService
  private readonly turnstileFetcher: typeof fetch

  constructor(sessionStore: AuthSessionStore = createAuthSessionStore(), options: AuthServiceOptions = {}) {
    this.sessionStore = sessionStore
    this.env = options.env ?? process.env
    this.verificationService = options.verificationService ?? new EmailVerificationService(this.sessionStore, undefined, this.env)
    this.turnstileFetcher = options.turnstileFetcher ?? fetch
  }

  private async assertHuman(input: { token?: string; ipAddress?: string; expectedAction: string }): Promise<void> {
    await verifyTurnstile({
      token: input.token ?? '',
      ...(input.ipAddress ? { remoteIp: input.ipAddress } : {}),
      expectedAction: input.expectedAction,
      config: loadTurnstileConfig(this.env),
      fetcher: this.turnstileFetcher,
    })
  }

  async requestRegistrationCode(input: { email: string; ipAddress?: string; turnstileToken?: string }): Promise<{ accepted: true; retryAfterSeconds: number }> {
    await this.assertHuman({ ...(input.turnstileToken ? { token: input.turnstileToken } : {}), ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}), expectedAction: 'register-code' })
    return this.verificationService.requestCode({ purpose: 'registration', email: input.email, ...(input.ipAddress ? { requestIp: input.ipAddress } : {}) })
  }

  async requestPasswordReset(input: { email: string; ipAddress?: string; turnstileToken?: string }): Promise<{ accepted: true; retryAfterSeconds: number }> {
    await this.assertHuman({ ...(input.turnstileToken ? { token: input.turnstileToken } : {}), ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}), expectedAction: 'password-reset' })
    return this.verificationService.requestCode({ purpose: 'password_reset', email: input.email, ...(input.ipAddress ? { requestIp: input.ipAddress } : {}) })
  }

  private async proveAccountSession(auth: AuthContext | undefined): Promise<AccountSessionIdentity & { expectedPasswordHash: string }> {
    if (auth?.method !== 'session') throw authError('请登录账号后再进行安全设置', 'AUTHENTICATION_REQUIRED', 401)
    const identity = { userId: auth.user.id, sessionId: auth.sessionId, email: auth.user.email.trim().toLowerCase() }
    const passwordHash = await this.sessionStore.getAccountPasswordHash(identity)
    if (!passwordHash) throw authError('登录状态已变化或账号未设置密码，请重新登录后再试', 'ACCOUNT_SESSION_CHANGED', 409)
    return { ...identity, expectedPasswordHash: passwordHash }
  }

  private async proveCurrentPassword(auth: AuthContext | undefined, password: unknown, ipAddress?: string): Promise<AccountSessionIdentity & { expectedPasswordHash: string }> {
    const identity = await this.proveAccountSession(auth)
    if (typeof password !== 'string' || !password || password.length > 1024) {
      throw authError('请输入有效的当前密码', 'VALIDATION_ERROR', 400)
    }
    const passwordHash = identity.expectedPasswordHash
    const attempt = await this.sessionStore.startLoginAttempt({ email: `account-security:${identity.userId}`, ...(ipAddress ? { ipAddress } : {}) })
    if (!attempt.allowed) throw authError('当前密码校验过于频繁，请稍后再试', 'ACCOUNT_PASSWORD_RATE_LIMITED', 429)
    const valid = passwordHash.startsWith('scrypt$')
      ? await verifyPassword(password, passwordHash)
      : safeHashEqual(sha256(password), passwordHash) && this.env.NODE_ENV !== 'production'
    await this.sessionStore.finishLoginAttempt(attempt.id, valid, valid ? undefined : 'invalid_current_password')
    if (!valid) throw authError('当前密码不正确', 'INVALID_CURRENT_PASSWORD', 400)
    return { ...identity, expectedPasswordHash: passwordHash }
  }

  private newLoginEmail(value: unknown, currentEmail: string): string {
    const email = normalizeVerificationEmail(value)
    if (email === currentEmail) throw authError('新邮箱不能与当前登录邮箱相同', 'VALIDATION_ERROR', 400)
    // Email-based MFA exceptions are reserved by deployment configuration.
    if (this.isMfaExempt(email)) throw authError('该邮箱不能用于换绑，请使用其他邮箱', 'EMAIL_NOT_AVAILABLE', 409)
    return email
  }

  async requestEmailChangeCode(auth: AuthContext | undefined, input: { newEmail: unknown; currentPassword?: unknown; ipAddress?: string }): Promise<{ accepted: true; retryAfterSeconds: number }> {
    const proof = input.currentPassword === undefined ? await this.proveAccountSession(auth) : await this.proveCurrentPassword(auth, input.currentPassword, input.ipAddress)
    const email = this.newLoginEmail(input.newEmail, proof.email)
    if (await this.sessionStore.isLoginEmailTaken(email)) throw authError('新邮箱已被其他账号使用', 'EMAIL_ALREADY_EXISTS', 409)
    return this.verificationService.requestCode({ purpose: 'email_change', userId: proof.userId, email, ...(input.ipAddress ? { requestIp: input.ipAddress } : {}) })
  }

  async confirmEmailChange(auth: AuthContext | undefined, input: { newEmail: unknown; currentPassword?: unknown; verificationCode: unknown; ipAddress?: string }): Promise<{ ok: true }> {
    const proof = input.currentPassword === undefined ? await this.proveAccountSession(auth) : await this.proveCurrentPassword(auth, input.currentPassword, input.ipAddress)
    const newEmail = this.newLoginEmail(input.newEmail, proof.email)
    const code = normalizeVerificationCode(input.verificationCode)
    assertVerificationSecret(this.env)
    await this.sessionStore.changeAccountCredentials({ ...proof, newEmail, codeHash: hashVerificationCode('email_change', newEmail, code, this.env.AUTH_OTP_HMAC_SECRET, proof.userId) })
    return { ok: true }
  }

  async requestAccountPasswordCode(auth: AuthContext | undefined, input: { ipAddress?: string } = {}): Promise<{ accepted: true; retryAfterSeconds: number }> {
    const proof = await this.proveAccountSession(auth)
    return this.verificationService.requestCode({ purpose: 'password_reset', email: proof.email, requireDelivery: true, ...(input.ipAddress ? { requestIp: input.ipAddress } : {}) })
  }

  async verifyAccountPasswordCode(auth: AuthContext | undefined, input: { verificationCode: unknown }): Promise<{ ok: true }> {
    const proof = await this.proveAccountSession(auth)
    assertVerificationSecret(this.env)
    await this.sessionStore.verifyAccountPasswordCode({ ...proof, codeHash: hashVerificationCode('password_reset', proof.email, normalizeVerificationCode(input.verificationCode), this.env.AUTH_OTP_HMAC_SECRET) })
    return { ok: true }
  }

  async changePassword(auth: AuthContext | undefined, input: { currentPassword?: unknown; verificationCode?: unknown; newPassword: unknown; ipAddress?: string }): Promise<{ ok: true }> {
    const emailVerification = input.currentPassword === undefined
    const proof = emailVerification ? await this.proveAccountSession(auth) : await this.proveCurrentPassword(auth, input.currentPassword, input.ipAddress)
    if (typeof input.newPassword !== 'string' || input.newPassword.length < 8 || input.newPassword.length > 128) {
      throw authError('新密码需为 8 至 128 个字符', 'VALIDATION_ERROR', 400)
    }
    if (await verifyPassword(input.newPassword, proof.expectedPasswordHash) || input.newPassword === input.currentPassword) throw authError('新密码不能与当前密码相同', 'VALIDATION_ERROR', 400)
    let passwordCodeHash: string | undefined
    if (emailVerification) {
      assertVerificationSecret(this.env)
      passwordCodeHash = hashVerificationCode('password_reset', proof.email, normalizeVerificationCode(input.verificationCode), this.env.AUTH_OTP_HMAC_SECRET)
    }
    await this.sessionStore.changeAccountCredentials({ ...proof, newPasswordHash: await hashPassword(input.newPassword), ...(passwordCodeHash ? { passwordCodeHash } : {}) })
    return { ok: true }
  }

  async register(input: RegisterInput): Promise<AuthenticatedRegisterResult> {
    await this.assertHuman({ ...(input.turnstileToken ? { token: input.turnstileToken } : {}), ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}), expectedAction: 'register-confirm' })
    const data = normalizeRegistrationInput(input)
    const code = normalizeVerificationCode(input.verificationCode)
    assertVerificationSecret(this.env)
    const codeHash = hashVerificationCode('registration', data.email, code, this.env.AUTH_OTP_HMAC_SECRET)
    const registered = await this.sessionStore.registerUserWithVerification(input, { codeHash })
    const session = await this.sessionStore.createSession(registered.user, undefined, input.ipAddress ? { ipAddress: input.ipAddress } : {})
    return { ...registered, ...session }
  }

  async confirmPasswordReset(input: {
    email: string
    verificationCode: string
    password: string
    ipAddress?: string
    turnstileToken?: string
  }): Promise<{ ok: true }> {
    await this.assertHuman({
      ...(input.turnstileToken ? { token: input.turnstileToken } : {}),
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
      expectedAction: 'password-reset-confirm',
    })
    const email = normalizeVerificationEmail(input.email)
    const password = String(input.password ?? '')
    if (password.length < 8) throw authError('密码至少需要 8 个字符', 'VALIDATION_ERROR', 400)
    const code = normalizeVerificationCode(input.verificationCode)
    assertVerificationSecret(this.env)
    await this.sessionStore.resetPasswordWithVerification({
      email,
      codeHash: hashVerificationCode('password_reset', email, code, this.env.AUTH_OTP_HMAC_SECRET),
      passwordHash: await hashPassword(password),
    })
    return { ok: true }
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const email = normalizeVerificationEmail(input.email)
    const password = String(input.password ?? '')
    if (!password) throw authError('邮箱和密码不能为空', 'VALIDATION_ERROR', 400)
    const attempt = await this.sessionStore.startLoginAttempt({ email, ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}), windowMs: 15 * 60_000, emailLimit: 5, ipLimit: 30 })
    if (!attempt.allowed) throw authError('登录尝试过于频繁，请稍后再试', 'LOGIN_RATE_LIMITED', 429)
    const authenticated = await this.sessionStore.findUserForPasswordAuthentication(email, password)
    if (!authenticated) {
      await this.sessionStore.finishLoginAttempt(attempt.id, false, 'invalid_credentials')
      throw authError('邮箱或密码错误', 'INVALID_CREDENTIALS', 401)
    }
    const user = this.withSystemAdministratorStatus(authenticated.user)
    if (this.mfaRequired() && !this.isMfaExempt(user.email)) {
      if (authenticated.mfaEnabled) {
        const challengeToken = issueChallengeToken()
        const challenge = await this.sessionStore.createMfaChallenge({
          tokenHash: sha256(challengeToken),
          userId: user.id,
          ...(attempt.id ? { loginAttemptId: attempt.id } : {}),
          kind: 'login',
          expectedPasswordHash: authenticated.passwordHash,
          ...(input.ipAddress ? { requestIp: input.ipAddress } : {}),
          expiresInMs: 5 * 60_000,
          maxAttempts: 5,
        })
        return { kind: 'mfa_required', challengeToken, expiresAt: challenge.expiresAt, methods: ['totp', 'recovery_code'] }
      }
      if (this.isAdministrator(user)) {
        const setup = await this.createMfaSetupChallenge(user, attempt.id, input.ipAddress, authenticated.passwordHash)
        return { kind: 'mfa_setup_required', challengeToken: setup.challengeToken, expiresAt: setup.expiresAt, secret: setup.secret, otpauthUri: buildTotpUri(setup.secret, user.email) }
      }
    }
    await this.sessionStore.finishLoginAttempt(attempt.id, true)
    const session = await this.sessionStore.createSession(user, undefined, { expectedPasswordHash: authenticated.passwordHash, ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}) })
    return { kind: 'authenticated', ...session }
  }

  private mfaRequired(): boolean {
    return this.env.AUTH_MFA_REQUIRED?.trim().toLowerCase() === 'true'
  }

  private isMfaExempt(email: string): boolean {
    const exemptEmails = (this.env.AUTH_MFA_EXEMPT_EMAILS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
    return exemptEmails.includes(email.trim().toLowerCase())
  }

  private isAdministrator(user: SessionUser): boolean {
    return isSystemAdministrator(user, this.env)
  }

  private withSystemAdministratorStatus(user: SessionUser): SessionUser {
    const { isSystemAdmin: _cached, platformRole: _legacyRole, ...currentUser } = user
    return { ...currentUser, ...(isSystemAdministrator(currentUser, this.env) ? { isSystemAdmin: true, platformRole: 'admin' as const } : {}) }
  }

  async authorizeSystemAdministrator(auth: AuthContext | undefined): Promise<void> {
    if (!auth || auth.method !== 'session') return requireSystemAdministrator(undefined)
    const user = await this.sessionStore.findUserById(auth.user.id)
    const permitted = user !== undefined && isSystemAdministrator(user, this.env)
    auth.user = { ...auth.user, isSystemAdmin: permitted }
    requireSystemAdministrator(auth)
  }

  private parseProfileUpdate(input: unknown): ProfileUpdateInput {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw authError('个人资料格式不正确', 'PROFILE_INVALID', 400)
    }
    const record = input as Record<string, unknown>
    const allowedFields = new Set(['name', 'phone'])
    if (Object.keys(record).some((key) => !allowedFields.has(key))) {
      throw authError('个人资料仅支持修改姓名和手机号', 'PROFILE_FIELDS_NOT_ALLOWED', 400)
    }
    if (!Object.keys(record).length) {
      throw authError('请至少修改一项个人资料', 'PROFILE_UPDATE_EMPTY', 400)
    }

    const result: ProfileUpdateInput = {}
    if (record.name !== undefined) {
      if (typeof record.name !== 'string') throw authError('姓名必须是文本', 'PROFILE_NAME_INVALID', 400)
      const name = record.name.trim()
      if (!name || Array.from(name).length > 50) {
        throw authError('姓名长度应为 1 至 50 个字符', 'PROFILE_NAME_INVALID', 400)
      }
      result.name = name
    }
    if (record.phone !== undefined) {
      if (typeof record.phone !== 'string') throw authError('手机号必须是文本', 'PROFILE_PHONE_INVALID', 400)
      const phone = record.phone.trim()
      if (Array.from(phone).length > 30) {
        throw authError('手机号不能超过 30 个字符', 'PROFILE_PHONE_INVALID', 400)
      }
      result.phone = phone || null
    }
    return result
  }

  private async createMfaSetupChallenge(
    user: SessionUser,
    loginAttemptId?: string,
    ipAddress?: string,
    expectedPasswordHash?: string,
  ): Promise<{ challengeToken: string; expiresAt: string; secret: string }> {
    const secret = generateTotpSecret()
    const challengeToken = issueChallengeToken()
    const challenge = await this.sessionStore.createMfaChallenge({
      tokenHash: sha256(challengeToken),
      userId: user.id,
      ...(loginAttemptId ? { loginAttemptId } : {}),
      kind: 'setup',
      ...(expectedPasswordHash ? { expectedPasswordHash } : {}),
      encryptedSecret: encryptMfaSecret(secret, this.env.AUTH_MFA_ENCRYPTION_KEY),
      ...(ipAddress ? { requestIp: ipAddress } : {}),
      expiresInMs: 10 * 60_000,
      maxAttempts: 5,
    })
    return { challengeToken, expiresAt: challenge.expiresAt, secret }
  }

  private async rejectMfa(
    challenge: MfaChallenge,
    message: string,
    code: string,
    failureReason: string,
  ): Promise<never> {
    await this.sessionStore.recordMfaChallengeFailure(challenge.id)
    if (challenge.loginAttemptId) {
      await this.sessionStore.finishLoginAttempt(challenge.loginAttemptId, false, failureReason)
    }
    throw authError(message, code, 401)
  }

  async startMfaSetup(user: SessionUser): Promise<{ challengeToken: string; expiresAt: string; secret: string; otpauthUri: string }> {
    if (!this.isAdministrator(user)) throw authError('仅管理员可以启用 MFA', 'FORBIDDEN', 403)
    if (await this.sessionStore.getMfaCredential(user.id)) throw authError('该账号已启用 MFA', 'MFA_ALREADY_ENABLED', 409)
    const setup = await this.createMfaSetupChallenge(user)
    return { ...setup, otpauthUri: buildTotpUri(setup.secret, user.email) }
  }

  async verifyMfa(input: { challengeToken: string; code: string; ipAddress?: string }): Promise<{
    session: Awaited<ReturnType<AuthSessionStore['createSession']>>['session']
    token: string
    recoveryCodes?: string[]
  }> {
    const challengeToken = String(input.challengeToken ?? '').trim()
    const code = String(input.code ?? '').trim()
    if (!challengeToken || !code) throw authError('请输入 MFA 验证码', 'VALIDATION_ERROR', 400)
    const challenge = await this.sessionStore.findMfaChallengeByTokenHash(sha256(challengeToken))
    if (!challenge) throw authError('MFA 验证已失效，请重新登录', 'MFA_CHALLENGE_EXPIRED', 401)

    let user: SessionUser | undefined
    let recoveryCodes: string[] | undefined
    if (challenge.kind === 'setup') {
      if (!challenge.encryptedSecret) {
        await this.sessionStore.invalidateMfaChallenge(challenge.id)
        throw authError('MFA 设置已失效，请重新开始', 'MFA_CHALLENGE_EXPIRED', 401)
      }
      const secret = decryptMfaSecret(challenge.encryptedSecret, this.env.AUTH_MFA_ENCRYPTION_KEY)
      const verification = verifyTotp(secret, code)
      if (!verification.valid) {
        await this.rejectMfa(challenge, 'MFA 验证码错误', 'INVALID_MFA_CODE', 'invalid_mfa_code')
      }
      const recovery = createRecoveryCodes()
      recoveryCodes = recovery.codes
      await this.sessionStore.completeMfaChallenge(challenge.id, {
        userId: challenge.userId,
        secretEncrypted: challenge.encryptedSecret,
        recoveryCodeHashes: recovery.hashes,
        lastUsedStep: verification.step,
        enabledAt: new Date().toISOString(),
      })
      user = await this.sessionStore.findUserById(challenge.userId)
    } else {
      const credential = await this.sessionStore.getMfaCredential(challenge.userId)
      if (!credential) {
        return this.rejectMfa(challenge, 'MFA 凭据不存在', 'INVALID_MFA_CODE', 'invalid_mfa_code')
      }
      const secret = decryptMfaSecret(credential.secretEncrypted, this.env.AUTH_MFA_ENCRYPTION_KEY)
      if (/^\d{6}$/u.test(code)) {
        const verification = verifyTotp(secret, code)
        if (!verification.valid) {
          await this.rejectMfa(challenge, 'MFA 验证码错误', 'INVALID_MFA_CODE', 'invalid_mfa_code')
        }
        if (credential.lastUsedStep !== undefined && verification.step <= credential.lastUsedStep) {
          await this.rejectMfa(challenge, '动态验证码已使用，请等待下一个验证码', 'MFA_CODE_REPLAYED', 'mfa_code_replayed')
        }
        await this.sessionStore.completeMfaChallenge(challenge.id, { ...credential, lastUsedStep: verification.step })
      } else {
        const recovery = consumeRecoveryCode(code, credential.recoveryCodeHashes)
        if (!recovery.matched) {
          await this.rejectMfa(challenge, '恢复码无效或已使用', 'INVALID_MFA_CODE', 'invalid_mfa_code')
        }
        await this.sessionStore.completeMfaChallenge(challenge.id, { ...credential, recoveryCodeHashes: recovery.remaining })
      }
      user = await this.sessionStore.findUserById(challenge.userId)
    }
    if (!user) throw authError('账号不存在或已停用', 'AUTHENTICATION_REQUIRED', 401)
    if (challenge.loginAttemptId) {
      await this.sessionStore.finishLoginAttempt(challenge.loginAttemptId, true)
    }
    const session = await this.sessionStore.createSession(this.withSystemAdministratorStatus(user), undefined, { mfaChallengeId: challenge.id, ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}) })
    return { ...session, ...(recoveryCodes ? { recoveryCodes } : {}) }
  }

  getSecurityConfig(): { turnstileEnabled: boolean; turnstileSiteKey: string; adminMfaRequired: boolean } {
    const turnstile = loadTurnstileConfig(this.env)
    return { turnstileEnabled: turnstile.enabled, turnstileSiteKey: turnstile.siteKey, adminMfaRequired: this.mfaRequired() }
  }

  async logout(sessionId: string): Promise<void> {
    if (sessionId) await this.sessionStore.deleteSession(sessionId)
  }

  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    return this.sessionStore.listWorkspaces(userId)
  }

  async updateCurrentUserProfile(user: SessionUser, input: unknown): Promise<SessionUser> {
    const updates = this.parseProfileUpdate(input)
    const contact: ProfileContact = await this.sessionStore.updateUserProfile(user.id, updates)
    const { phone: _previousPhone, ...currentUser } = user
    return {
      ...currentUser,
      name: contact.name,
      ...(contact.phone ? { phone: contact.phone } : {}),
    }
  }

  async createWorkspace(userId: string, input: WorkspaceCreateInput): Promise<WorkspaceSummary> {
    return this.sessionStore.createWorkspace(userId, input)
  }

  async archiveWorkspace(userId: string, workspaceId: string): Promise<void> {
    return this.sessionStore.archiveWorkspace(userId, workspaceId)
  }

  async resetWorkspace(userId: string, workspaceId: string): Promise<void> {
    return this.sessionStore.resetWorkspace(userId, workspaceId)
  }

  async selectWorkspace(sessionId: string, userId: string, workspaceId: string): Promise<SessionUser> {
    return this.withSystemAdministratorStatus(await this.sessionStore.selectWorkspace(sessionId, userId, workspaceId))
  }

  async authenticateToken(token: string | undefined): Promise<AuthContext | undefined> {
    if (!token) return undefined
    const session = await this.sessionStore.findSessionByToken(token)
    if (!session) return undefined
    return { user: this.withSystemAdministratorStatus(session.user), sessionId: session.sessionId, method: 'session' }
  }

  getBootstrapUser(env: NodeJS.ProcessEnv = process.env): SessionUser | undefined {
    if (env.NODE_ENV !== 'development' || env.ALLOW_DEV_BOOTSTRAP_AUTH === 'false') return undefined
    return {
      id: env.DEV_BOOTSTRAP_USER_ID?.trim() || 'user-recruiter',
      name: env.DEV_BOOTSTRAP_USER_NAME?.trim() || '招聘专员（开发）',
      email: env.DEV_BOOTSTRAP_USER_EMAIL?.trim() || 'recruiter@smartrecruit.local',
      role: 'recruiter',
      departmentId: env.DEV_BOOTSTRAP_USER_DEPARTMENT?.trim() || 'dept-tech',
    }
  }

  requirePermission(auth: AuthContext | undefined, roles?: Role[]): void {
    if (!auth) throw authError('未登录，请先完成身份认证', 'AUTHENTICATION_REQUIRED', 401)
    if (roles && roles.length > 0 && !roles.includes(auth.user.role)) {
      throw authError('当前账号没有执行此操作的权限', 'FORBIDDEN', 403)
    }
  }
}
