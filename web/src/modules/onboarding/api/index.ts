import { apiClient } from '../../../shared/api'

export type OnboardingStatus = 'pending' | 'preparing' | 'scheduled' | 'completed' | 'no_show' | 'cancelled'
export type OnboardingTaskCategory = 'hr' | 'it' | 'admin' | 'manager' | 'training' | 'candidate'
export type OnboardingTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'not_required'
export type OnboardingTaskOwnerRole = 'recruiter' | 'hiring_manager' | 'admin' | 'hr_admin' | 'candidate'
export type OnboardingMaterialStatus = 'pending' | 'collected' | 'verified' | 'waived'
export type OnboardingCancellationReason = 'candidate_declined' | 'offer_revoked' | 'schedule_changed' | 'position_closed' | 'failed_requirements' | 'other'
export type OnboardingNoShowReason = 'candidate_unreachable' | 'personal_reason' | 'another_offer' | 'document_issue' | 'attendance_issue' | 'other'
export type OnboardingReminderMilestone = '7_days' | '3_days' | 'day_of'
export type OnboardingReminderAudience = 'candidate' | 'hr' | 'manager' | 'it' | 'admin'
export type OnboardingReminderChannel = 'in_app' | 'email'
export type OnboardingReminderStatus = 'scheduled' | 'sent' | 'failed' | 'skipped'
export type OnboardingIntegrationProvider = 'oa' | 'it_service_desk' | 'access_control' | 'email_account' | 'hris'
export type OnboardingIntegrationStatus = 'not_configured' | 'pending' | 'syncing' | 'ready' | 'failed'

export interface ApiOnboarding {
  id: string
  applicationId: string
  offerId: string
  plannedStartDate?: string
  plannedStartTime?: string
  reportingMode?: 'onsite' | 'remote' | 'hybrid'
  reportingLocation?: string
  reportingContactName?: string
  reportingContactPhone?: string
  workCity?: string
  officeLocation?: string
  hrOwnerName?: string
  hiringManagerName?: string
  riskNotes?: string
  cancellationReasonCode?: OnboardingCancellationReason
  cancellationNotes?: string
  cancelledAt?: string
  noShowReasonCode?: OnboardingNoShowReason
  noShowNotes?: string
  noShowAt?: string
  actualArrivalAt?: string
  status: OnboardingStatus
  notes?: string
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

export interface ApiOnboardingTask {
  id: string
  onboardingId: string
  title: string
  category: OnboardingTaskCategory
  status: OnboardingTaskStatus
  isRequired: boolean
  ownerRole?: OnboardingTaskOwnerRole
  templateKey?: string
  ownerName?: string
  dueDate?: string
  notes?: string
  blockedReason?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
}

export interface ApiOnboardingMaterial {
  id: string
  onboardingId: string
  code: string
  label: string
  status: OnboardingMaterialStatus
  isRequired: boolean
  collectedAt?: string
  verifiedAt?: string
  verifiedByUserId?: string
  waivedAt?: string
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface ApiOnboardingReminder {
  id: string
  onboardingId: string
  milestone: OnboardingReminderMilestone
  audience: OnboardingReminderAudience
  channel: OnboardingReminderChannel
  status: OnboardingReminderStatus
  scheduledAt: string
  sentAt?: string
  failedAt?: string
  failureReason?: string
  createdAt: string
  updatedAt: string
}

export interface ApiOnboardingIntegration {
  id: string
  onboardingId: string
  provider: OnboardingIntegrationProvider
  status: OnboardingIntegrationStatus
  externalReference?: string
  lastAttemptAt?: string
  lastSuccessAt?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface ApiOnboardingWorkbenchItem {
  onboarding: ApiOnboarding
  tasks: ApiOnboardingTask[]
  materials: ApiOnboardingMaterial[]
  reminders: ApiOnboardingReminder[]
  integrations: ApiOnboardingIntegration[]
  candidateName: string
  jobTitle: string
  offerCode: string
  department: string
  readiness: number
  requiredTasksRemaining: number
  overdueTasks: number
  nextDueDate?: string
  highRiskReasons: string[]
}

export interface ApiOnboardingReport {
  totals: Record<OnboardingStatus, number> & { all: number }
  arrivalRate: number | null
  averagePreparationDays: number | null
  medianPreparationDays: number | null
  requiredTaskOnTimeRate: number | null
  overdueTasks: number
  blockedTasks: number
  reasonDistribution: Array<{ code: string; label: string; count: number }>
  integrationStatus: Record<OnboardingIntegrationStatus, number>
  highRiskItems: Array<{
    onboardingId: string
    applicationId: string
    candidateName: string
    jobTitle: string
    plannedStartDate?: string
    reasons: string[]
  }>
}

export type OnboardingAction = 'prepare' | 'schedule' | 'complete' | 'no_show' | 'cancel'
export type OnboardingActionPayload = {
  reasonCode?: OnboardingCancellationReason | OnboardingNoShowReason
  notes?: string
}

export interface UpdateOnboardingPayload {
  plannedStartDate?: string | null
  plannedStartTime?: string | null
  reportingMode?: ApiOnboarding['reportingMode'] | null
  reportingLocation?: string | null
  reportingContactName?: string | null
  reportingContactPhone?: string | null
  workCity?: string | null
  officeLocation?: string | null
  hrOwnerName?: string | null
  hiringManagerName?: string | null
  riskNotes?: string | null
  notes?: string | null
}

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  pending: '待准备',
  preparing: '准备中',
  scheduled: '待报到',
  completed: '已报到',
  no_show: '未报到',
  cancelled: '已取消',
}

export const ONBOARDING_TASK_CATEGORY_LABEL: Record<OnboardingTaskCategory, string> = {
  hr: 'HR',
  it: 'IT',
  admin: '行政',
  manager: '用人部门',
  training: '培训',
  candidate: '候选人',
}

export const ONBOARDING_TASK_STATUS_LABEL: Record<OnboardingTaskStatus, string> = {
  pending: '待处理',
  in_progress: '处理中',
  completed: '已完成',
  blocked: '已阻塞',
  not_required: '不适用',
}

export const ONBOARDING_MATERIAL_STATUS_LABEL: Record<OnboardingMaterialStatus, string> = {
  pending: '待采集',
  collected: '待核验',
  verified: '已核验',
  waived: '已豁免',
}

export const ONBOARDING_REMINDER_STATUS_LABEL: Record<OnboardingReminderStatus, string> = {
  scheduled: '待发送',
  sent: '已发送',
  failed: '发送失败',
  skipped: '已跳过',
}

export const ONBOARDING_INTEGRATION_STATUS_LABEL: Record<OnboardingIntegrationStatus, string> = {
  not_configured: '未配置',
  pending: '待同步',
  syncing: '同步中',
  ready: '已就绪',
  failed: '同步失败',
}

export const ONBOARDING_INTEGRATION_PROVIDER_LABEL: Record<OnboardingIntegrationProvider, string> = {
  oa: 'OA 账号',
  it_service_desk: 'IT 服务台',
  access_control: '门禁权限',
  email_account: '企业邮箱',
  hris: 'HRIS 档案',
}

export const ONBOARDING_REMINDER_MILESTONE_LABEL: Record<OnboardingReminderMilestone, string> = {
  '7_days': '报到前 7 天',
  '3_days': '报到前 3 天',
  day_of: '报到当天',
}

export const ONBOARDING_REMINDER_AUDIENCE_LABEL: Record<OnboardingReminderAudience, string> = {
  candidate: '候选人',
  hr: 'HR',
  manager: '用人部门',
  it: 'IT',
  admin: '行政',
}

export const ONBOARDING_ACTION_LABEL: Record<OnboardingAction, string> = {
  prepare: '开始准备',
  schedule: '确认报到安排',
  complete: '确认已报到',
  no_show: '登记未报到',
  cancel: '取消入职',
}

export const ONBOARDING_REASON_LABEL: Record<string, string> = {
  candidate_declined: '候选人放弃',
  offer_revoked: 'Offer 撤回',
  schedule_changed: '报到时间调整',
  position_closed: '岗位关闭',
  failed_requirements: '条件不符',
  candidate_unreachable: '无法联系候选人',
  personal_reason: '个人原因',
  another_offer: '接受其他 Offer',
  document_issue: '材料问题',
  attendance_issue: '报到异常',
  other: '其他原因',
}

export const ONBOARDING_CANCELLATION_REASONS: Array<{ value: OnboardingCancellationReason; label: string }> = [
  { value: 'candidate_declined', label: ONBOARDING_REASON_LABEL.candidate_declined! },
  { value: 'offer_revoked', label: ONBOARDING_REASON_LABEL.offer_revoked! },
  { value: 'schedule_changed', label: ONBOARDING_REASON_LABEL.schedule_changed! },
  { value: 'position_closed', label: ONBOARDING_REASON_LABEL.position_closed! },
  { value: 'failed_requirements', label: ONBOARDING_REASON_LABEL.failed_requirements! },
  { value: 'other', label: ONBOARDING_REASON_LABEL.other! },
]

export const ONBOARDING_NO_SHOW_REASONS: Array<{ value: OnboardingNoShowReason; label: string }> = [
  { value: 'candidate_unreachable', label: ONBOARDING_REASON_LABEL.candidate_unreachable! },
  { value: 'personal_reason', label: ONBOARDING_REASON_LABEL.personal_reason! },
  { value: 'another_offer', label: ONBOARDING_REASON_LABEL.another_offer! },
  { value: 'document_issue', label: ONBOARDING_REASON_LABEL.document_issue! },
  { value: 'attendance_issue', label: ONBOARDING_REASON_LABEL.attendance_issue! },
  { value: 'other', label: ONBOARDING_REASON_LABEL.other! },
]

export async function listOnboarding(): Promise<ApiOnboarding[]> {
  return (await apiClient.getJson<ApiOnboarding[]>('/onboarding')).data
}

export async function listOnboardingWorkbench(): Promise<ApiOnboardingWorkbenchItem[]> {
  return (await apiClient.getJson<ApiOnboardingWorkbenchItem[]>('/onboarding/workbench')).data
}

export async function getOnboardingReport(): Promise<ApiOnboardingReport> {
  return (await apiClient.getJson<ApiOnboardingReport>('/onboarding/reports')).data
}

export async function getOnboarding(id: string): Promise<ApiOnboarding> {
  return (await apiClient.getJson<ApiOnboarding>(`/onboarding/${id}`)).data
}

export async function updateOnboarding(id: string, payload: UpdateOnboardingPayload): Promise<ApiOnboarding> {
  return (await apiClient.patchJson<ApiOnboarding>(`/onboarding/${id}`, payload)).data
}

export async function listOnboardingTasks(id: string): Promise<ApiOnboardingTask[]> {
  return (await apiClient.getJson<ApiOnboardingTask[]>(`/onboarding/${id}/tasks`)).data
}

export async function createOnboardingTask(
  id: string,
  payload: Pick<ApiOnboardingTask, 'title' | 'category'> & Partial<Pick<ApiOnboardingTask, 'isRequired' | 'ownerRole' | 'ownerName' | 'dueDate' | 'notes'>>,
): Promise<ApiOnboardingTask> {
  return (await apiClient.postJson<ApiOnboardingTask>(`/onboarding/${id}/tasks`, payload)).data
}

export async function updateOnboardingTask(
  onboardingId: string,
  taskId: string,
  payload: Partial<Pick<ApiOnboardingTask, 'title' | 'category' | 'status' | 'isRequired' | 'ownerRole' | 'ownerName' | 'dueDate' | 'notes' | 'blockedReason'>>,
): Promise<ApiOnboardingTask> {
  return (await apiClient.patchJson<ApiOnboardingTask>(`/onboarding/${onboardingId}/tasks/${taskId}`, payload)).data
}

export async function listOnboardingMaterials(id: string): Promise<ApiOnboardingMaterial[]> {
  return (await apiClient.getJson<ApiOnboardingMaterial[]>(`/onboarding/${id}/materials`)).data
}

export async function createOnboardingMaterial(
  id: string,
  payload: Pick<ApiOnboardingMaterial, 'code' | 'label'> & Partial<Pick<ApiOnboardingMaterial, 'isRequired' | 'notes'>>,
): Promise<ApiOnboardingMaterial> {
  return (await apiClient.postJson<ApiOnboardingMaterial>(`/onboarding/${id}/materials`, payload)).data
}

export async function updateOnboardingMaterial(
  onboardingId: string,
  materialId: string,
  payload: Partial<Pick<ApiOnboardingMaterial, 'status' | 'isRequired' | 'notes'>>,
): Promise<ApiOnboardingMaterial> {
  return (await apiClient.patchJson<ApiOnboardingMaterial>(`/onboarding/${onboardingId}/materials/${materialId}`, payload)).data
}

export async function listOnboardingReminders(id: string): Promise<ApiOnboardingReminder[]> {
  return (await apiClient.getJson<ApiOnboardingReminder[]>(`/onboarding/${id}/reminders`)).data
}

export async function refreshOnboardingReminders(id: string): Promise<ApiOnboardingReminder[]> {
  return (await apiClient.postJson<ApiOnboardingReminder[]>(`/onboarding/${id}/reminders/refresh`, {})).data
}

export async function listOnboardingIntegrations(id: string): Promise<ApiOnboardingIntegration[]> {
  return (await apiClient.getJson<ApiOnboardingIntegration[]>(`/onboarding/${id}/integrations`)).data
}

export async function updateOnboardingIntegration(
  onboardingId: string,
  integrationId: string,
  payload: Partial<Pick<ApiOnboardingIntegration, 'status' | 'externalReference' | 'lastError'>>,
): Promise<ApiOnboardingIntegration> {
  return (await apiClient.patchJson<ApiOnboardingIntegration>(`/onboarding/${onboardingId}/integrations/${integrationId}`, payload)).data
}

export async function actionOnboarding(id: string, action: OnboardingAction, payload: OnboardingActionPayload = {}): Promise<ApiOnboarding> {
  return (await apiClient.postJson<ApiOnboarding>(`/onboarding/${id}/${action}`, payload)).data
}
