import type { PlatformRole } from '../platform/roles.js'

export type { PlatformRole } from '../platform/roles.js'

export type Role = 'recruiter' | 'hiring_manager' | 'approver' | 'admin' | 'hr_admin' | 'interviewer'
export type WorkspaceKind = 'test' | 'production'
export type WorkspaceStatus = 'active' | 'archived'
export type ServiceStatus = 'enabled' | 'trial' | 'suspended'
export type WorkspaceRole = 'owner' | 'admin' | 'member'

export interface WorkspaceSummary {
  id: string
  name: string
  kind: WorkspaceKind
  status: WorkspaceStatus
  role: WorkspaceRole
  createdAt: string
  serviceStatus?: ServiceStatus
  trialEndsAt?: string | null
  serviceAvailable?: boolean
  archivedAt?: string
}

export interface SessionUser {
  id: string
  /** 用户随机编码（USR-XXXXXXXXXX），跨表绑定与对外标识；姓名可重复，此编码唯一 */
  userNo?: string
  name: string
  email: string
  phone?: string
  role: Role
  departmentId: string
  workspaceId?: string
  workspaceName?: string
  workspaceKind?: WorkspaceKind
  platformRole?: PlatformRole
  isSystemAdmin?: boolean
  workspaceAccessIssue?: 'unavailable'
}

export interface ProfileUpdateInput {
  name?: string
  phone?: string | null
}

export interface ProfileContact {
  name: string
  phone?: string
}

export interface AuthSession {
  sessionId: string
  userId: string
  tokenHash: string
  createdAt: string
  expiresAt: string
  lastSeenAt: string
  user: SessionUser
}

export interface LoginInput {
  email: string
  password: string
  ipAddress?: string
}

export interface RegisterInput {
  name: string
  email: string
  password: string
  companyName: string
  phone?: string
  ipAddress?: string
  verificationCode?: string
  turnstileToken?: string
}

export interface RegisterResult {
  user: SessionUser
  workspace: WorkspaceSummary
}

export interface AuthenticatedRegisterResult extends RegisterResult {
  session: AuthSession
  token: string
}

export type VerificationPurpose = 'registration' | 'password_reset' | 'email_change'

export interface VerificationChallengeRecord {
  id: string
  purpose: VerificationPurpose
  email: string
  userId?: string
  deliveredAt?: string
  codeHash: string
  expiresAt: string
  attempts: number
  maxAttempts: number
  consumedAt?: string
  invalidatedAt?: string
  requestIp?: string
  createdAt: string
}

export interface CreateVerificationChallengeInput {
  purpose: VerificationPurpose
  email: string
  userId?: string
  codeHash: string
  requestIp?: string
  expiresInMs: number
  maxAttempts: number
}

export interface VerificationChallengeCreation {
  challenge?: VerificationChallengeRecord
  retryAfterSeconds: number
}

export interface AccountSessionIdentity {
  userId: string
  sessionId: string
  email: string
}

export type AccountCredentialChange = AccountSessionIdentity & { expectedPasswordHash: string } & (
  { newEmail: string; codeHash: string } | { newPasswordHash: string }
) & { passwordCodeHash?: string }

export interface LoginAttemptReservation {
  id: string
  allowed: boolean
  retryAfterSeconds: number
}

export interface PasswordAuthentication {
  user: SessionUser
  mfaEnabled: boolean
  passwordHash: string
}

export interface SessionIssuanceMetadata {
  userAgent?: string
  ipAddress?: string
  expectedPasswordHash?: string
  mfaChallengeId?: string
}

export interface MfaCredential {
  userId: string
  secretEncrypted: string
  recoveryCodeHashes: string[]
  lastUsedStep?: number
  enabledAt: string
}

export interface MfaChallenge {
  id: string
  tokenHash: string
  userId: string
  loginAttemptId?: string
  kind: 'login' | 'setup'
  encryptedSecret?: string
  expiresAt: string
  attempts: number
  maxAttempts: number
  consumedAt?: string
  invalidatedAt?: string
  requestIp?: string
  createdAt: string
}

export interface CreateMfaChallengeInput {
  tokenHash: string
  userId: string
  expectedPasswordHash?: string
  loginAttemptId?: string
  kind: 'login' | 'setup'
  encryptedSecret?: string
  requestIp?: string
  expiresInMs: number
  maxAttempts: number
}

export interface AuthenticatedLoginResult {
  kind: 'authenticated'
  session: AuthSession
  token: string
}

export interface MfaLoginResult {
  kind: 'mfa_required'
  challengeToken: string
  expiresAt: string
  methods: Array<'totp' | 'recovery_code'>
}

export interface MfaSetupLoginResult {
  kind: 'mfa_setup_required'
  challengeToken: string
  expiresAt: string
  secret: string
  otpauthUri: string
}

export type LoginResult = AuthenticatedLoginResult | MfaLoginResult | MfaSetupLoginResult

export interface PasswordResetCompletion {
  email: string
  codeHash: string
  passwordHash: string
}

export interface WorkspaceCreateInput {
  name: string
  kind: WorkspaceKind
}

export interface AuthContext {
  user: SessionUser
  sessionId: string
  method: 'session' | 'development-bootstrap'
}

export const ROLE_LABELS: Record<Role, string> = {
  recruiter: '企业用户',
  hiring_manager: '企业用户',
  approver: '企业用户',
  admin: '企业用户',
  hr_admin: '企业用户',
  interviewer: '企业用户',
}

