import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCurrentUser, login, logout, listSavedAccounts, switchSavedAccount } from './index'

function mockFetch(response: Record<string, unknown>, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), {
    status: ok ? 200 : 401,
    headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
  })))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('auth api', () => {
  it('logs in with email and password', async () => {
    mockFetch({
      ok: true,
      data: {
        user: { id: 'user-1', name: '招聘专员', email: 'recruiter@smartrecruit.local', role: 'recruiter', departmentId: 'dept-tech' },
        sessionId: 'session-1',
        expiresAt: '2026-09-15T00:00:00Z',
      },
      requestId: 'request-1',
    })
    const result = await login('recruiter@smartrecruit.local', 'recruiter123')
    expect(result.user.role).toBe('recruiter')
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/login', expect.objectContaining({ method: 'POST', credentials: 'include' }))
  })

  it('reads current user and accepts development bootstrap method', async () => {
    mockFetch({
      ok: true,
      data: {
        user: { id: 'user-recruiter', name: '招聘专员（开发）', email: 'recruiter@smartrecruit.local', role: 'recruiter', departmentId: 'dept-tech' },
        sessionId: 'development-bootstrap',
        method: 'development-bootstrap',
      },
      requestId: 'request-1',
    })
    await expect(getCurrentUser()).resolves.toMatchObject({ user: { role: 'recruiter' }, method: 'development-bootstrap' })
  })

  it('logs out the current session', async () => {
    mockFetch({ ok: true, data: { ok: true }, requestId: 'request-1' })
    await expect(logout('session-1')).resolves.toEqual({ ok: true })
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'include' }))
  })

  it('lists saved accounts using the protected cookie session', async () => {
    const accounts = [{ user: { id: 'user-1', name: '招聘专员', email: 'hr@example.com', role: 'recruiter', departmentId: 'hr' }, current: true }]
    mockFetch({ ok: true, data: accounts })
    await expect(listSavedAccounts()).resolves.toEqual(accounts)
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/accounts', expect.objectContaining({ method: 'GET', credentials: 'include' }))
  })

  it('switches by account id without sending a password or session secret', async () => {
    mockFetch({ ok: true, data: { user: { id: 'user-2' }, method: 'session', sessionId: 'session-2', workspaces: [] } })
    await switchSavedAccount('user-2')
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/v1/auth/accounts/switch', expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ userId: 'user-2' }) }))
  })

})
