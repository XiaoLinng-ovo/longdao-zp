// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import Page from './PlatformOperatorsPage.vue'
import { listPlatformOperators, updatePlatformOperator, type OperatorDirectory } from '../api/operators'
import { authSession } from '../../auth/session'

vi.mock('../api/operators', () => ({ listPlatformOperators: vi.fn(), updatePlatformOperator: vi.fn() }))
vi.mock('../../auth/session', () => ({ authSession: { user: { id: 'system', isSystemAdmin: true, platformRole: undefined } }, refreshAuthSession: vi.fn() }))
const report: OperatorDirectory = {
  items: [{ id: 'target', userNo: 'USR-123456789A', displayName: '运营人员', email: 'operator@example.invalid', isActive: true, platformRole: null }],
  total: 1, page: 1, pageSize: 20, recentAudit: [],
}
let app: App, root: HTMLDivElement
async function flush() { await Promise.resolve(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) }
async function mount(role: 'admin' | 'viewer' | null = null, active = true) {
  vi.mocked(listPlatformOperators).mockResolvedValue({ ...report, items: [{ ...report.items[0]!, platformRole: role, isActive: active }] })
  vi.mocked(updatePlatformOperator).mockResolvedValue({ userId: 'target', platformRole: role })
  root = document.createElement('div'); document.body.appendChild(root)
  app = createApp(Page); app.mount(root); await flush()
}
afterEach(() => {
  app?.unmount(); root?.remove(); vi.clearAllMocks()
  authSession.user!.isSystemAdmin = true; authSession.user!.platformRole = undefined
})
it('system administrator can inspect history but cannot delegate any platform access', async () => {
  await mount('admin')
  expect(listPlatformOperators).toHaveBeenCalledOnce()
  expect(root.textContent).toContain('operator@example.invalid')
  expect(root.textContent).toContain('历史管理员（已失效）')
  expect(root.querySelector('.text-button')).toBeNull()
  expect(document.querySelector('[role=dialog]')).toBeNull()
  expect(updatePlatformOperator).not.toHaveBeenCalled()
})
it.each(['admin', 'viewer'] as const)('legacy %s grant cannot read history or render actions', async role => {
  authSession.user!.isSystemAdmin = false; authSession.user!.platformRole = role
  await mount()
  expect(listPlatformOperators).not.toHaveBeenCalled()
  expect(root.textContent).toContain('仅系统管理员')
  expect(root.querySelector('form')).toBeNull()
})
it('search and filters are read-only and pass query parameters', async () => {
  await mount()
  const input = root.querySelector('input')!
  input.value = '运营'; input.dispatchEvent(new Event('input')); await nextTick()
  root.querySelector('form')!.dispatchEvent(new Event('submit')); await flush()
  expect(listPlatformOperators).toHaveBeenLastCalledWith({ q: '运营', platformRole: '', page: 1 })
  const select = root.querySelector('select')!
  select.value = 'viewer'; select.dispatchEvent(new Event('change')); await flush()
  expect(listPlatformOperators).toHaveBeenLastCalledWith({ q: '运营', platformRole: 'viewer', page: 1 })
  expect(updatePlatformOperator).not.toHaveBeenCalled()
})
it('failed loads remain visible and can be retried without writes', async () => {
  await mount()
  vi.mocked(listPlatformOperators).mockRejectedValueOnce(new Error('网络不可用'))
  root.querySelector<HTMLButtonElement>('[aria-label="刷新授权列表"]')!.click(); await flush()
  expect(root.querySelector('[role=alert]')).not.toBeNull()
  root.querySelector<HTMLButtonElement>('[role=alert] button')!.click(); await flush()
  expect(root.querySelector('[role=alert]')).toBeNull()
  expect(updatePlatformOperator).not.toHaveBeenCalled()
})
