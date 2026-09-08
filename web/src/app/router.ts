import { createRouter, createWebHistory } from 'vue-router'
import { appRoutes } from './routes'
import { navigationItems } from './navigation'

export { navigationItems }

export function createAppRouter() {
  return createRouter({ history: createWebHistory(), routes: appRoutes, scrollBehavior: () => ({ top: 0 }) })
}
