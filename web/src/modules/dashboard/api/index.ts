import { apiClient } from '../../../shared/api'
import type { Metric, Requisition } from '../../../shared/types/recruiting'

export interface DashboardTodo {
  id: string
  category: 'requisition' | 'job' | 'resume' | 'interview' | 'offer' | 'onboarding'
  title: string
  description: string
  actionLabel: string
  path: string
  updatedAt: string
}

interface DashboardSummaryContract {
  todos?: DashboardTodo[]
  generatedAt: string
  metrics: Array<{ label: string; value: number; detail: string }>
  funnel: Array<{ stage: string; count: number; conversionRate: number | null }>
  pendingApprovals: Array<{
    id: string
    code: string
    title: string
    department: string
    headcount: number
    status: string
    updatedAt: string
    approval?: { approver?: string }
  }>
  pendingFeedback: Array<{
    id: string
    code: string
    title: string
    round: number
    scheduledStartAt?: string
    status: string
    feedbackStatus: string
    candidateName: string
    jobTitle: string
  }>
  failedTasks: Array<{
    id: string
    resumeId: string
    status: string
    attempts: number
    lastError?: string
    availableAt: string
  }>
}

export interface DashboardData {
  todos: DashboardTodo[]
  metrics: Metric[]
  pending: Requisition[]
  funnel: Array<{ label: string; value: number; conversionRate: number | null }>
  pendingFeedback: DashboardSummaryContract['pendingFeedback']
  failedTasks: DashboardSummaryContract['failedTasks']
}

function toMetric(row: DashboardSummaryContract['metrics'][number], index: number, overallRate?: number): Metric {
  const tones: Metric['tone'][] = ['teal', 'blue', 'amber', 'red']
  return { label: row.label, value: row.value, trend: index > 0 && overallRate !== undefined ? `${overallRate}% 转化率` : row.detail, tone: tones[index % tones.length] }
}

function toRequisition(row: DashboardSummaryContract['pendingApprovals'][number]): Requisition {
  return {
    id: row.code || row.id,
    entityId: row.id,
    title: row.title,
    department: row.department,
    headcount: row.headcount,
    budget: '未设置',
    approver: row.approval?.approver || '待指定',
    status: row.status === 'pending_approval' ? 'pending' : row.status,
    updatedAt: row.updatedAt.slice(0, 10),
  }
}

export async function loadDashboard(): Promise<DashboardData> {
  const response = await apiClient.getJson<DashboardSummaryContract>('/dashboard/summary')
  const funnel = response.data.funnel.map((step) => ({ label: step.stage, value: step.count, conversionRate: step.conversionRate }))
  const total = funnel[0]?.value ?? 0
  const overallRate = (value: number): number => total > 0 ? Math.round(value / total * 10000) / 100 : 0
  return {
    todos: response.data.todos ?? [
      ...response.data.pendingApprovals.map((row): DashboardTodo => ({ id: `request-${row.id}`, category: 'requisition', title: row.title, description: `待审批 · ${row.department}`, actionLabel: '去审批', path: `/requisitions/${row.id}`, updatedAt: row.updatedAt })),
      ...response.data.pendingFeedback.map((row): DashboardTodo => ({ id: `feedback-${row.id}`, category: 'interview', title: `${row.candidateName}：待反馈面试`, description: `${row.jobTitle} · 第 ${row.round} 轮`, actionLabel: '去反馈', path: `/interviews/${row.id}`, updatedAt: row.scheduledStartAt ?? '' })),
      ...response.data.failedTasks.map((row): DashboardTodo => ({ id: `analysis-${row.id}`, category: 'resume', title: '简历分析任务待重试', description: row.lastError || '分析失败', actionLabel: '查看简历', path: '/candidates', updatedAt: row.availableAt })),
    ],
    metrics: response.data.metrics.map((row, index) => toMetric(row, index, index === 0 ? undefined : overallRate(funnel[index]?.value ?? 0))),
    pending: response.data.pendingApprovals.map(toRequisition),
    funnel,
    pendingFeedback: response.data.pendingFeedback,
    failedTasks: response.data.failedTasks,
  }
}
