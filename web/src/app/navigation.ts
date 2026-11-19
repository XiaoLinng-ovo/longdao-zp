import { recruitmentReportsEnabled, recruitmentRequestsEnabled } from '../shared/config/features'
import { runtimeFeatures } from '../shared/config/runtime-features'
import { appRoutes } from './routes'
import type { RouteMeta } from './routes'
import type { AuthRole, WorkspaceRole, PlatformRole } from '../modules/auth/api'

export interface NavigationItem extends RouteMeta {
  path: string
  name: string
}

const allNavigationItems: NavigationItem[] = appRoutes.filter((route) =>
  route.name !== 'not-found' && !route.path.includes('/:') && !route.meta.hideInNav,
)
  .map((route) => ({
    path: route.path,
    name: String(route.name),
    ...route.meta,
  }))

// 保留构建期列表供旧的静态检查使用；运行中的侧边栏使用下面的动态过滤结果。
export const navigationItems: NavigationItem[] = allNavigationItems
  .filter((route) => (recruitmentRequestsEnabled || !route.requiresRecruitmentRequests)
    && (recruitmentReportsEnabled || !route.requiresRecruitmentReports))

export function getNavigationItemsForRole(role: AuthRole | null | undefined, workspaceRole?: WorkspaceRole | null, platformRole?: PlatformRole | null, isSystemAdmin = false, hasActiveMembership = workspaceRole != null): NavigationItem[] {
  return allNavigationItems.filter((item) => {
    if (item.requiresRecruitmentRequests && !recruitmentRequestsEnabled) return false
    if (item.requiresRecruitmentReports && !runtimeFeatures.recruitmentReportsEnabled) return false
    if (item.systemAdminOnly && !isSystemAdmin) return false
    if (item.billingOnly && !hasActiveMembership) return false
    if ((item.platformOnly || item.platformAdminOnly || item.adminOnly) && !isSystemAdmin) return false
    if (item.workspaceAdminOnly && !hasActiveMembership) return false
    return true
  })
}
