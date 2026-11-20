// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authSession, switchAccount, switchWorkspace, refreshAuthSession, logoutCurrentUser, syncAuthenticatedSession } from './session'
import { ApiAuthenticationError, ApiNetworkError } from '../../shared/api/errors'
import { login, switchSavedAccount, selectWorkspace, listWorkspaces, getCurrentUser, logout } from './api'
vi.mock('./api', () => ({ switchSavedAccount: vi.fn(), getCurrentUser: vi.fn(), login: vi.fn(), logout: vi.fn(), listWorkspaces: vi.fn(), selectWorkspace: vi.fn() }))
import { getWorkspaceContext, setWorkspaceContext, WORKSPACE_CONTEXT_STORAGE_KEY } from '../../shared/api/workspace-context'
const user = { id: 'recruiter', name: '招聘专员', email: 'hr@example.com', role: 'recruiter' as const, departmentId: 'hr', workspaceId: 'enterprise-2' }
beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  setWorkspaceContext('enterprise-1', 'old:admin')
  Object.assign(authSession, { ready: true, loading: false, error: '', user: { ...user, id: 'admin', role: 'admin', workspaceId: 'enterprise-1' }, method: 'session', sessionId: 'old', workspaces: [] })
})
describe('account switching', () => {
  it('replaces identity, session and workspaces only after server authentication', async () => {
    let resolve!: (value: any) => void
    vi.mocked(switchSavedAccount).mockReturnValue(new Promise(done => { resolve = done }))
    const switching = switchAccount(user.id)
    expect(authSession.user?.id).toBe('admin')
    expect(authSession.loading).toBe(true)
    const workspaces = [{ id: 'enterprise-2', name: '新企业', kind: 'production' as const, status: 'active' as const, role: 'member' as const, createdAt: '2026-10-09' }]
    resolve({ user, method: 'session', sessionId: 'new', workspaces })
    await switching
    expect(switchSavedAccount).toHaveBeenCalledWith(user.id)
    expect(authSession).toMatchObject({ user, method: 'session', sessionId: 'new', workspaces, loading: false })
  })
  it('preserves the current account and resets loading on failure', async () => {
    vi.mocked(switchSavedAccount).mockRejectedValue(new Error('expired'))
    await expect(switchAccount(user.id)).rejects.toThrow('expired')
    expect(authSession).toMatchObject({ user: { id: 'admin', role: 'admin', workspaceId: 'enterprise-1' }, sessionId: 'old', loading: false })
  })
})

describe('workspace consistency', () => {
  it('deduplicates simultaneous startup session requests', async () => {
    let resolve!: (value: any) => void
    vi.mocked(getCurrentUser).mockReturnValue(new Promise(done => { resolve = done }))
    const first = refreshAuthSession()
    const second = refreshAuthSession()
    expect(getCurrentUser).toHaveBeenCalledTimes(1)
    resolve({ user, sessionId: 'old', method: 'session', workspaces: [] })
    await Promise.all([first, second])
  })
  it.each(['success', 'unauthorized'] as const)('ignores an old startup %s response after login', async (outcome) => {
    let resolve!: (value: any) => void
    let reject!: (reason: unknown) => void
    vi.mocked(getCurrentUser).mockReturnValue(new Promise((done, fail) => { resolve = done; reject = fail }))
    const refreshing = refreshAuthSession()
    authSession.ready = false
    syncAuthenticatedSession({ user, sessionId: 'new', expiresAt: '', workspaces: [] })
    if (outcome === 'success') resolve({ user: { ...user, workspaceId: undefined }, sessionId: 'old', method: 'session', workspaces: [] })
    else reject(new ApiAuthenticationError())
    await refreshing
    expect(authSession).toMatchObject({ ready: true, user, sessionId: 'new', loading: false })
    expect(getWorkspaceContext().workspaceId).toBe('enterprise-2')
  })
  it('does not restore the previous enterprise after a successful selection', async () => {
    let resolve!: (value: any) => void
    const previous = { ...authSession.user }
    vi.mocked(getCurrentUser).mockReturnValue(new Promise(done => { resolve = done }))
    const refreshing = refreshAuthSession()
    vi.mocked(selectWorkspace).mockResolvedValue({ user })
    vi.mocked(listWorkspaces).mockResolvedValue([])
    await switchWorkspace('enterprise-2')
    resolve({ user: previous, sessionId: 'old', method: 'session', workspaces: [] })
    await refreshing
    expect(authSession.user?.workspaceId).toBe('enterprise-2')
    expect(getWorkspaceContext().workspaceId).toBe('enterprise-2')
  })
  it('does not restore a session after logout', async () => {
    let resolve!: (value: any) => void
    vi.mocked(getCurrentUser).mockReturnValue(new Promise(done => { resolve = done }))
    const refreshing = refreshAuthSession()
    await logoutCurrentUser()
    resolve({ user, sessionId: 'old', method: 'session', workspaces: [] })
    await refreshing
    expect(authSession.user).toBeNull()
    expect(getWorkspaceContext().workspaceId).toBeUndefined()
  })
  it('retains authenticated identity and enterprise on a temporary network failure', async () => {
    const before = { ...authSession.user }
    const context = getWorkspaceContext()
    vi.mocked(getCurrentUser).mockRejectedValue(new ApiNetworkError())
    await refreshAuthSession()
    expect(authSession.user).toEqual(before)
    expect(getWorkspaceContext()).toEqual(context)
  })
  it('clears the current session only when the server confirms it is unauthorized', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new ApiAuthenticationError())
    await refreshAuthSession()
    expect(authSession.user).toBeNull()
    expect(authSession.ready).toBe(true)
  })
  it('keeps startup unresolved on temporary failure and permits a successful retry', async () => {
    Object.assign(authSession, { ready: false, user: null, sessionId: '', workspaces: [] })
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new ApiNetworkError())
    await refreshAuthSession()
    expect(authSession).toMatchObject({ ready: false, user: null, loading: false })
    expect(authSession.error).toContain('暂时无法确认登录状态')
    vi.mocked(getCurrentUser).mockResolvedValue({ user, sessionId: 'new', method: 'session', workspaces: [] })
    await refreshAuthSession()
    expect(authSession).toMatchObject({ ready: true, user, error: '', loading: false })
  })
  it('marks successful login ready even if initialization has not finished', () => {
    authSession.ready = false
    authSession.error = '暂时无法确认登录状态'
    syncAuthenticatedSession({ user, sessionId: 'new', expiresAt: '', workspaces: [] })
    expect(authSession).toMatchObject({ ready: true, error: '', user })
  })
  it('broadcasts and updates context only on successful workspace selection', async () => {
    const broadcast = vi.spyOn(Storage.prototype, 'setItem')
    vi.mocked(selectWorkspace).mockRejectedValueOnce(new Error('forbidden'))
    const before = getWorkspaceContext()
    await expect(switchWorkspace('enterprise-2')).rejects.toThrow('forbidden')
    expect(getWorkspaceContext()).toEqual(before)
    expect(broadcast).not.toHaveBeenCalled()
    vi.mocked(selectWorkspace).mockResolvedValue({ user } as never)
    vi.mocked(listWorkspaces).mockResolvedValue([])
    await switchWorkspace('enterprise-2')
    expect(getWorkspaceContext().workspaceId).toBe('enterprise-2')
    expect(broadcast).toHaveBeenCalledWith(WORKSPACE_CONTEXT_STORAGE_KEY, expect.any(String))
  })
  it('refreshing the same session does not broadcast or invalidate requests', async () => {
    const broadcast = vi.spyOn(Storage.prototype, 'setItem')
    vi.mocked(getCurrentUser).mockResolvedValue({ user: authSession.user, sessionId: 'old', method: 'session', workspaces: [] } as never)
    const before = getWorkspaceContext()
    await refreshAuthSession()
    expect(getWorkspaceContext()).toEqual(before)
    expect(broadcast).not.toHaveBeenCalled()
  })
  it('blocks other tabs even if server logout fails', async () => {
    const broadcast = vi.spyOn(Storage.prototype, 'setItem')
    vi.mocked(logout).mockRejectedValue(new Error('network'))
    await expect(logoutCurrentUser()).rejects.toThrow('network')
    expect(getWorkspaceContext().workspaceId).toBeUndefined()
    expect(broadcast).toHaveBeenCalledWith(WORKSPACE_CONTEXT_STORAGE_KEY, expect.any(String))
  })
})
