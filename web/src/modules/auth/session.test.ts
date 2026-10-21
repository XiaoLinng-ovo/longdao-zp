// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authSession, switchAccount, switchWorkspace, refreshAuthSession, logoutCurrentUser } from './session'
import { switchSavedAccount, selectWorkspace, listWorkspaces, getCurrentUser, logout } from './api'
vi.mock('./api', () => ({ switchSavedAccount: vi.fn(), getCurrentUser: vi.fn(), login: vi.fn(), logout: vi.fn(), listWorkspaces: vi.fn(), selectWorkspace: vi.fn() }))
import { getWorkspaceContext, setWorkspaceContext, WORKSPACE_CONTEXT_STORAGE_KEY } from '../../shared/api/workspace-context'
const user = { id: 'recruiter', name: '招聘专员', email: 'hr@example.com', role: 'recruiter' as const, departmentId: 'hr', workspaceId: 'enterprise-2' }
beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  setWorkspaceContext('enterprise-1', 'old:admin')
  Object.assign(authSession, { ready: true, loading: false, user: { ...user, id: 'admin', role: 'admin', workspaceId: 'enterprise-1' }, method: 'session', sessionId: 'old', workspaces: [] })
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
