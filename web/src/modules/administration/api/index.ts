import { apiClient } from '../../../shared/api'
import { loadWorkflowEvents as loadSharedWorkflowEvents } from '../../../shared/api/workflow-events'
import type { WorkflowEvent as SharedWorkflowEvent } from '../../../shared/api/workflow-events'

export type WorkflowEvent = SharedWorkflowEvent

export interface AdminCheckRow {
  category: string
  owner: string
  status: 'configured' | 'active' | 'paused' | 'failed'
  detail: string
}

interface ReadyPayload {
  status: string
  checks: Record<string, string>
}

interface HealthPayload {
  status: string
  service: string
  version: string
  uptimeSeconds: number
}

export async function listAdminChecks(): Promise<AdminCheckRow[]> {
  const [ready, health] = await Promise.all([
    apiClient.getJson<ReadyPayload>('/ready'),
    apiClient.getJson<HealthPayload>('/health'),
  ])
  const checks = ready.data.checks || {}
  const configState = ready.data.status === 'ready' ? 'configured' : 'failed'
  return [
    { category: '服务就绪', owner: '系统管理员', status: configState, detail: ready.data.status === 'ready' ? 'API 就绪检查通过' : 'API 就绪检查未通过' },
    { category: '配置检查', owner: '系统管理员', status: 'configured', detail: checks.configuration || '—' },
    { category: '服务健康', owner: '系统管理员', status: 'active', detail: health.data.service || '—' },
    { category: '服务版本', owner: '系统管理员', status: 'configured', detail: health.data.version || '—' },
    { category: '运行时长', owner: '系统管理员', status: 'configured', detail: `${Math.floor(health.data.uptimeSeconds || 0)} 秒` },
    { category: '审批与模型服务', owner: '系统管理员', status: 'paused', detail: '尚未接入外部模型配置源，当前由本地领域状态机驱动' },
    { category: '文件与审计', owner: '系统管理员', status: 'active', detail: '流程审计已接入本地 workflow-events 数据源' },
  ]
}

export async function loadWorkflowEvents(subjectType?: WorkflowEvent['subjectType'], limit = 50): Promise<WorkflowEvent[]> {
  return loadSharedWorkflowEvents(subjectType, limit)
}
