type Subscription = Record<string, any>

function quotaSignature(value: Subscription | undefined): string {
  return JSON.stringify([
    value?.quotas?.ai_points ?? 0, value?.quotas?.interview_seconds ?? 0,
    value?.quotas?.ocr_pages ?? 0, value?.grantPeriod ?? 'once', value?.rollover ?? false,
  ])
}

export function isSubscriptionRenewal(current: Subscription | undefined, next: Subscription, legacyPlanId?: string): boolean {
  if (next.billing_kind === 'addon') return false
  if (!current) return Boolean(legacyPlanId && legacyPlanId === next.plan_version_id)
  const sameIdentity = current.plan_version_id === next.plan_version_id ||
    Boolean(current.catalog_id && current.catalog_id === next.catalog_id)
  return sameIdentity && current.seat_limit === next.seat_limit && current.job_limit === next.job_limit &&
    Boolean(current.all_modules) === Boolean(next.all_modules) &&
    quotaSignature(current.billing_entitlements) === quotaSignature(next.billing_entitlements)
}
