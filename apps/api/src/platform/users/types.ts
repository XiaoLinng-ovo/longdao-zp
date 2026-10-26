export type PlatformUserStatusFilter = 'active' | 'disabled'
export type PlatformUserRoleFilter = 'admin' | 'viewer' | 'none'

export interface PlatformUserListQuery {
  page: number
  pageSize: number
  q: string
  status: PlatformUserStatusFilter | null
  workspaceId: string | null
  platformRole: PlatformUserRoleFilter | null
}

export interface PlatformUserWorkspace {
  id: string
  name: string
  kind: 'test' | 'production'
  status: 'active' | 'archived'
  serviceStatus: 'enabled' | 'trial' | 'suspended'
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

export interface PlatformUserStatusInput {
  isActive: boolean
  reason: string
}

export interface PlatformUserReasonInput {
  reason: string
}

export interface PlatformUserProfileInput {
  displayName?: string
  phone?: string | null
  reason: string
}
