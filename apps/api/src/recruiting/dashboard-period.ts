import type { RecruitingStoreState } from './types.js'
import { RecruitingWorkflowError } from './workflow.js'

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

const empty = (): ActivityCounts => ({ resumes: 0, applications: 0, screened: 0, interviews: 0, offers: 0, onboarded: 0 })
const invalid = (message: string): never => { throw new RecruitingWorkflowError('VALIDATION_ERROR', message, 400) }
export function parseDashboardPeriod(input: { from?: unknown; to?: unknown; timeZone?: unknown }): DashboardPeriod | undefined {
  if (input.from === undefined && input.to === undefined) return undefined
  const parse = (value: unknown) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid('请提供带时区的开始和结束时间')
    const time = Date.parse(value as string)
    if (!Number.isFinite(time)) invalid('日期时间无效')
    const calendar = (value as string).slice(0, 10)
    if (new Date(calendar + 'T00:00:00Z').toISOString().slice(0, 10) !== calendar) invalid('日期无效')
    return time
  }
  const from = parse(input.from), to = parse(input.to)
  if (from >= to) invalid('结束时间必须晚于开始时间')
  if (to - from > 3660 * 86400000) invalid('时间跨度不能超过十年')
  const timeZone = input.timeZone === undefined ? 'Asia/Shanghai' : String(input.timeZone)
  try { new Intl.DateTimeFormat('en', { timeZone }).format() } catch { invalid('统计时区无效') }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), timeZone }
}

export function withinPeriod(value: string | undefined, period: DashboardPeriod): boolean {
  const time = Date.parse(value ?? '')
  return Number.isFinite(time) && time >= Date.parse(period.from) && time < Date.parse(period.to)
}

export function dashboardActivity(state: RecruitingStoreState, period: DashboardPeriod): DashboardActivity {
  const from = Date.parse(period.from), to = Date.parse(period.to)
  const previousPeriod = { ...period, from: new Date(from - (to - from)).toISOString(), to: period.from }
  const granularity = to - from <= 93 * 86400000 ? 'day' : 'month'
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: period.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const dateKey = (time: number) => {
    const parts = formatter.formatToParts(time)
    const value = (type: string) => parts.find(part => part.type === type)!.value
    return value('year') + '-' + value('month') + (granularity === 'day' ? '-' + value('day') : '')
  }
  const series = new Map<string, ActivityCounts & { date: string }>()
  const first = dateKey(from), last = dateKey(to - 1)
  const cursor = new Date(first + (granularity === 'day' ? '' : '-01') + 'T00:00:00Z')
  while (true) {
    const date = cursor.toISOString().slice(0, granularity === 'day' ? 10 : 7)
    if (date > last) break
    series.set(date, { date, ...empty() })
    if (granularity === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1)
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  const counts = empty(), previousCounts = empty()
  const add = (kind: keyof ActivityCounts, value: string | undefined) => {
    const time = Date.parse(value ?? '')
    if (!Number.isFinite(time)) return
    if (time >= from && time < to) { counts[kind]++; series.get(dateKey(time))![kind]++ }
    else if (time >= Date.parse(previousPeriod.from) && time < from) previousCounts[kind]++
  }
  const applicationIds = new Set(state.applications.map(row => row.id))
  const screened = new Map<string, string>(), interviews = new Map<string, string>()
  const earliest = (map: Map<string, string>, id: string, time: string) => {
    if (applicationIds.has(id) && Number.isFinite(Date.parse(time)) && (!map.has(id) || Date.parse(time) < Date.parse(map.get(id)!))) map.set(id, time)
  }
  for (const event of state.workflowEvents) {
    if (event.subjectType !== 'application') continue
    if (event.toStatus === 'interviewing' && event.fromStatus !== 'interviewing' && ['pending_analysis', 'analysis_queued', 'human_review', 'new'].includes(event.fromStatus ?? '')) {
      earliest(screened, event.subjectId, event.createdAt)
      earliest(interviews, event.subjectId, event.createdAt)
    }
  }
  // Use the recorded first interview creation only when older imports lack a transition event.
  const firstInterviews = new Map<string, string>()
  for (const row of state.interviews) earliest(firstInterviews, row.applicationId, row.createdAt)
  for (const [id, time] of firstInterviews) {
    if (!interviews.has(id)) earliest(interviews, id, time)
    if (!screened.has(id)) earliest(screened, id, time)
  }
  for (const row of state.resumes) add('resumes', row.createdAt)
  for (const row of state.applications) add('applications', row.appliedAt)
  for (const time of screened.values()) add('screened', time)
  for (const time of interviews.values()) add('interviews', time)
  const sent = new Map<string, string>(), onboarded = new Map<string, string>()
  for (const row of state.offers) if (row.sentAt) earliest(sent, row.applicationId, row.sentAt)
  for (const row of state.onboarding) if (row.archivedAt) earliest(onboarded, row.applicationId, row.archivedAt)
  for (const event of state.workflowEvents) {
    if (event.subjectType === 'offer' && (event.action === 'send' || event.toStatus === 'sent')) {
      const row = state.offers.find(row => row.id === event.subjectId)
      if (row) earliest(sent, row.applicationId, event.createdAt)
    }
    if (event.subjectType === 'application' && event.toStatus === 'onboarding_archived') earliest(onboarded, event.subjectId, event.createdAt)
  }
  for (const time of sent.values()) add('offers', time)
  for (const time of onboarded.values()) add('onboarded', time)
  return { period, previousPeriod, counts, previousCounts, granularity, series: [...series.values()] }
}
