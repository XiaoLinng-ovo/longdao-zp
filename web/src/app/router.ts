import { createRouter, createWebHashHistory, createWebHistory, type Router } from 'vue-router'
import { authSession, refreshAuthSession } from '../modules/auth/session'
import { getPlatformLandingPath, isPlatformAdminRole } from '../modules/auth/platform-roles'
import { appRoutes } from './routes'
import { recruitmentRequestsEnabled } from '../shared/config/features'
import { loadRuntimeFeatures, runtimeFeatures } from '../shared/config/runtime-features'
import { navigationItems, getNavigationItemsForRole } from './navigation'

export { navigationItems, getNavigationItemsForRole }

export function installAuthGuard(router: Router): void {
  router.beforeEach(async (to) => {
    if (!authSession.ready) await refreshAuthSession()

    if (to.name === 'login' || to.name === 'register' || to.name === 'forgot-password') {
      if (to.name === 'login' && to.query.addAccount === '1') return true
      if (authSession.user) {
        const redirect = typeof to.query.redirect === 'string' && /^\/workspaces(?:[?#]|$)/.test(to.query.redirect) ? to.query.redirect : undefined
        const platformLandingPath = getPlatformLandingPath(authSession.user.platformRole)
        return redirect || (authSession.user.workspaceId ? { name: 'dashboard' } : platformLandingPath ?? { name: 'workspaces' })
      }
      return true
    }

    if (!authSession.user) return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
    await loadRuntimeFeatures(`${authSession.sessionId}:${authSession.user.id}`)
    // Preserve old bookmarks; the destination enforces system administrator access.
    if (to.name === 'enterprise-ai') return { name: 'administration', query: { module: 'ai' } }
    if (to.meta.systemAdminOnly && authSession.user.isSystemAdmin !== true) return { name: 'forbidden', query: { from: to.fullPath } }
    if (to.meta.platformOnly && !authSession.user.platformRole) return { name: 'forbidden', query: { from: to.fullPath } }
    if (to.meta.platformAdminOnly && !isPlatformAdminRole(authSession.user.platformRole)) return { name: 'forbidden', query: { from: to.fullPath } }
    if (!authSession.user.workspaceId && to.name !== 'workspaces' && to.name !== 'profile' && to.name !== 'forbidden' && !to.meta.platformOnly && !to.meta.systemAdminOnly && !to.meta.billingOnly) return { name: 'workspaces' }



    // Feature availability is separate from authorization; Offer approval is not gated here.
    if (to.meta.requiresRecruitmentRequests && !recruitmentRequestsEnabled) {
      return { name: 'jobs', query: { notice: 'recruitment-requests-disabled' }, replace: true }
    }
    if (to.meta.requiresRecruitmentReports && !runtimeFeatures.recruitmentReportsEnabled) {
      return { name: 'dashboard', query: { notice: 'recruitment-reports-disabled' }, replace: true }
    }

    if (to.meta.adminOnly && !isPlatformAdminRole(authSession.user.platformRole)) return { name: 'forbidden', query: { from: to.fullPath } }
    if (to.meta.workspaceAdminOnly) {
      const billingId = to.meta.billingOnly && typeof to.query.workspace === 'string' ? to.query.workspace : authSession.user?.workspaceId
      const workspaceRole = authSession.workspaces.find((workspace) => workspace.id === billingId)?.role
      if (workspaceRole !== 'owner' && workspaceRole !== 'admin') return { name: 'forbidden', query: { from: to.fullPath } }
    }
    const allowedRoles = to.meta.roles as string[] | undefined
    if (allowedRoles && !allowedRoles.includes(authSession.user.role)) return { name: 'forbidden', query: { from: to.fullPath } }
    return true
  })
}

export function createAppRouter() {
  const history = import.meta.env.VITE_ROUTER_MODE === 'hash' ? createWebHashHistory() : createWebHistory()
  return createRouter({ history, routes: appRoutes, scrollBehavior: () => ({ top: 0 }) })
}
