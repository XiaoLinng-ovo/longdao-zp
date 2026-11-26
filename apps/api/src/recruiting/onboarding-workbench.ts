import type {
  OnboardingIntegrationStatus,
  OnboardingMaterialRecord,
  OnboardingRecord,
  OnboardingReminderAudience,
  OnboardingReminderMilestone,
  OnboardingReport,
  OnboardingStatus,
  OnboardingTaskRecord,
  OnboardingWorkbenchItem,
  OnboardingIntegrationRecord,
  OnboardingReminderRecord,
} from './types.js'

export const onboardingCancellationReasons = [
  'candidate_declined',
  'offer_revoked',
  'schedule_changed',
  'position_closed',
  'failed_requirements',
  'other',
] as const

export const onboardingNoShowReasons = [
  'candidate_unreachable',
  'personal_reason',
  'another_offer',
  'document_issue',
  'attendance_issue',
  'other',
] as const

export const onboardingReasonLabels: Record<string, string> = {
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

export const onboardingStatuses: OnboardingStatus[] = ['pending', 'preparing', 'scheduled', 'completed', 'no_show', 'cancelled']
export const onboardingIntegrationStatuses: OnboardingIntegrationStatus[] = ['not_configured', 'pending', 'syncing', 'ready', 'failed']
export const onboardingReminderMilestones: OnboardingReminderMilestone[] = ['7_days', '3_days', 'day_of']
export const onboardingReminderAudiences: OnboardingReminderAudience[] = ['candidate', 'hr', 'manager', 'it', 'admin']

const activeStatuses = new Set<OnboardingStatus>(['pending', 'preparing', 'scheduled'])
const editableStatuses = new Set<OnboardingStatus>(['pending', 'preparing', 'scheduled', 'completed'])

export function isOnboardingEditable(status: OnboardingStatus): boolean {
  return editableStatuses.has(status)
}

export function missingSchedulingFields(record: OnboardingRecord): string[] {
  const fields: Array<[keyof OnboardingRecord, string]> = [
    ['plannedStartDate', '计划入职日期'],
    ['plannedStartTime', '计划报到时间'],
    ['reportingMode', '报到方式'],
    ['reportingLocation', '报到地点或线上链接'],
    ['reportingContactName', '报到联系人'],
    ['reportingContactPhone', '联系人电话'],
  ]
  return fields.filter(([key]) => !String(record[key] ?? '').trim()).map(([, label]) => label)
}

function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

function dateDayDifference(from: string, to: string): number {
  const fromDay = Date.parse(`${from}T00:00:00.000Z`)
  const toDay = Date.parse(`${to}T00:00:00.000Z`)
  return Math.ceil((fromDay - toDay) / 86_400_000)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function buildOnboardingWorkbenchItem(input: {
  onboarding: OnboardingRecord
  tasks: OnboardingTaskRecord[]
  materials: OnboardingMaterialRecord[]
  reminders: OnboardingReminderRecord[]
  integrations: OnboardingIntegrationRecord[]
  candidateName: string
  jobTitle: string
  offerCode: string
  department: string
  now?: Date
}): OnboardingWorkbenchItem {
  const now = input.now ?? new Date()
  const today = shanghaiDate(now)
  const requiredTasks = input.tasks.filter((task) => task.isRequired)
  const requiredMaterials = input.materials.filter((material) => material.isRequired)
  const requiredTasksRemaining = requiredTasks.filter((task) => !['completed', 'not_required'].includes(task.status)).length
  const requiredMaterialsRemaining = requiredMaterials.filter((material) => !['verified', 'waived'].includes(material.status)).length
  const requiredTotal = requiredTasks.length + requiredMaterials.length
  const completedTotal = requiredTotal - requiredTasksRemaining - requiredMaterialsRemaining
  const readiness = requiredTotal === 0 ? 100 : Math.round((completedTotal / requiredTotal) * 100)
  const overdueTasks = input.tasks.filter((task) => ['pending', 'in_progress', 'blocked'].includes(task.status) && Boolean(task.dueDate) && task.dueDate! < today).length
  const blockedTasks = input.tasks.filter((task) => task.status === 'blocked').length
  const nextDueDate = input.tasks
    .filter((task) => !['completed', 'not_required'].includes(task.status) && task.dueDate)
    .map((task) => task.dueDate!)
    .sort()[0]

  const highRiskReasons: string[] = []
  const active = activeStatuses.has(input.onboarding.status)
  const daysToStart = input.onboarding.plannedStartDate ? dateDayDifference(input.onboarding.plannedStartDate, today) : null
  if (active && !input.onboarding.plannedStartDate) highRiskReasons.push('尚未设置计划入职日期')
  if (active && (input.onboarding.status === 'scheduled' || (daysToStart !== null && daysToStart >= 0 && daysToStart <= 7))) {
    const missing = missingSchedulingFields(input.onboarding)
    if (missing.length) highRiskReasons.push(`报到信息不完整：${missing.join('、')}`)
  }
  if (overdueTasks) highRiskReasons.push(`${overdueTasks} 项任务已逾期`)
  if (blockedTasks) highRiskReasons.push(`${blockedTasks} 项任务被阻塞`)
  if (active && daysToStart !== null && daysToStart >= 0 && daysToStart <= 7 && requiredMaterialsRemaining) {
    highRiskReasons.push(`${requiredMaterialsRemaining} 项必交材料尚未核验`)
  }
  const failedIntegrations = input.integrations.filter((integration) => integration.status === 'failed')
  if (failedIntegrations.length) highRiskReasons.push(`${failedIntegrations.length} 项系统集成失败`)

  return {
    onboarding: input.onboarding,
    tasks: input.tasks,
    materials: input.materials,
    reminders: input.reminders,
    integrations: input.integrations,
    candidateName: input.candidateName,
    jobTitle: input.jobTitle,
    offerCode: input.offerCode,
    department: input.department,
    readiness,
    requiredTasksRemaining,
    overdueTasks,
    ...(nextDueDate ? { nextDueDate } : {}),
    highRiskReasons,
  }
}

function average(values: number[]): number | null {
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 10) / 10 : sorted[middle]!
}

export function buildOnboardingReport(items: OnboardingWorkbenchItem[]): OnboardingReport {
  const totals = Object.fromEntries([...onboardingStatuses.map((status) => [status, 0]), ['all', items.length]]) as Record<OnboardingStatus, number> & { all: number }
  for (const item of items) totals[item.onboarding.status]++

  const attended = totals.completed
  const arrivalDenominator = totals.completed + totals.no_show
  const arrivalRate = arrivalDenominator ? Math.round((attended / arrivalDenominator) * 1000) / 1000 : null
  const preparationDays = items
    .filter((item) => item.onboarding.status === 'completed' && (item.onboarding.actualArrivalAt || item.onboarding.archivedAt))
    .map((item) => (Date.parse(item.onboarding.actualArrivalAt || item.onboarding.archivedAt!) - Date.parse(item.onboarding.createdAt)) / 86_400_000)
    .filter((value) => Number.isFinite(value) && value >= 0)
  const completedRequiredTasks = items.flatMap((item) => item.tasks).filter((task) => task.isRequired && task.status === 'completed' && task.dueDate)
  const onTimeTasks = completedRequiredTasks.filter((task) => Boolean(task.completedAt) && Date.parse(task.completedAt!) <= Date.parse(`${task.dueDate}T23:59:59.999+08:00`))
  const reasonDistribution = new Map<string, number>()
  for (const item of items) {
    const code = item.onboarding.cancellationReasonCode || item.onboarding.noShowReasonCode
    if (code) reasonDistribution.set(code, (reasonDistribution.get(code) ?? 0) + 1)
  }
  const integrationStatus = Object.fromEntries(onboardingIntegrationStatuses.map((status) => [status, 0])) as Record<OnboardingIntegrationStatus, number>
  for (const integration of items.flatMap((item) => item.integrations)) integrationStatus[integration.status]++

  return {
    totals,
    arrivalRate,
    averagePreparationDays: average(preparationDays),
    medianPreparationDays: median(preparationDays),
    requiredTaskOnTimeRate: completedRequiredTasks.length ? Math.round((onTimeTasks.length / completedRequiredTasks.length) * 1000) / 1000 : null,
    overdueTasks: items.reduce((sum, item) => sum + item.overdueTasks, 0),
    blockedTasks: items.reduce((sum, item) => sum + item.tasks.filter((task) => task.status === 'blocked').length, 0),
    reasonDistribution: [...reasonDistribution.entries()].map(([code, count]) => ({ code, label: onboardingReasonLabels[code] ?? code, count })).sort((a, b) => b.count - a.count),
    integrationStatus,
    highRiskItems: items.filter((item) => item.highRiskReasons.length).map((item) => ({
      onboardingId: item.onboarding.id,
      applicationId: item.onboarding.applicationId,
      candidateName: item.candidateName,
      jobTitle: item.jobTitle,
      ...(item.onboarding.plannedStartDate ? { plannedStartDate: item.onboarding.plannedStartDate } : {}),
      reasons: item.highRiskReasons,
    })),
  }
}

export function buildOnboardingReminderSchedule(plannedStartDate: string): Array<{ milestone: OnboardingReminderMilestone; audience: OnboardingReminderAudience; scheduledAt: string }> {
  const start = Date.parse(`${plannedStartDate}T00:00:00.000Z`)
  if (!Number.isFinite(start)) throw new Error('plannedStartDate must be YYYY-MM-DD')
  const milestones: Array<[OnboardingReminderMilestone, number]> = [['7_days', 7], ['3_days', 3], ['day_of', 0]]
  return milestones.flatMap(([milestone, offset]) => {
    const date = new Date(start - offset * 86_400_000).toISOString().slice(0, 10)
    return onboardingReminderAudiences.map((audience) => ({ milestone, audience, scheduledAt: `${date}T09:00:00+08:00` }))
  })
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
}

export function isClockTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export { unique as uniqueOnboardingRisks }
