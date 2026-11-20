// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceContextBoundary from '../../../shared/components/WorkspaceContextBoundary.vue'
import { getWorkspaceContext, setWorkspaceContext, WORKSPACE_CONTEXT_EVENT } from '../../../shared/api/workspace-context'
import { authSession } from '../../auth/session'
import EnterpriseAiSettingsPage from '../pages/EnterpriseAiSettingsPage.vue'
import { getEnterpriseAiSettings, saveEnterpriseAiSettings, testEnterpriseAiConnection, selectEnterpriseAiSource } from './index'

const settings = {
  configured: false, apiKeyConfigured: false, model: '',
  env: { OPENAI_BASE_URL: { value: 'https://ai.example.invalid', configured: true, masked: false } },
}
const success = (data: unknown) => Response.json({ ok: true, data, requestId: 'context-test' })
const changed = () => Response.json({ ok: false, error: { code: 'WORKSPACE_CONTEXT_CHANGED', message: 'changed' }, requestId: 'context-test' }, { status: 409 })
let app: App | undefined, root: HTMLDivElement | undefined
let fetcher: ReturnType<typeof vi.fn>

describe('enterprise AI requests use the real enterprise-bound API client', () => {
  beforeEach(() => {
    setWorkspaceContext('company-a', 'session:member')
    authSession.user = { id: 'member', name: 'Member', email: 'member@example.invalid', role: 'recruiter', departmentId: '', workspaceId: 'company-a' }
    authSession.workspaces = [{ id: 'company-a', name: 'Enterprise A', kind: 'test', status: 'active', role: 'owner', createdAt: '2026-11-20' }]
    fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/v1/auth/csrf') return success({ token: 'synthetic-csrf-token' })
      if (new Headers(options?.headers).get('x-workspace-id') !== 'company-a') return changed()
      return success(url.endsWith('connection-test') ? { ok: true, models: [], message: 'ok', latencyMs: 1 } : settings)
    })
    vi.stubGlobal('fetch', fetcher)
  })
  afterEach(() => {
    app?.unmount(); root?.remove(); app = undefined; root = undefined
    authSession.user = null; authSession.workspaces = []
    setWorkspaceContext(undefined)
    vi.unstubAllGlobals(); vi.restoreAllMocks()
  })

  it('loads the enterprise administrator page without triggering the changed-enterprise boundary', async () => {
    const invalidated = vi.fn()
    window.addEventListener(WORKSPACE_CONTEXT_EVENT, invalidated)
    try {
      root = document.createElement('div'); document.body.appendChild(root)
      app = createApp({ render: () => h(WorkspaceContextBoundary, null, { default: () => h(EnterpriseAiSettingsPage) }) })
      app.mount(root)
      await vi.waitFor(() => expect(root!.querySelector('#enterprise-ai-key')).not.toBeNull())
      await nextTick()
      expect(root.textContent).toContain('Enterprise A')
      expect(root.textContent).not.toContain('企业或账号已变更')
      expect(invalidated).not.toHaveBeenCalled()
    } finally { window.removeEventListener(WORKSPACE_CONTEXT_EVENT, invalidated) }
  })

  it.each([
    ['GET', '/api/v1/admin/enterprise-ai-settings', () => getEnterpriseAiSettings()],
    ['PATCH', '/api/v1/admin/enterprise-ai-settings', () => saveEnterpriseAiSettings({ OPENAI_MODEL: 'model-test' })],
    ['POST', '/api/v1/admin/enterprise-ai-connection-test', () => testEnterpriseAiConnection({})],
    ['PATCH', '/api/v1/admin/enterprise-ai-source', () => selectEnterpriseAiSource('enterprise')],
  ] as const)('sends the selected enterprise for %s %s', async (method, path, request) => {
    await request()
    const call = fetcher.mock.calls.find(([url]) => url === path)!
    expect(call).toBeTruthy()
    expect(call[1]?.method).toBe(method)
    expect(new Headers(call[1]?.headers).get('x-workspace-id')).toBe('company-a')
    if (method !== 'GET') expect(new Headers(call[1]?.headers).get('x-csrf-token')).toBeTruthy()
  })

  it('discards a delayed configuration response after A -> B -> A', async () => {
    let finish!: (response: Response) => void
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    const pending = getEnterpriseAiSettings()
    const revision = getWorkspaceContext().revision
    setWorkspaceContext('company-b', 'session:member'); setWorkspaceContext('company-a', 'session:member')
    expect(getWorkspaceContext().revision).toBeGreaterThan(revision)
    finish(success(settings))
    await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CHANGED' })
  })

  it('still blocks the page when the server reports a genuine context change', async () => {
    const invalidated = vi.fn()
    window.addEventListener(WORKSPACE_CONTEXT_EVENT, invalidated)
    try {
      fetcher.mockResolvedValueOnce(changed())
      await expect(getEnterpriseAiSettings()).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CHANGED' })
      expect(invalidated).toHaveBeenCalledOnce()
      expect(fetcher).toHaveBeenCalledOnce()
    } finally { window.removeEventListener(WORKSPACE_CONTEXT_EVENT, invalidated) }
  })
})
