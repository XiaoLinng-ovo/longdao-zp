export type PlatformRole = 'admin' | 'viewer'

export const PLATFORM_ROLES: readonly PlatformRole[] = ['admin', 'viewer']

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && PLATFORM_ROLES.includes(value as PlatformRole)
}

export function isPlatformAdmin(role: PlatformRole | null | undefined): boolean {
  return role === 'admin'
}
