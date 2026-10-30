// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client'
import { getWorkspaceContext, setWorkspaceContext, WORKSPACE_CONTEXT_EVENT } from './workspace-context'

const response = (data: unknown) => new Response(JSON.stringify({ ok: true, data, requestId: 'test' }), { headers: { 'content-type': 'application/json' } })
afterEach(() => { setWorkspaceContext(undefined); vi.restoreAllMocks() })
describe('workspace-bound API requests', () => {
  it('captures tenant at dispatch and overrides caller supplied tenant assertions', async () => {
    setWorkspaceContext('company-a')
    const fetcher = vi.fn().mockResolvedValue(response([]))
    await createApiClient({ fetcher }).getJson('/jobs', { headers: { 'x-workspace-id': 'company-b' } })
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('x-workspace-id')).toBe('company-a')
  })
  it('does not bind authentication or explicit workspace management to a previous tenant', async () => {
    setWorkspaceContext('company-a')
    const fetcher = vi.fn().mockImplementation(async () => response([]))
    const client = createApiClient({ fetcher })
    await client.getJson('/me'); await client.getJson('/workspaces')
    for (const call of fetcher.mock.calls) expect(new Headers(call[1].headers).has('x-workspace-id')).toBe(false)
  })
  it('discards old responses even after A -> B -> A, rather than updating the new page', async () => {
    setWorkspaceContext('company-a')
    let finish!: (value: Response) => void
    const fetcher = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const pending = createApiClient({ fetcher }).getJson('/candidates')
    setWorkspaceContext('company-b'); setWorkspaceContext('company-a')
    finish(response([{ name: 'old' }]))
    await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CHANGED' })
  })
  it('also discards a response if the identity changes while its JSON body is being read', async () => {
    setWorkspaceContext('company-a', 'session:user')
    let finish!: (value: string) => void
    const body = new Promise<string>(resolve => { finish = resolve })
    const result = response([])
    vi.spyOn(result, 'text').mockImplementation(() => body)
    const fetcher = vi.fn().mockResolvedValue(result)
    const pending = createApiClient({ fetcher }).getJson('/jobs')
    await vi.waitFor(() => expect(result.text).toHaveBeenCalledOnce())
    setWorkspaceContext('company-b', 'session:user')
    finish(JSON.stringify({ ok: true, data: [], requestId: 'test' }))
    await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CHANGED' })
  })
  it('does not invalidate in-flight requests for redundant session refresh', () => {
    setWorkspaceContext('company-a', 'session:user')
    const before = getWorkspaceContext()
    setWorkspaceContext('company-a', 'session:user')
    expect(getWorkspaceContext()).toEqual(before)
    setWorkspaceContext('company-a', 'other:user')
    expect(getWorkspaceContext().revision).toBeGreaterThan(before.revision)
  })
  it('raises the blocking boundary on a server-rejected stale context, without retrying', async () => {
    setWorkspaceContext('company-a')
    const invalidated = vi.fn()
    window.addEventListener(WORKSPACE_CONTEXT_EVENT, invalidated)
    try {
      const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: 'WORKSPACE_CONTEXT_CHANGED', message: 'changed' }, requestId: 'test' }), { status: 409 }))
      await expect(createApiClient({ fetcher }).getJson('/jobs')).rejects.toMatchObject({ code: 'WORKSPACE_CONTEXT_CHANGED' })
      expect(fetcher).toHaveBeenCalledOnce(); expect(invalidated).toHaveBeenCalledOnce()
    } finally { window.removeEventListener(WORKSPACE_CONTEXT_EVENT, invalidated) }
  })
})

describe('platform requests are identity-bound but independent of selected enterprise', () => {
  it.each(['/platform/customers', '/admin/settings'])('does not send enterprise assertion on %s', async path => {
    setWorkspaceContext('company-a', 'session:operator')
    const fetcher=vi.fn().mockResolvedValue(response([]))
    await createApiClient({fetcher}).getJson(path)
    expect(new Headers(fetcher.mock.calls[0][1].headers).has('x-workspace-id')).toBe(false)
  })
  it('discards platform responses after an account switch',async()=>{
    setWorkspaceContext(undefined,'session:operator')
    let finish!:(response:Response)=>void
    const fetcher=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    const pending=createApiClient({fetcher}).getJson('/platform/customers')
    setWorkspaceContext(undefined,'session:customer');finish(response([{name:'private'}]))
    await expect(pending).rejects.toMatchObject({code:'WORKSPACE_CONTEXT_CHANGED'})
  })
})

describe('AI usage is enterprise-bound, not global admin data',()=>{
 it('always sends the current enterprise header',async()=>{
  setWorkspaceContext('company-a');const fetcher=vi.fn().mockResolvedValue(response({}))
  await createApiClient({fetcher}).getJson('/admin/ai-usage?page=1')
  expect(new Headers(fetcher.mock.calls[0][1].headers).get('x-workspace-id')).toBe('company-a')
 })
 it('rejects an old enterprise usage response after switching',async()=>{
  setWorkspaceContext('company-a');let finish!:(r:Response)=>void
  const fetcher=vi.fn().mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
  const pending=createApiClient({fetcher}).getJson('/admin/ai-usage?page=1')
  setWorkspaceContext('company-b');finish(response({summary:{total:99}}))
  await expect(pending).rejects.toMatchObject({code:'WORKSPACE_CONTEXT_CHANGED'})
 })
})

describe('billing simulation is current-enterprise scoped',()=>{
 it.each(['/admin/billing-sandbox','/admin/billing-sandbox/orders'])('sends workspace assertion on %s',async path=>{setWorkspaceContext('company-a');const fetcher=vi.fn().mockResolvedValue(response({}));await createApiClient({fetcher}).getJson(path);expect(new Headers(fetcher.mock.calls[0][1].headers).get('x-workspace-id')).toBe('company-a')})
 it('discards an old tenant order response after switching',async()=>{setWorkspaceContext('company-a');let finish!:(r:Response)=>void;const fetcher=vi.fn().mockImplementation(()=>new Promise(r=>{finish=r}));const pending=createApiClient({fetcher}).getJson('/admin/billing-sandbox');setWorkspaceContext('company-b');finish(response({orders:[{id:'secret-order'}]}));await expect(pending).rejects.toMatchObject({code:'WORKSPACE_CONTEXT_CHANGED'})})
})
