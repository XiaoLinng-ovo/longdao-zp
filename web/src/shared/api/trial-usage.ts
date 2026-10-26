import { apiClient } from './client'

export interface TrialQuotaItem {
  used: number
  limit: number
  remaining: number
  reached: boolean
}

export interface TrialQuotaUsage {
  serviceStatus: 'enabled' | 'trial' | 'suspended'
  trialEndsAt: string | null
  enforced: boolean
  resumeUploads: TrialQuotaItem
  interviews: TrialQuotaItem
}

export async function loadTrialUsage(): Promise<TrialQuotaUsage> {
  return (await apiClient.getJson<TrialQuotaUsage>('/trial-usage')).data
}

export function notifyTrialQuotaChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('trial-quota-changed'))
}
