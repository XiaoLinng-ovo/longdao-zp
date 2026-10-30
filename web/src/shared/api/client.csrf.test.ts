import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'csrf-test' } })
}
const denied = (code: string) => response({ ok: false, error: { code, message: code }, requestId: 'csrf-test' }, 403)
beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())
describe('CSRF request retry boundaries', () => {
  it('does not refresh token or repeat writes when the origin is untrusted', async () => {
    const tokens = vi.fn().mockResolvedValue(response({ ok: true, data: { token: 'token1' } }))
    vi.stubGlobal('fetch', tokens)
    const fetcher = vi.fn().mockImplementation(() => denied('CSRF_ORIGIN_MISMATCH'))
    const { createApiClient } = await import('./client')
    await expect(createApiClient({ fetcher }).postJson('/workspaces/A/invitations', {})).rejects.toMatchObject({ code: 'CSRF_ORIGIN_MISMATCH' })
    expect(tokens).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('refreshes an invalid token once and retries with the new token', async () => {
    const tokens = vi.fn().mockResolvedValueOnce(response({ ok: true, data: { token: 'old' } })).mockResolvedValueOnce(response({ ok: true, data: { token: 'new' } }))
    vi.stubGlobal('fetch', tokens)
    const fetcher = vi.fn().mockResolvedValueOnce(denied('CSRF_TOKEN_INVALID')).mockResolvedValueOnce(response({ ok: true, data: { ok: true }, requestId: 'csrf-test' }))
    const { createApiClient } = await import('./client')
    await createApiClient({ fetcher }).postJson('/workspaces/A/select', {})
    expect(tokens).toHaveBeenCalledTimes(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(new Headers(fetcher.mock.calls[1][1].headers).get('x-csrf-token')).toBe('new')
  })
  it('does not retry indefinitely when refreshed tokens are rejected', async () => {
    const tokens = vi.fn().mockImplementation(() => response({ ok: true, data: { token: 'token' } }))
    vi.stubGlobal('fetch', tokens)
    const fetcher = vi.fn().mockImplementation(() => denied('CSRF_TOKEN_INVALID'))
    const { createApiClient } = await import('./client')
    await expect(createApiClient({ fetcher }).postJson('/workspaces/A/select', {})).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
