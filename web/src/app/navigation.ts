import { appRoutes } from './routes'
import type { RouteMeta } from './routes'

export interface NavigationItem extends RouteMeta {
  path: string
  name: string
}

export const navigationItems: NavigationItem[] = appRoutes
  .filter((route) => route.name !== 'not-found')
  .map((route) => ({
    path: route.path,
    name: String(route.name),
    ...route.meta,
  }))
