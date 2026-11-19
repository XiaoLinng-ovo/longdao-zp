import { apiClient } from '../../../shared/api'

export type OperatorRole = 'admin' | 'viewer' | null
export interface OperatorAccount {
  id: string
  userNo: string
  displayName: string
  email: string
  isActive: boolean
  platformRole: OperatorRole
}
export interface OperatorDirectory {
  items: OperatorAccount[]
  total: number
  page: number
  pageSize: number
  recentAudit: Array<{ id: string; createdAt: string; actorName: string; targetEmail: string; reason: string; beforeRole: OperatorRole; afterRole: OperatorRole }>
}
export async function listPlatformOperators(query: { q: string; platformRole: string; page: number }): Promise<OperatorDirectory> {
  const params = new URLSearchParams({ page: String(query.page), pageSize: '20' })
  if (query.q.trim()) params.set('q', query.q.trim())
  if (query.platformRole) params.set('platformRole', query.platformRole)
  return (await apiClient.getJson<OperatorDirectory>(`/admin/platform-operators?${params}`)).data
}
export async function updatePlatformOperator(userId: string, input: { role: OperatorRole; expectedRole: OperatorRole; reason: string }) {
  return (await apiClient.patchJson<{ userId: string; platformRole: OperatorRole }>(`/admin/platform-operators/${encodeURIComponent(userId)}`, input)).data
}
