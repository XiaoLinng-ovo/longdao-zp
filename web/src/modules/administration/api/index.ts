import { apiClient } from '../../../shared/api'
import { loadWorkflowEvents as loadSharedWorkflowEvents } from '../../../shared/api/workflow-events'
import type { WorkflowEvent as SharedWorkflowEvent } from '../../../shared/api/workflow-events'

export type WorkflowEvent = SharedWorkflowEvent

export interface AdminCheckRow {
  category: string
  owner: string
  status: 'configured' | 'active' | 'paused' | 'failed'
  detail: string
}

export interface AdminUser {
  id: string
  email: string
  displayName: string
  role: string
  departmentCode: string | null
  isActive: boolean
  lastLoginAt: string | null
  createdAt: string
}

export interface AdminRole { id: string; code: string; name: string }
export interface AdminDepartment { id: string; code: string; name: string; isActive: boolean; createdAt: string; updatedAt: string }
export type AdminSettings = Record<string, unknown>
export interface AdminAnalysisTask {
  id: string; resumeId: string; applicationId?: string; status: 'queued' | 'processing' | 'completed' | 'failed'; attempts: number; idempotencyKey: string; lastError?: string; availableAt: string; startedAt?: string; completedAt?: string; createdAt: string
}
export interface AdminAuditLog {
  id: string; actorId: string | null; actorEmail: string | null; action: string; resourceType: string; resourceId: string | null; requestId: string | null; metadata: Record<string, unknown>; createdAt: string
}

interface ReadyPayload {
  status: string
  checks: Record<string, string>
}

interface HealthPayload {
  status: string
  service: string
  version: string
  uptimeSeconds: number
}

export async function listAdminChecks(): Promise<AdminCheckRow[]> {
  const [ready, health] = await Promise.all([
    apiClient.getJson<ReadyPayload>('/ready'),
    apiClient.getJson<HealthPayload>('/health'),
  ])
  const checks = ready.data.checks || {}
  const configState = ready.data.status === 'ready' ? 'configured' : 'failed'
  return [
    { category: '服务就绪', owner: '系统管理员', status: configState, detail: ready.data.status === 'ready' ? 'API 就绪检查通过' : 'API 就绪检查未通过' },
    { category: '配置检查', owner: '系统管理员', status: 'configured', detail: checks.configuration || '—' },
    { category: '服务健康', owner: '系统管理员', status: 'active', detail: health.data.service || '—' },
    { category: '服务版本', owner: '系统管理员', status: 'configured', detail: health.data.version || '—' },
    { category: '运行时长', owner: '系统管理员', status: 'configured', detail: `${Math.floor(health.data.uptimeSeconds || 0)} 秒` },
    { category: '审批与模型服务', owner: '系统管理员', status: 'paused', detail: '尚未接入外部模型配置源，当前由本地领域状态机驱动' },
    { category: '文件与审计', owner: '系统管理员', status: 'active', detail: '流程审计已接入本地 workflow-events 数据源' },
  ]
}

export async function loadWorkflowEvents(subjectType?: WorkflowEvent['subjectType'], limit = 50): Promise<WorkflowEvent[]> {
  return loadSharedWorkflowEvents(subjectType, limit)
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  return (await apiClient.getJson<AdminUser[]>('/admin/users')).data
}

export async function updateAdminUser(id: string, patch: Partial<Pick<AdminUser, 'displayName' | 'isActive' | 'departmentCode' | 'role'>> & { password?: string }): Promise<AdminUser> {
  return (await apiClient.patchJson<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, patch)).data
}

export async function listAdminRoles(): Promise<AdminRole[]> {
  return (await apiClient.getJson<AdminRole[]>('/admin/roles')).data
}

export async function listAdminDepartments(): Promise<AdminDepartment[]> {
  return (await apiClient.getJson<AdminDepartment[]>('/admin/departments')).data
}

export async function createAdminDepartment(input: { code: string; name: string }): Promise<AdminDepartment> {
  return (await apiClient.postJson<AdminDepartment>('/admin/departments', input)).data
}

export async function updateAdminDepartment(id: string, patch: { name?: string; isActive?: boolean }): Promise<AdminDepartment> {
  return (await apiClient.patchJson<AdminDepartment>(`/admin/departments/${encodeURIComponent(id)}`, patch)).data
}

export async function updateAdminRole(id: string, patch: { name?: string }): Promise<AdminRole> {
  return (await apiClient.patchJson<AdminRole>(`/admin/roles/${encodeURIComponent(id)}`, patch)).data
}

export async function getAdminSettings(): Promise<AdminSettings> {
  return (await apiClient.getJson<AdminSettings>('/admin/settings')).data
}

export async function updateAdminSettings(patch: AdminSettings): Promise<AdminSettings> {
  return (await apiClient.patchJson<AdminSettings>('/admin/settings', patch)).data
}

export async function listFailedAnalysisTasks(): Promise<AdminAnalysisTask[]> {
  return (await apiClient.getJson<AdminAnalysisTask[]>('/admin/analysis-tasks?status=failed')).data
}

export async function listAdminAuditLogs(limit = 50): Promise<AdminAuditLog[]> {
  return (await apiClient.getJson<AdminAuditLog[]>(`/admin/audit-logs?limit=${encodeURIComponent(String(limit))}`)).data
}
