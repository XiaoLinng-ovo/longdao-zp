import { apiClient } from '../../../shared/api'

export interface RecruitingReport {
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

export async function loadReports(): Promise<RecruitingReport> {
  return (await apiClient.getJson<RecruitingReport>('/reports')).data
}
