import { recruitmentRequestsEnabled } from '../shared/config/features'
import { appRoutes } from './routes'
import type { RouteMeta } from './routes'
import type { AuthRole, WorkspaceRole, PlatformRole } from '../modules/auth/api'

export interface NavigationItem extends RouteMeta {
  path: string
  name: string
}

const HIDDEN_NAV_PATHS = new Set(['/reports'])

export const navigationItems: NavigationItem[] = appRoutes
  .filter((route) => route.name !== 'not-found' && !route.path.includes('/:') && !route.meta.hideInNav && !HIDDEN_NAV_PATHS.has(route.path) && (recruitmentRequestsEnabled || !route.meta.requiresRecruitmentRequests))
  .map((route) => ({
    path: route.path,
    name: String(route.name),
    ...route.meta,
  }))

export function getNavigationItemsForRole(role: AuthRole | null | undefined, workspaceRole?: WorkspaceRole | null, platformRole?: PlatformRole | null): NavigationItem[] {
  return navigationItems.filter((item) => {
    if (item.platformOnly && !platformRole) return false
    if (item.platformAdminOnly && platformRole !== 'admin') return false
    if (item.adminOnly && role !== 'admin' && role !== 'hr_admin') return false
    if (item.workspaceAdminOnly && workspaceRole !== 'owner' && workspaceRole !== 'admin') return false
    return true
  })
}
