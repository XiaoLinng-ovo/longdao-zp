import { createRouter, createWebHistory, type Router } from 'vue-router'
import { authSession, refreshAuthSession } from '../modules/auth/session'
import { appRoutes } from './routes'
import { recruitmentRequestsEnabled } from '../shared/config/features'
import { navigationItems, getNavigationItemsForRole } from './navigation'

export { navigationItems, getNavigationItemsForRole }

export function installAuthGuard(router: Router): void {
  router.beforeEach(async (to) => {
    if (!authSession.ready) await refreshAuthSession()

    if (to.name === 'login' || to.name === 'register') {
      if (to.name === 'login' && to.query.addAccount === '1') return true
      if (authSession.user) {
        const redirect = typeof to.query.redirect === 'string' && /^\/workspaces(?:[?#]|$)/.test(to.query.redirect) ? to.query.redirect : undefined
        return redirect || { name: authSession.user.workspaceId ? 'dashboard' : 'workspaces' }
      }
      return true
    }

    if (!authSession.user) return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
    // Legacy enterprise AI bookmarks redirect before platform-only authorization.
    // The destination still enforces enterprise owner/admin permissions.
    if (to.name === 'administration' && to.query.module === 'ai') return { name: 'enterprise-ai' }
    if (to.meta.platformOnly && !authSession.user.platformRole) return { name: 'forbidden', query: { from: to.fullPath } }
    if (to.meta.platformAdminOnly && authSession.user.platformRole !== 'admin') return { name: 'forbidden', query: { from: to.fullPath } }
    if (!authSession.user.workspaceId && to.name !== 'workspaces' && to.name !== 'forbidden' && !to.meta.platformOnly && !to.meta.billingOnly) return { name: 'workspaces' }



    // Feature availability is separate from authorization; Offer approval is not gated here.
    if (to.meta.requiresRecruitmentRequests && !recruitmentRequestsEnabled) {
      return { name: 'jobs', query: { notice: 'recruitment-requests-disabled' }, replace: true }
    }

    if (to.meta.adminOnly && !['admin', 'hr_admin'].includes(authSession.user.role)) return { name: 'forbidden', query: { from: to.fullPath } }
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
  return createRouter({ history: createWebHistory(), routes: appRoutes, scrollBehavior: () => ({ top: 0 }) })
}
