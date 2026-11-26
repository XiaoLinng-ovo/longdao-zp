import { apiClient } from '../../../shared/api'
import type { Metric, Requisition } from '../../../shared/types/recruiting'

export interface DashboardTodo {
  id: string
  category: 'requisition' | 'job' | 'resume' | 'interview' | 'offer' | 'onboarding' | 'membership'
  actionKey?: 'confirm-job-spec' | 'confirm-job-jd' | 'publish-job'
  title: string
  description: string
  actionLabel: string
  path: string
  updatedAt: string
}

export interface DashboardPeriod { from: string; to: string; timeZone: string }
export interface ActivityCounts { resumes: number; applications: number; screened: number; interviews: number; offers: number; onboarded: number }
export interface DashboardActivity {
  period: DashboardPeriod
  previousPeriod: DashboardPeriod
  counts: ActivityCounts
  previousCounts: ActivityCounts
  granularity: 'day' | 'month'
  series: Array<ActivityCounts & { date: string }>
}

interface DashboardSummaryContract {
  activity?: DashboardActivity
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
  pendingInterviews: Array<{
    id: string
    code: string
    title: string
    round: number
    scheduledStartAt?: string
    status: string
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
  activity?: DashboardActivity
  todos: DashboardTodo[]
  metrics: Metric[]
  pending: Requisition[]
  funnel: Array<{ label: string; value: number; conversionRate: number | null }>
  pendingInterviews: DashboardSummaryContract['pendingInterviews']
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

export async function loadDashboard(period?: DashboardPeriod, scope: 'mine' | 'enterprise' | 'unassigned' = 'mine'): Promise<DashboardData> {
  const query = '?' + new URLSearchParams({ ...(period ?? {}), scope }).toString()
  const response = await apiClient.getJson<DashboardSummaryContract>('/dashboard/summary' + query)
  const funnel = response.data.funnel.map((step) => ({ label: step.stage, value: step.count, conversionRate: step.conversionRate }))
  const total = funnel[0]?.value ?? 0
  const overallRate = (value: number): number => total > 0 ? Math.round(value / total * 10000) / 100 : 0
  return {
    ...(response.data.activity ? { activity: response.data.activity } : {}),
    todos: response.data.todos ?? [
      ...response.data.pendingInterviews.map((row): DashboardTodo => ({ id: `complete-${row.id}`, category: 'interview', title: '面试待完成', description: `${row.candidateName} · ${row.jobTitle} · 第 ${row.round} 轮`, actionLabel: '去完成', path: `/interviews/${row.id}`, updatedAt: row.scheduledStartAt ?? '' })),
      ...response.data.failedTasks.map((row): DashboardTodo => ({ id: `analysis-${row.id}`, category: 'resume', title: '简历分析任务待重试', description: row.lastError || '分析失败', actionLabel: '查看简历', path: '/candidates', updatedAt: row.availableAt })),
    ],
    metrics: response.data.metrics.map((row, index) => {
      if (!response.data.activity) return toMetric(row, index, index === 0 ? undefined : overallRate(funnel[index]?.value ?? 0))
      const key = (['resumes', 'screened', 'interviews', 'offers'] as const)[index]
      const delta = key ? response.data.activity.counts[key] - response.data.activity.previousCounts[key] : 0
      return { ...toMetric(row, index), trend: '较前段 ' + (delta > 0 ? '+' : '') + delta }
    }),
    pending: response.data.pendingApprovals.map(toRequisition),
    funnel,
    pendingInterviews: response.data.pendingInterviews,
    failedTasks: response.data.failedTasks,
  }
}
