import { createRouter, createWebHistory, type Router } from 'vue-router'
import { authSession, refreshAuthSession } from '../modules/auth/session'
import { appRoutes } from './routes'
import { navigationItems } from './navigation'

export { navigationItems }

export function installAuthGuard(router: Router): void {
  router.beforeEach(async (to) => {
    if (!authSession.ready) await refreshAuthSession()

    if (to.name === 'login') {
      if (authSession.user) return { name: 'dashboard' }
      return true
    }

    if (!authSession.user) return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }

    if (to.meta.adminOnly && !['admin', 'hr_admin'].includes(authSession.user.role)) return { name: 'dashboard' }
    return true
  })
}

export function createAppRouter() {
  return createRouter({ history: createWebHistory(), routes: appRoutes, scrollBehavior: () => ({ top: 0 }) })
}
