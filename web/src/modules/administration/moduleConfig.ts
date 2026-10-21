export const administrationModules = [
  { key: 'users', label: '用户与角色' },
  { key: 'departments', label: '部门管理' },
  { key: 'settings', label: '系统设置' },
  { key: 'ai', label: 'AI 模型配置' },
  { key: 'dingtalk', label: '钉钉集成配置' },
  { key: 'channels', label: '渠道集成配置' },
  { key: 'failed-tasks', label: '失败分析任务' },
  { key: 'audit-logs', label: '管理审计日志' },
  { key: 'health', label: '系统运行检查' },
  { key: 'workflow-audit', label: '流程审计记录' },
  { key: 'security', label: '安全提示' },
] as const

export type AdministrationModuleKey = typeof administrationModules[number]['key']

export function isAdministrationModuleKey(value: unknown): value is AdministrationModuleKey {
  return typeof value === 'string' && administrationModules.some((module) => module.key === value)
}

// Tenant AI, failed tasks and workflow history do not belong to global operations.
export const platformAdministrationModules = administrationModules.filter(item => !['ai', 'failed-tasks', 'workflow-audit'].includes(item.key))
