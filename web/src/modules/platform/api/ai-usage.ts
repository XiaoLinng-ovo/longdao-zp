import { apiClient } from '../../../shared/api'
export type UsageState = 'reserved' | 'settled' | 'released' | 'uncertain'
export type FailureCategory = 'upstream_rejected' | 'request_timeout' | 'network_error' | 'invalid_response' | 'generation_failed' | 'settlement_failed'
export interface UsageFilters { operation?: 'job_spec' | 'jd'; state?: UsageState; reviewOnly?: boolean; from?: string; to?: string }
export interface UsageItem {
 id: string; operation: 'job_spec' | 'jd'; model: string; state: UsageState; settledUnits: number; createdAt: string
 finishedAt: string | null; requestId: string | null; durationMs: number | null; failureCategory: FailureCategory | null
 needsReconciliation: boolean; reviewCount: number
}
export interface AiUsageReport {
 billingSource: 'customer_model'; chargeAmount: null; unit: 'successful_generation'; scope: string[]
 summary: { total: number; settled: number; released: number; reserved: number; reconciliation: number }
 items: UsageItem[]; page: number; pageSize: number; filteredTotal: number
}
export type ReviewOutcome = 'awaiting_provider' | 'awaiting_result' | 'evidence_recorded'
export interface ReviewNote { id: string; outcome: ReviewOutcome; note: string; createdAt: string; actorId: string }
export interface ReviewInput { key: string; outcome: ReviewOutcome; note: string }
export async function getAiUsage(page = 1, filters: UsageFilters = {}): Promise<AiUsageReport> {
 const query = new URLSearchParams({ page: String(page) })
 for (const [key, value] of Object.entries(filters)) if (value !== undefined) query.set(key, String(value))
 return (await apiClient.getJson<AiUsageReport>('/admin/ai-usage?' + query.toString())).data
}
export async function getUsageReviews(taskId: string) {
 return (await apiClient.getJson<{ items: ReviewNote[]; limit: number }>('/admin/ai-usage/' + encodeURIComponent(taskId) + '/reviews')).data
}
export async function addUsageReview(taskId: string, body: ReviewInput) {
 return (await apiClient.postJson<{ item: ReviewNote; replayed: boolean }, ReviewInput>('/admin/ai-usage/' + encodeURIComponent(taskId) + '/reviews', body)).data
}
