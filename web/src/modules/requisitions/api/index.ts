import { apiClient } from '../../../shared/api'
import type { Requisition } from '../../../shared/types/recruiting'

export interface ApprovalDetails {
  current: {
    id: string
    entityType: string
    entityId: string
    version: number
    status: string
    provider?: string
    externalInstanceId?: string
    completedAt?: string
    createdAt: string
    updatedAt: string
  } | null
  steps: Array<{
    id: string
    instanceId: string
    order: number
    name: string
    approverRole: string
    externalStepId?: string
    nodeName?: string
    status: string
    actedAt?: string
  }>
  records: Array<{
    id: string
    instanceId: string
    stepId: string
    actorId: string
    approver?: string
    action: 'approve' | 'reject' | 'progress'
    comment?: string
    createdAt: string
  }>
}

export interface ApiRequisition {
  id: string
  code: string
  title: string
  departmentId: string
  department: string
  requesterId: string
  requesterName?: string
  requesterEmail?: string
  headcount: number
  employmentType: string
  workMode: string
  location?: string
  salaryRange?: { min?: { amount: number; currency: string }; max?: { amount: number; currency: string } }
  justification: string
  status: string
  approval: { status: string; approver: string; provider?: string; externalInstanceId?: string; comment?: string; actedAt?: string }
  convertedJobIds: string[]
  version: number
  createdAt: string
  updatedAt: string
}

export interface ApiDepartment { id: string; code: string; name: string; isActive: boolean; createdAt?: string; updatedAt?: string }

export type RequisitionAction = 'submit' | 'approve' | 'reject' | 'withdraw' | 'close' | 'resubmit' | 'cancel' | 'convert'

export interface CreateRequisitionInput {
  title: string
  departmentId: string
  headcount: number
  employmentType: string
  workMode: string
  location?: string
  justification: string
  salaryRange?: ApiRequisition['salaryRange']
}

export interface RequisitionView {
  id: string
  entityId: string
  title: string
  department: string
  headcount: number
  approver: string
  status: string
  statusLabel: string
  updatedAt: string
  convertedJobIds: string[]
  location?: string
  budgetLabel?: string
  approvalStatus?: string
  approvalProvider?: string
  approvalExternalInstanceId?: string
}

const UI_STATUS: Record<string, Requisition['status']> = {
  pending_approval: 'pending',
}

function cleanSalaryRange(range?: ApiRequisition['salaryRange']): ApiRequisition['salaryRange'] | undefined {
  if (!range || typeof range !== 'object') return undefined
  const result: ApiRequisition['salaryRange'] = {}
  if (range.min && typeof range.min.amount === 'number' && typeof range.min.currency === 'string') result.min = { amount: range.min.amount, currency: range.min.currency }
  if (range.max && typeof range.max.amount === 'number' && typeof range.max.currency === 'string') result.max = { amount: range.max.amount, currency: range.max.currency }
  return Object.keys(result).length ? result : undefined
}

function formatSalary(range?: ApiRequisition['salaryRange']): string {
  if (!range) return '未设置'
  const min = range.min ? `${range.min.currency}${range.min.amount}` : undefined
  const max = range.max ? `${range.max.currency}${range.max.amount}` : undefined
  if (min && max) return `${min} - ${max}`
  if (min) return `${min}+`
  if (max) return `≤ ${max}`
  return '未设置'
}

function toViewModel(row: ApiRequisition): Requisition {
  return {
    id: row.code || row.id,
    entityId: row.id,
    title: row.title,
    department: row.department,
    headcount: row.headcount,
    budget: formatSalary(row.salaryRange),
    approver: row.approval?.approver || '待指定',
    status: UI_STATUS[row.status] ?? (row.status as Requisition['status']),
    updatedAt: (row.updatedAt || '').slice(0, 10),
  }
}

function toRow(row: ApiRequisition): RequisitionView {
  return {
    id: row.code || row.id,
    entityId: row.id,
    title: row.title,
    department: row.department,
    headcount: row.headcount,
    approver: row.approval?.approver || '待指定',
    status: row.status,
    statusLabel: row.status,
    updatedAt: (row.updatedAt || '').slice(0, 10),
    convertedJobIds: row.convertedJobIds || [],
    location: row.location,
    budgetLabel: formatSalary(row.salaryRange),
    approvalStatus: row.approval?.status,
    approvalProvider: row.approval?.provider,
    approvalExternalInstanceId: row.approval?.externalInstanceId,
  }
}

export async function loadRequisitions(): Promise<Requisition[]> {
  const response = await apiClient.getJson<ApiRequisition[]>('/recruitment-requests')
  return response.data.map(toViewModel)
}

export async function loadDepartments(): Promise<ApiDepartment[]> {
  return (await apiClient.getJson<ApiDepartment[]>('/departments')).data
}

export async function loadRequisitionRows(): Promise<RequisitionView[]> {
  const response = await apiClient.getJson<ApiRequisition[]>('/recruitment-requests')
  return response.data.map(toRow)
}

export async function getRequisition(id: string): Promise<ApiRequisition> {
  return (await apiClient.getJson<ApiRequisition>(`/recruitment-requests/${id}`)).data
}

export async function getRequisitionApproval(id: string): Promise<ApprovalDetails> {
  return (await apiClient.getJson<ApprovalDetails>(`/recruitment-requests/${id}/approval`)).data
}

export async function createRequisition(input: CreateRequisitionInput): Promise<ApiRequisition> {
  const payload: CreateRequisitionInput = {
    ...input,
    title: (input.title || '').trim(),
    departmentId: (input.departmentId || '').trim(),
    justification: (input.justification || '').trim(),
    salaryRange: cleanSalaryRange(input.salaryRange),
  }
  if (!payload.title || !payload.departmentId || !payload.justification) {
    throw new Error('招聘需求缺少必填字段')
  }
  return (await apiClient.postJson<ApiRequisition>('/recruitment-requests', payload)).data
}

export async function updateRequisition(id: string, input: Partial<CreateRequisitionInput>): Promise<ApiRequisition> {
  const payload: Partial<CreateRequisitionInput> = { ...input }
  if (typeof payload.title === 'string') payload.title = payload.title.trim()
  if (typeof payload.departmentId === 'string') payload.departmentId = payload.departmentId.trim()
  if (typeof payload.justification === 'string') payload.justification = payload.justification.trim()
  if (payload.salaryRange) payload.salaryRange = cleanSalaryRange(payload.salaryRange)
  return (await apiClient.patchJson<ApiRequisition>(`/recruitment-requests/${id}`, payload)).data
}

export async function actionRequisition(id: string, action: RequisitionAction, reason?: string): Promise<ApiRequisition> {
  const response = await apiClient.postJson<ApiRequisition>(`/recruitment-requests/${id}/${action}`, reason ? { reason } : {})
  return response.data
}
