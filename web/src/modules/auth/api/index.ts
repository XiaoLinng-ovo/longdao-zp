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
  name: string
  email: string
  role: AuthRole
  departmentId: string
  workspaceId?: string
  workspaceName?: string
  workspaceKind?: WorkspaceKind
  platformRole?: PlatformRole
  workspaceAccessIssue?: 'unavailable'
}

export interface AuthLoginResponse {
  user: AuthUser
  sessionId: string
  expiresAt: string
  workspaces: WorkspaceSummary[]
}

export interface MeResponse {
  user: AuthUser
  sessionId: string
  method: 'session' | 'development-bootstrap'
  workspaces: WorkspaceSummary[]
}

export async function register(name: string, email: string, password: string): Promise<{ user: AuthUser }> {
  return (await apiClient.postJson<{ user: AuthUser }>('/auth/register', { name, email, password })).data
}

export async function login(email: string, password: string): Promise<AuthLoginResponse> {
  return (await apiClient.postJson<AuthLoginResponse>('/auth/login', { email, password })).data
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
