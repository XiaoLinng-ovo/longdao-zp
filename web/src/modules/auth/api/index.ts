import { apiClient } from '../../../shared/api'

export type AuthRole = 'recruiter' | 'hiring_manager' | 'approver' | 'admin' | 'hr_admin' | 'interviewer'
export type PlatformRole = 'admin' | 'viewer'
export type ServiceStatus = 'enabled' | 'trial' | 'suspended'
export type WorkspaceKind = 'test' | 'production'
export type WorkspaceStatus = 'active' | 'archived'
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

export interface AuthUser {
  id: string
  /** 用户随机编码（USR-XXXXXXXXXX），全局唯一；姓名可重复 */
  userNo?: string
  name: string
  email: string
  phone?: string
  role: AuthRole
  departmentId: string
  workspaceId?: string
  workspaceName?: string
  workspaceKind?: WorkspaceKind
  platformRole?: PlatformRole
  isSystemAdmin?: boolean
  workspaceAccessIssue?: 'unavailable'
}

export interface UpdateCurrentUserProfileInput {
  name?: string
  phone?: string
}

export interface AuthenticatedAuthResponse {
  user: AuthUser
  sessionId: string
  expiresAt: string
  workspaces: WorkspaceSummary[]
  recoveryCodes?: string[]
}

export type AuthLoginResponse = AuthenticatedAuthResponse

export interface AuthenticatedRegisterResponse extends AuthenticatedAuthResponse {
  workspace: WorkspaceSummary
}

export interface MfaRequiredResponse {
  kind: 'mfa_required'
  challengeToken: string
  expiresAt: string
  methods: Array<'totp' | 'recovery_code'>
}

export interface MfaSetupRequiredResponse {
  kind: 'mfa_setup_required'
  challengeToken: string
  expiresAt: string
  secret: string
  otpauthUri: string
}

export type AuthLoginResult = ({ kind: 'authenticated' } & AuthenticatedAuthResponse) | MfaRequiredResponse | MfaSetupRequiredResponse

export interface SecurityConfig {
  turnstileEnabled: boolean
  turnstileSiteKey: string
  adminMfaRequired: boolean
}

export interface MeResponse {
  user: AuthUser
  sessionId: string
  method: 'session' | 'development-bootstrap'
  workspaces: WorkspaceSummary[]
}

export interface RegisterInput {
  name: string
  email: string
  password: string
  companyName: string
  invitationCode?: string
  phone?: string
  verificationCode: string
  turnstileToken?: string
}

export async function requestRegistrationCode(email: string, turnstileToken?: string): Promise<{ accepted: true; retryAfterSeconds: number }> {
  return (await apiClient.postJson<{ accepted: true; retryAfterSeconds: number }>('/auth/registration/code', { email, ...(turnstileToken ? { turnstileToken } : {}) })).data
}

export async function register(input: RegisterInput): Promise<AuthenticatedRegisterResponse> {
  return (await apiClient.postJson<AuthenticatedRegisterResponse>('/auth/register', input)).data
}

export async function login(email: string, password: string): Promise<AuthLoginResult> {
  return (await apiClient.postJson<AuthLoginResult>('/auth/login', { email, password })).data
}

export async function verifyMfa(challengeToken: string, code: string): Promise<AuthenticatedAuthResponse> {
  return (await apiClient.postJson<AuthenticatedAuthResponse>('/auth/mfa/verify', { challengeToken, code })).data
}

export async function requestPasswordResetCode(email: string, turnstileToken?: string): Promise<{ accepted: true; retryAfterSeconds: number }> {
  return (await apiClient.postJson<{ accepted: true; retryAfterSeconds: number }>('/auth/password-reset/request', { email, ...(turnstileToken ? { turnstileToken } : {}) })).data
}

export async function confirmPasswordReset(email: string, verificationCode: string, password: string, turnstileToken?: string): Promise<{ ok: true }> {
  return (await apiClient.postJson<{ ok: true }>('/auth/password-reset/confirm', {
    email,
    verificationCode,
    password,
    ...(turnstileToken ? { turnstileToken } : {}),
  })).data
}

export async function getSecurityConfig(): Promise<SecurityConfig> {
  return (await apiClient.getJson<SecurityConfig>('/auth/security-config')).data
}

export async function logout(sessionId?: string): Promise<{ ok: boolean }> {
  return (await apiClient.postJson<{ ok: boolean }>('/auth/logout', sessionId ? { sessionId } : {})).data
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  return (await apiClient.getJson<WorkspaceSummary[]>('/workspaces')).data
}

export async function createWorkspace(name: string, kind: WorkspaceKind): Promise<WorkspaceSummary> {
  return (await apiClient.postJson<WorkspaceSummary>('/workspaces', { name, kind })).data
}

export async function selectWorkspace(workspaceId: string): Promise<{ user: AuthUser }> {
  return (await apiClient.postJson<{ user: AuthUser }>(`/workspaces/${encodeURIComponent(workspaceId)}/select`, {})).data
}

export async function resetWorkspace(workspaceId: string): Promise<{ ok: boolean }> {
  return (await apiClient.postJson<{ ok: boolean }>(`/workspaces/${encodeURIComponent(workspaceId)}/reset`, {})).data
}

export async function archiveWorkspace(workspaceId: string): Promise<{ ok: boolean }> {
  return (await apiClient.postJson<{ ok: boolean }>(`/workspaces/${encodeURIComponent(workspaceId)}/archive`, {})).data
}

export async function getCurrentUser(): Promise<MeResponse> {
  return (await apiClient.getJson<MeResponse>('/me')).data
}

export async function updateCurrentUserProfile(input: UpdateCurrentUserProfileInput): Promise<{ user: AuthUser }> {
  return (await apiClient.patchJson<{ user: AuthUser }>('/me', input)).data
}

export async function requestEmailChangeCode(newEmail: string, currentPassword?: string) {
  return (await apiClient.postJson<{ accepted: true; retryAfterSeconds: number }>('/auth/account/email/code', { newEmail, currentPassword })).data
}

export async function confirmEmailChange(newEmail: string, currentPassword: string | undefined, verificationCode: string) {
  return (await apiClient.postJson<{ ok: true }>('/auth/account/email', { newEmail, currentPassword, verificationCode })).data
}

export async function changePassword(currentPassword: string, newPassword: string) {
  return (await apiClient.postJson<{ ok: true }>('/auth/account/password', { currentPassword, newPassword })).data
}

export async function requestAccountPasswordCode() {
  return (await apiClient.postJson<{ accepted: true; retryAfterSeconds: number }>('/auth/account/password/code', {})).data
}

export async function changePasswordWithCode(verificationCode: string, newPassword: string) {
  return (await apiClient.postJson<{ ok: true }>('/auth/account/password', { verificationCode, newPassword })).data
}

export async function verifyAccountPasswordCode(verificationCode: string) {
  return (await apiClient.postJson<{ ok: true }>('/auth/account/password/verify', { verificationCode })).data
}

export interface SavedAccount {
  user: AuthUser
  current: boolean
}

export async function listSavedAccounts(): Promise<SavedAccount[]> {
  return (await apiClient.getJson<SavedAccount[]>('/auth/accounts')).data
}

export async function switchSavedAccount(userId: string): Promise<MeResponse> {
  return (await apiClient.postJson<MeResponse>('/auth/accounts/switch', { userId })).data
}
