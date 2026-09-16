import { appRoutes } from './routes'
import type { RouteMeta } from './routes'
import type { AuthRole } from '../modules/auth/api'

export interface NavigationItem extends RouteMeta {
  path: string
  name: string
}

export const navigationItems: NavigationItem[] = appRoutes
  .filter((route) => route.name !== 'not-found' && !route.path.includes('/:') && !route.meta.hideInNav)
  .map((route) => ({
    path: route.path,
    name: String(route.name),
    ...route.meta,
  }))

export function getNavigationItemsForRole(role: AuthRole | null | undefined): NavigationItem[] {
  return navigationItems.filter((item) => !item.adminOnly || role === 'admin' || role === 'hr_admin')
}
