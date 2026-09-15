// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AdministrationPage from './AdministrationPage.vue'
import { listAdminChecks, loadWorkflowEvents } from '../api'

vi.mock('../api', () => ({ listAdminChecks: vi.fn(), loadWorkflowEvents: vi.fn() }))
const mockedChecks = vi.mocked(listAdminChecks)
const mockedEvents = vi.mocked(loadWorkflowEvents)

const checks = [{ category: '服务健康', owner: '系统管理员', status: 'active' as const, detail: 'smartrecruit-api' }]
const event = { id: 'event-1', subjectType: 'offer' as const, subjectId: 'OFF-1', subjectLabel: 'OFF-1', action: 'expire', fromStatus: 'sent', toStatus: 'expired', actorId: 'user-demo', createdAt: '2026-09-11T00:00:00Z' }

let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() } }
afterEach(() => { app?.unmount(); app = undefined; root?.remove(); vi.resetAllMocks() })

describe('管理后台页面', () => {
  it('展示系统检查与流程审计记录，而不是空占位', async () => {
    mockedChecks.mockResolvedValue(checks)
    mockedEvents.mockResolvedValue([event])
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp(AdministrationPage); app.mount(root)
    await flush()
    expect(root.textContent).toContain('服务健康')
    expect(root.textContent).toContain('流程审计记录')
    expect(root.textContent).toContain('OFF-1')
    expect(root.textContent).toContain('过期')
  })
})
