import type { WorkspaceSummary } from '../api'
export function workspaceServiceBadge(workspace: WorkspaceSummary): string {
  if (workspace.status === 'archived') return '已归档'
  if (workspace.serviceStatus === 'suspended') return '已暂停'
  if (workspace.serviceStatus === 'trial') return isWorkspaceAvailable(workspace) ? '试用中' : '试用已到期'
  if (workspace.serviceAvailable === false) return '暂不可用'
  if (workspace.serviceStatus === 'enabled') return '服务已开通'
  return '服务状态待确认'
}
export function isWorkspaceAvailable(workspace: WorkspaceSummary, now = Date.now()): boolean {
  return workspace.status === 'active' && workspace.serviceAvailable !== false && workspace.serviceStatus !== 'suspended' &&
    (workspace.serviceStatus !== 'trial' || Boolean(workspace.trialEndsAt && Date.parse(workspace.trialEndsAt) > now))
}
export function workspaceServiceLabel(workspace: WorkspaceSummary): string {
  if (workspace.status === 'archived') return '已归档'
  if (workspace.serviceStatus === 'suspended') return '服务已暂停'
  if (!isWorkspaceAvailable(workspace)) return workspace.serviceStatus === 'trial' ? '试用已到期' : '暂不可用'
  if (workspace.serviceStatus === 'trial') return `试用中 · 到期 ${new Date(workspace.trialEndsAt!).toLocaleDateString('zh-CN')}`
  return '可使用'
}
