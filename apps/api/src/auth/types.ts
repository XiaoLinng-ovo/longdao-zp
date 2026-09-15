export type Role = 'recruiter' | 'hiring_manager' | 'approver' | 'admin' | 'hr_admin' | 'interviewer'

export interface SessionUser {
  id: string
  name: string
  email: string
  role: Role
  departmentId: string
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

