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
export interface AdminAccountOrganization { id: string; name: string }
export interface AdminUserCreate {
  email: string
  displayName: string
  organizationId: string
  departmentCode: string
  role: string
  password?: string
}
export interface AdminUserCreateResult { user: AdminUser; initialPassword: string; generatedPassword: boolean }

export async function listAccountOrganizations(): Promise<AdminAccountOrganization[]> {
  return (await apiClient.getJson<AdminAccountOrganization[]>('/admin/account-organizations')).data
}

export async function createAdminUser(input: AdminUserCreate): Promise<AdminUserCreateResult> {
  return (await apiClient.postJson<AdminUserCreateResult>('/admin/users', input)).data
}

export interface AdminDepartment { id: string; code: string; name: string; isActive: boolean; createdAt: string; updatedAt: string }
export interface AdminDepartmentDeleteResult { id: string; code: string; name: string; removedApprovalPolicies: number }
export type AdminSettings = Record<string, unknown>
export interface DingTalkEnvSetting { value: string; configured: boolean; masked: boolean }
export type DingTalkEnvSettings = Record<string, DingTalkEnvSetting>
export interface SmtpEnvSetting { value: string; configured: boolean; masked: boolean }
export type SmtpEnvSettings = Record<'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'SMTP_FROM', SmtpEnvSetting>
export interface SmtpConnectionTestResult { ok: boolean; message: string }
export interface SmtpTestEmailResult { ok: boolean; message: string }
export interface UnresolvedEmailDelivery {
  id:string; organization_id:string; offer_id:string; version_id:string; message_id:string
  status:'sending'|'accepted'|'unknown'; created_at:string; updated_at:string
}
export interface RecoveryTask {
  id:string; organization_id:string; status:string; storage_kind?:string; attempts?:number; progress?:number
  last_error?:string; available_at?:string; updated_at?:string; created_at?:string
  refund_check_attempts?:number; refund_next_check_at?:string; refund_check_error?:string
  recovery_version?:string
}
export interface OperationalRecovery { cleanup:RecoveryTask[]; audio:RecoveryTask[]; refund:RecoveryTask[]; audioLookup?: {supported:boolean;reason:string} }
export async function listUnresolvedEmailDeliveries():Promise<UnresolvedEmailDelivery[]> {
  return (await apiClient.getJson<UnresolvedEmailDelivery[]>('/admin/email-deliveries')).data
}
export async function resolveEmailDelivery(id:string,status:'completed'|'not_sent',note:string) {
  return (await apiClient.postJson('/admin/email-deliveries/'+encodeURIComponent(id)+'/resolve',{status,note})).data
}
export async function listOperationalRecovery():Promise<OperationalRecovery> {
  return (await apiClient.getJson<OperationalRecovery>('/admin/operational-recovery')).data
}
export async function resolveOperationalTask(kind:'cleanup'|'audio',id:string,action:'retry'|'stop',note:string,version:string) {
  return (await apiClient.postJson('/admin/operational-recovery/'+kind+'/'+encodeURIComponent(id)+'/resolve',{action,note,version})).data
}
export interface ResumeVirusScanSetting { enabled: boolean }
export interface AdminAnalysisTask {
  id: string; resumeId: string; applicationId?: string; status: 'queued' | 'processing' | 'completed' | 'failed'; attempts: number; idempotencyKey: string; lastError?: string; availableAt: string; startedAt?: string; completedAt?: string; createdAt: string
}
export interface AdminAuditLog {
  id: string; actorId: string | null; actorEmail: string | null; action: string; resourceType: string; resourceId: string | null; requestId: string | null; metadata: Record<string, unknown>; createdAt: string
}
export type AiPromptSkillTarget = 'job_spec' | 'jd' | 'both' | 'resume_score'
export interface AdminAiPromptSkill {
  id: string; name: string; targetType: AiPromptSkillTarget; jobIds?: string[]; content: string; isActive: boolean; createdBy: string | null; createdAt: string; updatedAt: string
}

export async function listAiPromptSkills(): Promise<AdminAiPromptSkill[]> {
  return (await apiClient.getJson<AdminAiPromptSkill[]>('/admin/ai-skills')).data
}
export async function createAiPromptSkill(input: { name: string; targetType: AiPromptSkillTarget; content: string; jobIds?: string[] }): Promise<AdminAiPromptSkill> {
  return (await apiClient.postJson<AdminAiPromptSkill>('/admin/ai-skills', input)).data
}
export async function updateAiPromptSkill(id: string, patch: Partial<Pick<AdminAiPromptSkill, 'name' | 'targetType' | 'content' | 'isActive' | 'jobIds'>>): Promise<AdminAiPromptSkill> {
  return (await apiClient.patchJson<AdminAiPromptSkill>(`/admin/ai-skills/${encodeURIComponent(id)}`, patch)).data
}
export async function deleteAiPromptSkill(id: string): Promise<{ deleted: boolean }> {
  return (await apiClient.deleteJson<{ deleted: boolean }>(`/admin/ai-skills/${encodeURIComponent(id)}`)).data
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
    { category: '配置检查', owner: '系统管理员', status: checks.configuration === 'ok' ? 'configured' : 'failed', detail: checks.configuration || '未取得配置检查结果' },
    { category: '服务健康', owner: '系统管理员', status: health.data.status === 'ok' ? 'active' : 'failed', detail: health.data.service || '未取得服务标识' },
    { category: '服务版本', owner: '系统管理员', status: 'configured', detail: health.data.version || '—' },
    { category: '运行时长', owner: '系统管理员', status: 'configured', detail: `${Math.floor(health.data.uptimeSeconds || 0)} 秒` },
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

export async function createAdminDepartment(input: { name: string }): Promise<AdminDepartment> {
  return (await apiClient.postJson<AdminDepartment>('/admin/departments', input)).data
}

export async function updateAdminDepartment(id: string, patch: { name?: string; isActive?: boolean }): Promise<AdminDepartment> {
  return (await apiClient.patchJson<AdminDepartment>(`/admin/departments/${encodeURIComponent(id)}`, patch)).data
}

/** 物理删除部门。仍有用户/需求/岗位/子部门引用时服务端返回 400 并说明原因。 */
export async function deleteAdminDepartment(id: string): Promise<AdminDepartmentDeleteResult> {
  return (await apiClient.deleteJson<AdminDepartmentDeleteResult>(`/admin/departments/${encodeURIComponent(id)}`)).data
}

export async function listEnterpriseDepartments(): Promise<AdminDepartment[]> {
  return (await apiClient.getJson<AdminDepartment[]>('/departments?activeOnly=false')).data
}

export async function createEnterpriseDepartment(input: { name: string }): Promise<AdminDepartment> {
  return (await apiClient.postJson<AdminDepartment>('/departments', input)).data
}

export async function updateEnterpriseDepartment(id: string, patch: { name?: string; isActive?: boolean }): Promise<AdminDepartment> {
  return (await apiClient.patchJson<AdminDepartment>(`/departments/${encodeURIComponent(id)}`, patch)).data
}

export async function deleteEnterpriseDepartment(id: string): Promise<AdminDepartmentDeleteResult> {
  return (await apiClient.deleteJson<AdminDepartmentDeleteResult>(`/departments/${encodeURIComponent(id)}`)).data
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

export async function getDingTalkSettings(): Promise<DingTalkEnvSettings> {
  return (await apiClient.getJson<DingTalkEnvSettings>('/admin/dingtalk-settings')).data
}

export async function updateDingTalkSettings(patch: Record<string, string>): Promise<DingTalkEnvSettings> {
  return (await apiClient.patchJson<DingTalkEnvSettings>('/admin/dingtalk-settings', patch)).data
}

export async function getSmtpSettings(): Promise<SmtpEnvSettings> {
  return (await apiClient.getJson<SmtpEnvSettings>('/admin/smtp-settings')).data
}

export async function updateSmtpSettings(patch: Partial<Record<keyof SmtpEnvSettings, string>>): Promise<SmtpEnvSettings> {
  return (await apiClient.patchJson<SmtpEnvSettings>('/admin/smtp-settings', patch)).data
}
export async function sendSmtpTestEmail(to: string): Promise<SmtpTestEmailResult> {
  return (await apiClient.postJson<SmtpTestEmailResult>('/admin/smtp-test-email', { to })).data
}

export async function testSmtpConnection(patch: Partial<Record<keyof SmtpEnvSettings, string>> = {}): Promise<SmtpConnectionTestResult> {
  return (await apiClient.postJson<SmtpConnectionTestResult>('/admin/smtp-connection-test', patch)).data
}

export interface DingTalkConnectionTestResult {
  ok: boolean
  status?: number
  message: string
  latencyMs: number
}

export async function testDingTalkConnection(input: { appKey?: string; appSecret?: string } = {}): Promise<DingTalkConnectionTestResult> {
  return (await apiClient.postJson<DingTalkConnectionTestResult>('/admin/dingtalk-connection-test', input)).data
}

export async function getResumeVirusScanSetting(): Promise<ResumeVirusScanSetting> {
  return (await apiClient.getJson<ResumeVirusScanSetting>('/admin/resume-virus-scan')).data
}

export async function updateResumeVirusScanSetting(enabled: boolean): Promise<ResumeVirusScanSetting> {
  return (await apiClient.patchJson<ResumeVirusScanSetting>('/admin/resume-virus-scan', { enabled })).data
}

export interface AiEnvSetting { value: string; configured: boolean; masked: boolean }

export type AiEnvSettings = Record<'OPENAI_BASE_URL' | 'OPENAI_API_KEY' | 'OPENAI_MODEL' | 'OPENAI_TIMEOUT_MS', AiEnvSetting>

export interface AiSettings {
  configured: boolean
  baseUrlHost: string
  model: string
  timeoutMs: number
  apiKeyConfigured: boolean
  missing: string[]
  env: AiEnvSettings
}

export interface AiConnectionTestResult {
  ok: boolean
  status?: number
  message: string
  latencyMs: number
  models: string[]
}

export async function getAiSettings(): Promise<AiSettings> {
  return (await apiClient.getJson<AiSettings>('/admin/ai-settings')).data
}

export interface AiConnectionTestInput { baseUrl?: string; apiKey?: string }

export async function testAiConnection(input: AiConnectionTestInput = {}): Promise<AiConnectionTestResult> {
  return (await apiClient.postJson<AiConnectionTestResult>('/admin/ai-connection-test', input)).data
}

export async function saveAiSettings(patch: Partial<Record<keyof AiEnvSettings, string>>): Promise<AiSettings> {
  return (await apiClient.patchJson<AiSettings>('/admin/ai-settings', patch)).data
}

export interface AiSharingSettings {
  enabled: boolean
  activeOrganizationCount: number
  sharedOrganizationCount: number
}

export async function getAiSharingSettings(): Promise<AiSharingSettings> {
  return (await apiClient.getJson<AiSharingSettings>('/admin/ai-sharing')).data
}

export async function updateAiSharingSettings(enabled: boolean): Promise<AiSharingSettings> {
  return (await apiClient.patchJson<AiSharingSettings>('/admin/ai-sharing', { enabled })).data
}

export type ChannelProvider = 'boss' | 'liepin' | '51job' | 'official_site'
export type ChannelEnvKey = string
export interface ChannelFieldDefinition {
  key: ChannelEnvKey
  connectionKey: 'enabled' | 'baseUrl' | 'appKey' | 'appSecret' | 'webhookToken' | 'signingSecret'
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
  help: string
}
export interface ChannelEnvSetting { value: string; configured: boolean; masked: boolean }
export interface ChannelSettingsView {
  id: ChannelProvider
  name: string
  description: string
  enabled: boolean
  configured: boolean
  missing: ChannelEnvKey[]
  values: Record<string, ChannelEnvSetting>
  fields: ChannelFieldDefinition[]
  capabilities: string[]
}
export type ChannelSettings = Record<ChannelProvider, ChannelSettingsView>
export interface ChannelOperationResult {
  status: 'ok' | 'not_configured' | 'not_implemented' | 'error'
  message: string
}

export async function getChannelSettings(): Promise<ChannelSettings> {
  return (await apiClient.getJson<ChannelSettings>('/admin/channel-settings')).data
}

export async function updateChannelSettings(patch: Record<string, string>): Promise<ChannelSettings> {
  return (await apiClient.patchJson<ChannelSettings>('/admin/channel-settings', patch)).data
}

export async function testChannelConnection(provider: ChannelProvider): Promise<ChannelOperationResult> {
  return (await apiClient.postJson<ChannelOperationResult>(`/admin/channel-connections/${provider}/test`, {})).data
}

export async function listFailedAnalysisTasks(): Promise<AdminAnalysisTask[]> {
  return (await apiClient.getJson<AdminAnalysisTask[]>('/admin/analysis-tasks?status=failed')).data
}

export async function listAdminAuditLogs(limit = 50): Promise<AdminAuditLog[]> {
  return (await apiClient.getJson<AdminAuditLog[]>(`/admin/audit-logs?limit=${encodeURIComponent(String(limit))}`)).data
}
