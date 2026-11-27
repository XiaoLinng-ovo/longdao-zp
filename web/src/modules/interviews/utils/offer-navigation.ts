import type { Router } from 'vue-router'

export async function navigateToOffer(router: Router, applicationId: string): Promise<boolean> {
  try { return !await router.push({ path: '/offers', query: { createApplicationId: applicationId } }) }
  catch { return false }
}
