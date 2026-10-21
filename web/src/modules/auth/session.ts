import { setWorkspaceContext, notifyOtherTabs } from '../../shared/api/workspace-context'
import { reactive } from 'vue'
import { getCurrentUser, login, logout, listWorkspaces, selectWorkspace, switchSavedAccount, type AuthUser, type WorkspaceSummary } from './api'

interface AuthSessionState {
  ready: boolean
  user: AuthUser | null
  method: 'session' | 'development-bootstrap' | null
  sessionId: string
  loading: boolean
  workspaces: WorkspaceSummary[]
}

export const authSession = reactive<AuthSessionState>({
  ready: false,
  user: null,
  method: null,
  sessionId: '',
  loading: false,
  workspaces: [],
})

export async function refreshAuthSession(): Promise<void> {
  authSession.loading = true
  try {
    const me = await getCurrentUser()
    setWorkspaceContext(me.user.workspaceId, `${me.sessionId}:${me.user.id}`)
    authSession.user = me.user
    authSession.method = me.method
    authSession.sessionId = me.sessionId
    authSession.workspaces = me.workspaces ?? await listWorkspaces().catch(() => [])
  } catch {
    setWorkspaceContext(undefined)
    authSession.user = null
    authSession.method = null
    authSession.sessionId = ''
    authSession.workspaces = []
  } finally {
    authSession.ready = true
    authSession.loading = false
  }
}

export async function loginWithEmail(email: string, password: string): Promise<WorkspaceSummary[]> {
  authSession.loading = true
  try {
    const result = await login(email, password)
    setWorkspaceContext(result.user.workspaceId, `${result.sessionId}:${result.user.id}`)
    notifyOtherTabs()
    authSession.user = result.user
    authSession.method = 'session'
    authSession.sessionId = result.sessionId
    authSession.workspaces = result.workspaces ?? []
    return authSession.workspaces
  } finally {
    authSession.loading = false
  }
}

export async function logoutCurrentUser(): Promise<void> {
  const sessionId = authSession.sessionId
  setWorkspaceContext(undefined)
  authSession.user = null
  authSession.method = null
  authSession.sessionId = ''
  authSession.workspaces = []
  try {
    if (sessionId && sessionId !== 'development-bootstrap') {
      await logout(sessionId)
    }
  } finally {
    notifyOtherTabs()
  }
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  const result = await selectWorkspace(workspaceId)
  setWorkspaceContext(result.user.workspaceId, `${authSession.sessionId}:${result.user.id}`)
  notifyOtherTabs()
  authSession.user = result.user
  try { authSession.workspaces = await listWorkspaces() } catch {
    authSession.workspaces = authSession.workspaces.map((workspace) => workspace.id === workspaceId ? { ...workspace, status: 'active' } : workspace)
  }
}

export async function switchAccount(userId: string): Promise<void> {
  authSession.loading = true
  try {
    const result = await switchSavedAccount(userId)
    setWorkspaceContext(result.user.workspaceId, `${result.sessionId}:${result.user.id}`)
    notifyOtherTabs()
    authSession.user = result.user
    authSession.method = result.method
    authSession.sessionId = result.sessionId
    authSession.workspaces = result.workspaces ?? []
  } finally {
    authSession.loading = false
  }
}
