import { createRouter, createWebHistory, type Router } from 'vue-router'
import { authSession, refreshAuthSession } from '../modules/auth/session'
import { appRoutes } from './routes'
import { navigationItems, getNavigationItemsForRole } from './navigation'

export { navigationItems, getNavigationItemsForRole }

export function installAuthGuard(router: Router): void {
  router.beforeEach(async (to) => {
    if (!authSession.ready) await refreshAuthSession()

    if (to.name === 'login') {
      if (authSession.user) return { name: 'dashboard' }
      return true
    }

    if (!authSession.user) return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }

    if (to.meta.adminOnly && !['admin', 'hr_admin'].includes(authSession.user.role)) return { name: 'dashboard' }
    const allowedRoles = to.meta.roles as string[] | undefined
    if (allowedRoles && !allowedRoles.includes(authSession.user.role)) return { name: 'dashboard' }
    return true
  })
}

export function createAppRouter() {
  return createRouter({ history: createWebHistory(), routes: appRoutes, scrollBehavior: () => ({ top: 0 }) })
}
