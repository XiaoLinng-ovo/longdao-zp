export type Role = 'recruiter' | 'hiring_manager' | 'approver' | 'admin' | 'hr_admin' | 'interviewer'
export type WorkspaceKind = 'test' | 'production'
export type WorkspaceStatus = 'active' | 'archived'
export type PlatformRole = 'admin' | 'viewer'
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
  name: string
  email: string
  role: Role
  departmentId: string
  workspaceId?: string
  workspaceName?: string
  workspaceKind?: WorkspaceKind
  platformRole?: PlatformRole
  workspaceAccessIssue?: 'unavailable'
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
}

export interface RegisterInput {
  name: string
  email: string
  password: string
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
  recruiter: '招聘专员',
  hiring_manager: '部门负责人',
  approver: '审批人',
  admin: '系统管理员',
  hr_admin: 'HR 管理员',
  interviewer: '面试官',
}

