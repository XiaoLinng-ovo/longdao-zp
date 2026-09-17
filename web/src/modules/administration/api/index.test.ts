import { describe, expect, it, vi } from 'vitest'
import { listAdminChecks, loadWorkflowEvents, listAdminUsers, listAdminRoles, getAdminSettings, updateAdminSettings, listFailedAnalysisTasks, listAdminAuditLogs } from './index'
import { apiClient } from '../../../shared/api'

vi.mock('../../../shared/api', () => ({ apiClient: { getJson: vi.fn() } }))
const getJson = vi.mocked(apiClient.getJson)

describe('管理后台 API', () => {
  it('加载管理用户、角色、设置、失败任务和审计日志', async () => {
    getJson.mockImplementation(async (path) => ({ ok: true, data: path.includes('settings') ? { aiBaseUrl: 'https://gateway.local' } : [], requestId: 'test' }) as never)
    await listAdminUsers(); await listAdminRoles(); await getAdminSettings(); await listFailedAnalysisTasks(); await listAdminAuditLogs(20)
    expect(getJson).toHaveBeenCalledWith('/admin/users')
    expect(getJson).toHaveBeenCalledWith('/admin/roles')
    expect(getJson).toHaveBeenCalledWith('/admin/settings')
    expect(getJson).toHaveBeenCalledWith('/admin/analysis-tasks?status=failed')
    expect(getJson).toHaveBeenCalledWith('/admin/audit-logs?limit=20')
  })

  it('更新系统设置使用 PATCH 并返回服务端设置', async () => {
    const patchJson = vi.fn().mockResolvedValue({ ok: true, data: { timezone: 'Asia/Shanghai' }, requestId: 'test' })
    ;(apiClient as unknown as { patchJson: typeof patchJson }).patchJson = patchJson
    const result = await updateAdminSettings({ timezone: 'Asia/Shanghai' })
    expect(patchJson).toHaveBeenCalledWith('/admin/settings', { timezone: 'Asia/Shanghai' })
    expect(result.timezone).toBe('Asia/Shanghai')
  })
  it('汇总 ready 与 health 为配置检查项', async () => {
    getJson.mockImplementation(async (path) => {
      if (path === '/ready') return { ok: true, data: { status: 'ready', checks: { configuration: 'ok' } }, requestId: 'test' } as never
      return { ok: true, data: { status: 'ok', service: 'smartrecruit-api', version: '0.1.0', uptimeSeconds: 1 }, requestId: 'test' } as never
    })
    const rows = await listAdminChecks()
    expect(rows.find(row => row.category === '服务健康')?.status).toBe('active')
    expect(rows.find(row => row.category === '运行时长')?.detail).toContain('1 秒')
  })

  it('支持按 subjectType 和 limit 查询流程审计事件', async () => {
    getJson.mockResolvedValue({ ok: true, data: [{ id: 'event-1', subjectType: 'offer', subjectId: 'OFF-1', subjectLabel: 'OFF-1', action: 'expire', fromStatus: 'sent', toStatus: 'expired', actorId: 'user-demo', createdAt: '2026-09-11T00:00:00Z' }], requestId: 'test' } as never)
    const events = await loadWorkflowEvents('offer', 20)
    expect(getJson).toHaveBeenCalledWith('/workflow-events?subjectType=offer&limit=20')
    expect(events[0]?.action).toBe('expire')
  })
})
