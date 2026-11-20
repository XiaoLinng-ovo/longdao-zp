import { createRouter, createWebHashHistory, createWebHistory, type Router } from 'vue-router'
import { authSession, refreshAuthSession } from '../modules/auth/session'
import { safeAuthRedirect } from '../modules/auth/utils/redirect'
import { getPlatformLandingPath } from '../modules/auth/platform-roles'
import { appRoutes } from './routes'
import { recruitmentRequestsEnabled } from '../shared/config/features'
import { loadRuntimeFeatures, runtimeFeatures } from '../shared/config/runtime-features'
import { navigationItems, getNavigationItemsForRole } from './navigation'
import { nextTick } from 'vue'

export { navigationItems, getNavigationItemsForRole }

export function installAuthGuard(router: Router): void {
  router.beforeEach(async (to) => {
    if (!authSession.ready) await refreshAuthSession()
    if (authSession.error && !authSession.user) return false

    if (to.name === 'login' || to.name === 'register' || to.name === 'forgot-password') {
      if (to.name === 'login' && to.query.addAccount === '1') return true
      if (authSession.user) {
        const redirect = safeAuthRedirect(to.query.redirect)
        const platformLandingPath = authSession.user.isSystemAdmin ? getPlatformLandingPath('admin') : undefined
        return redirect || (authSession.user.workspaceId ? { name: 'dashboard' } : platformLandingPath ?? { name: 'workspaces' })
      }
      return true
    }

    if (!authSession.user) return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
    await loadRuntimeFeatures(`${authSession.sessionId}:${authSession.user.id}`)
    if (to.name === 'enterprise-ai' && authSession.user.isSystemAdmin === true) return { name: 'administration', query: { module: 'ai' } }
    if (to.meta.systemAdminOnly && authSession.user.isSystemAdmin !== true) return { name: 'forbidden', query: { from: to.fullPath } }
    if ((to.meta.platformOnly || to.meta.platformAdminOnly) && authSession.user.isSystemAdmin !== true) return { name: 'forbidden', query: { from: to.fullPath } }
    if (!authSession.user.workspaceId && to.name !== 'workspaces' && to.name !== 'profile' && to.name !== 'forbidden' && !to.meta.platformOnly && !to.meta.systemAdminOnly && !to.meta.billingOnly) return { name: 'workspaces', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
    if (to.meta.billingOnly) {
      const workspaceId = typeof to.query.workspace === 'string' ? to.query.workspace : authSession.user.workspaceId
      if (!authSession.workspaces.some(workspace => workspace.id === workspaceId && workspace.status === 'active' && ['owner','admin'].includes(workspace.role))) return { name: 'forbidden', query: { from: to.fullPath } }
    }



    // Feature availability is separate from authorization; Offer approval is not gated here.
    if (to.meta.requiresRecruitmentRequests && !recruitmentRequestsEnabled) {
      return { name: 'jobs', query: { notice: 'recruitment-requests-disabled' }, replace: true }
    }
    if (to.meta.requiresRecruitmentReports && !runtimeFeatures.recruitmentReportsEnabled) {
      return { name: 'dashboard', query: { notice: 'recruitment-reports-disabled' }, replace: true }
    }

    if (to.meta.adminOnly && authSession.user.isSystemAdmin !== true) return { name: 'forbidden', query: { from: to.fullPath } }
    if (to.meta.workspaceAdminOnly) {
      const billingId = to.meta.billingOnly && typeof to.query.workspace === 'string' ? to.query.workspace : authSession.user?.workspaceId
      const workspaceRole = authSession.workspaces.find((workspace) => workspace.id === billingId)?.role
      if (!workspaceRole || !['owner','admin'].includes(workspaceRole)) return { name: 'forbidden', query: { from: to.fullPath } }
    }
    const allowedRoles = to.meta.roles as string[] | undefined
    if (allowedRoles && !allowedRoles.includes(authSession.user.role)) return { name: 'forbidden', query: { from: to.fullPath } }
    return true
  })
}

export function createAppRouter() {
  const history = import.meta.env.VITE_ROUTER_MODE === 'hash' ? createWebHashHistory() : createWebHistory()
  return createRouter({ history, routes: appRoutes, scrollBehavior: async (_to, _from, savedPosition) => {
    await nextTick()
    return savedPosition ?? { top: 0 }
  } })
}
