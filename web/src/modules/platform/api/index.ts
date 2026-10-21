import { apiClient } from '../../../shared/api'
import type { ServiceStatus, WorkspaceKind, WorkspaceStatus } from '../../auth/api'
export interface PlatformCustomer {
  id: string; name: string; kind: WorkspaceKind; status: WorkspaceStatus; serviceStatus: ServiceStatus
  trialEndsAt: string | null; serviceVersion: number; serviceAvailable: boolean; memberCount: number; createdAt: string
}
export interface CustomerPage { items: PlatformCustomer[]; total: number; page: number; pageSize: number }
export interface PlatformAudit { id: string; action: string; organizationName: string | null; createdAt: string; metadata: { reason?: string; after?: { serviceStatus: ServiceStatus; trialEndsAt?: string | null } } }
export async function listCustomers(search = '', serviceStatus = '', page = 1): Promise<CustomerPage> {
  return (await apiClient.getJson<CustomerPage>(`/platform/customers?${new URLSearchParams({ search, serviceStatus, page: String(page), pageSize: '20' })}`)).data
}
export async function updateCustomer(customer: PlatformCustomer, serviceStatus: ServiceStatus, trialEndsAt: string | null, reason: string): Promise<PlatformCustomer> {
  return (await apiClient.patchJson<PlatformCustomer>(`/platform/customers/${encodeURIComponent(customer.id)}/lifecycle`, { serviceStatus, trialEndsAt, reason, expectedVersion: customer.serviceVersion })).data
}
export async function listPlatformAudit(): Promise<PlatformAudit[]> {
  return (await apiClient.getJson<PlatformAudit[]>('/platform/audit-logs')).data
}
