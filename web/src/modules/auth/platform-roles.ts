import type { PlatformRole } from './api'

export function isPlatformAdminRole(role: PlatformRole | null | undefined): role is 'admin' {
  return role === 'admin'
}

export function getPlatformLandingPath(role: PlatformRole | null | undefined): string | undefined {
  return role ? '/platform/customers' : undefined
}
