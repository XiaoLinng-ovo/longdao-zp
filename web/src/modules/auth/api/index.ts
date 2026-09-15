import { apiClient } from '../../../shared/api'

export type AuthRole = 'recruiter' | 'hiring_manager' | 'approver' | 'admin' | 'hr_admin' | 'interviewer'

export interface AuthUser {
  id: string
  name: string
  email: string
  role: AuthRole
  departmentId: string
}

export interface AuthLoginResponse {
  user: AuthUser
  sessionId: string
  expiresAt: string
}

export interface MeResponse {
  user: AuthUser
  sessionId: string
  method: 'session' | 'development-bootstrap'
}

export async function login(email: string, password: string): Promise<AuthLoginResponse> {
  return (await apiClient.postJson<AuthLoginResponse>('/auth/login', { email, password })).data
}

export async function logout(sessionId?: string): Promise<{ ok: boolean }> {
  return (await apiClient.postJson<{ ok: boolean }>('/auth/logout', sessionId ? { sessionId } : {})).data
}

export async function getCurrentUser(): Promise<MeResponse> {
  return (await apiClient.getJson<MeResponse>('/me')).data
}

