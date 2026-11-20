import type { RecruitingStoreState } from './types.js'

export interface ReportFilters { from?: string; to?: string; jobId?: string; channel?: string; status?: string }
export function reportChannel(source?: string): string {
  const value = source?.trim() ?? ''
  if (!value) return '未标注'
  if (/^resume-import(?::|$)/iu.test(value)) return '批量导入'
  const labels: Record<string, string> = { manual: '手动录入', referral: '内部推荐', website: '官网投递', import: '简历导入', boss: 'BOSS 直聘', liepin: '猎聘', zhilian: '智联招聘', lagou: '拉勾招聘' }
  return labels[value] ?? (/^[\w-]+:\S+$/u.test(value) ? '其他渠道' : value)
}
export function reportFilterOptions(state: RecruitingStoreState) {
  return {
    jobs: state.jobs.map(({ id, title }) => ({ id, title })),
    channels: [...new Set(state.applications.map((item) => reportChannel(item.source || state.candidates.find((candidate) => candidate.id === item.candidateId)?.source)))].sort(),
    statuses: [...new Set(state.applications.map((item) => item.status))].sort(),
  }
}
export function filterReportState(state: RecruitingStoreState, filters: ReportFilters): RecruitingStoreState {
  const boundary = (value: string | undefined, end = false) => {
    if (!value) return undefined
    const parsed = Date.parse(value + 'T00:00:00+08:00')
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(parsed) || new Date(parsed + 8 * 3600000).toISOString().slice(0, 10) !== value) throw new RangeError('请选择有效的统计日期')
    return parsed + (end ? 86400000 : 0)
  }
  const from = boundary(filters.from), to = boundary(filters.to, true)
  if (from !== undefined && to !== undefined && from >= to) throw new RangeError('结束日期不能早于开始日期')
  const applications = state.applications.filter((item) => {
    const applied = Date.parse(item.appliedAt)
    return (from === undefined || applied >= from) && (to === undefined || applied < to)
      && (!filters.jobId || item.jobId === filters.jobId) && (!filters.status || item.status === filters.status)
      && (!filters.channel || reportChannel(item.source || state.candidates.find((candidate) => candidate.id === item.candidateId)?.source) === filters.channel)
  })
  const ids = new Set(applications.map((item) => item.id))
  const interviews = state.interviews.filter((item) => ids.has(item.applicationId))
  const interviewIds = new Set(interviews.map((item) => item.id))
  return { ...state, applications, jobs: state.jobs.filter((job) => !filters.jobId || job.id === filters.jobId), interviews,
    interviewFeedback: state.interviewFeedback.filter((item) => interviewIds.has(item.interviewId)), offers: state.offers.filter((item) => ids.has(item.applicationId)) }
}
