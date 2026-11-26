import { apiClient } from '../../../shared/api'

export interface RecruitingReport {
  filterOptions?: { jobs: Array<{ id: string; title: string }>; channels: string[]; statuses: string[] }
  generatedAt: string
  summary: Array<{ label: string; value: number; detail: string }>
  funnel: Array<{ stage: string; count: number; conversionRate: number | null }>
  statusStats: Array<{ entity: string; status: string; count: number }>
  jobFilling: Array<{ jobId: string; code: string; title: string; headcount: number; filledCount: number; openCount: number; fillRate: number }>
  channels: Array<{ channel: string; applications: number; screened: number; interviewed: number; offers: number; hired: number; conversionRate: number }>
  recruitmentCycle: { averageDaysToHire: number | null; medianDaysToHire: number | null; hiredCount: number }
  feedbackCompletion: { expected: number; locked: number; completionRate: number | null }
  offerAcceptance: { sent: number; accepted: number; acceptanceRate: number | null }
}

export interface ReportFilters { from?: string; to?: string; jobId?: string; channel?: string; status?: string }
export async function loadReports(filters: ReportFilters = {}): Promise<RecruitingReport> {
  const query = new URLSearchParams(Object.entries(filters).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString()
  return (await apiClient.getJson<RecruitingReport>('/reports' + (query ? '?' + query : ''))).data
}
