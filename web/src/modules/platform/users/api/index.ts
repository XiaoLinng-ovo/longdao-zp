import { apiClient } from '../../../../shared/api'

export type PlatformUserRoleFilter = 'admin' | 'viewer' | 'none'
export type PlatformUserStatusFilter = 'active' | 'disabled'

export interface PlatformUserWorkspace {
  id: string
  name: string
  kind: 'test' | 'production'
  status: 'active' | 'archived'
  serviceStatus: 'enabled' | 'trial' | 'suspended'
  usePlatformAi: boolean
  isActive?: boolean
  platformAiAccessReady?: boolean
  platformAiSourceOrganizationName?: string | null
  membershipRole: 'owner' | 'admin' | 'member'
  businessRole: string
  departmentId: string | null
  departmentName: string | null
  joinedAt: string
}

export interface PlatformUserListItem {
  id: string
  displayName: string
  email: string
  phoneMasked: string | null
  isActive: boolean
  platformRole: 'admin' | 'viewer' | null
  registrationSource: string
  createdAt: string
  lastLoginAt: string | null
  workspaceCount: number
  primaryWorkspace: Omit<PlatformUserWorkspace, 'joinedAt' | 'departmentId' | 'departmentName'> | null
}

export interface PlatformUserListResponse {
  items: PlatformUserListItem[]
  total: number
  page: number
  pageSize: number
}

export interface PlatformUserDetail {
  user: {
    id: string
    displayName: string
    email: string
    phone: string | null
    isActive: boolean
    platformRole: 'admin' | 'viewer' | null
    registrationSource: string
    createdAt: string
    lastLoginAt: string | null
  }
  workspaces: PlatformUserWorkspace[]
  activeSessions: Array<{
    id: string
    createdAt: string
    lastSeenAt: string
    expiresAt: string
    ipAddress: string | null
    userAgent: string | null
  }>
  recentAudit: Array<{
    id: string
    source: 'platform' | 'workspace'
    action: string
    organizationId: string | null
    organizationName: string | null
    requestId: string | null
    metadata: Record<string, unknown>
    createdAt: string
  }>
}

export interface PlatformUserQuery {
  q?: string
  status?: PlatformUserStatusFilter | ''
  platformRole?: PlatformUserRoleFilter | ''
  page?: number
  pageSize?: number
}

export async function listPlatformUsers(query: PlatformUserQuery = {}): Promise<PlatformUserListResponse> {
  const params = new URLSearchParams()
  if (query.q?.trim()) params.set('q', query.q.trim())
  if (query.status) params.set('status', query.status)
  if (query.platformRole) params.set('platformRole', query.platformRole)
  params.set('page', String(query.page ?? 1))
  params.set('pageSize', String(query.pageSize ?? 20))
  return (await apiClient.getJson<PlatformUserListResponse>(`/platform/users?${params}`)).data
}

export async function getPlatformUser(id: string): Promise<PlatformUserDetail> {
  return (await apiClient.getJson<PlatformUserDetail>(`/platform/users/${encodeURIComponent(id)}`)).data
}

export async function updatePlatformUserStatus(id: string, isActive: boolean, reason: string): Promise<PlatformUserDetail> {
  return (await apiClient.patchJson<PlatformUserDetail>(`/platform/users/${encodeURIComponent(id)}/status`, { isActive, reason })).data
}

export async function updatePlatformUserProfile(id: string, input: { displayName?: string; phone?: string | null; reason: string }): Promise<PlatformUserDetail> {
  return (await apiClient.patchJson<PlatformUserDetail>(`/platform/users/${encodeURIComponent(id)}/profile`, input)).data
}

export async function updatePlatformWorkspaceAiAccess(userId: string, organizationId: string, usePlatformAi: boolean, reason: string): Promise<PlatformUserDetail> {
  return (await apiClient.patchJson<PlatformUserDetail>(`/platform/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(organizationId)}/ai-access`, { usePlatformAi, reason })).data
}

export async function appointWorkspaceOwner(userId: string, organizationId: string, reason: string): Promise<PlatformUserDetail> {
  return (await apiClient.patchJson<PlatformUserDetail>(`/platform/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(organizationId)}/owner`, { reason })).data
}

export async function revokePlatformUserSessions(id: string, reason: string): Promise<{ revokedSessions: number }> {
  return (await apiClient.postJson<{ revokedSessions: number }>(`/platform/users/${encodeURIComponent(id)}/revoke-sessions`, { reason })).data
}

export async function resetPlatformUserPassword(id: string, reason: string): Promise<{ temporaryPassword: string; revokedSessions: number }> {
  return (await apiClient.postJson<{ temporaryPassword: string; revokedSessions: number }>(`/platform/users/${encodeURIComponent(id)}/reset-password`, { reason })).data
}

export async function resetPlatformUserAiGenerationQuota(userId: string, organizationId: string, reason: string): Promise<{
  organizationId: string
  organizationName: string
  previousGenerations: number
  generations: number
}> {
  return (await apiClient.postJson<{
    organizationId: string
    organizationName: string
    previousGenerations: number
    generations: number
  }>(`/platform/users/${encodeURIComponent(userId)}/workspaces/${encodeURIComponent(organizationId)}/reset-ai-generation-quota`, { reason })).data
}
