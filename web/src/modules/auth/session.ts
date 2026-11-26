import { setWorkspaceContext, notifyOtherTabs } from '../../shared/api/workspace-context'
import { reactive } from 'vue'
import { isAuthenticationError } from '../../shared/api/errors'
import {
  getCurrentUser,
  login,
  logout,
  listWorkspaces,
  selectWorkspace,
  switchSavedAccount,
  updateCurrentUserProfile,
  verifyMfa,
  type AuthLoginResult,
  type AuthUser,
  type AuthenticatedAuthResponse,
  type UpdateCurrentUserProfileInput,
  type WorkspaceSummary,
} from './api'

interface AuthSessionState {
  ready: boolean
  user: AuthUser | null
  method: 'session' | 'development-bootstrap' | null
  sessionId: string
  loading: boolean
  workspaces: WorkspaceSummary[]
  error: string
}

export const authSession = reactive<AuthSessionState>({
  ready: false,
  user: null,
  method: null,
  sessionId: '',
  loading: false,
  workspaces: [],
  error: '',
})

let refreshVersion = 0
let pendingRefresh: Promise<void> | undefined

function supersedeRefresh() {
  refreshVersion += 1
  pendingRefresh = undefined
  authSession.loading = false
}

export async function refreshAuthSession(): Promise<void> {
  if (pendingRefresh) return pendingRefresh
  const version = refreshVersion
  authSession.loading = true
  const request = (async () => {
    try {
      const me = await getCurrentUser()
      const workspaces = me.workspaces ?? await listWorkspaces()
      // Login, logout and enterprise selection take precedence over older reads.
      if (version !== refreshVersion) return
      setWorkspaceContext(me.user.workspaceId, `${me.sessionId}:${me.user.id}`)
      authSession.user = me.user
      authSession.method = me.method
      authSession.sessionId = me.sessionId
      authSession.workspaces = workspaces
      authSession.ready = true
      authSession.error = ''
    } catch (cause) {
      if (version !== refreshVersion) return
      if (isAuthenticationError(cause)) {
        setWorkspaceContext(undefined)
        authSession.user = null
        authSession.method = null
        authSession.sessionId = ''
        authSession.workspaces = []
        authSession.ready = true
        authSession.error = ''
      } else {
        authSession.error = '暂时无法确认登录状态，请检查网络后重试。'
      }
    } finally {
      if (version === refreshVersion) {
        authSession.loading = false
        pendingRefresh = undefined
      }
    }
  })()
  pendingRefresh = request
  return request
}

export function syncAuthenticatedSession(result: AuthenticatedAuthResponse): WorkspaceSummary[] {
  supersedeRefresh()
  setWorkspaceContext(result.user.workspaceId, `${result.sessionId}:${result.user.id}`)
  notifyOtherTabs()
  authSession.user = result.user
  authSession.method = 'session'
  authSession.sessionId = result.sessionId
  authSession.workspaces = result.workspaces ?? []
  authSession.ready = true
  authSession.error = ''
  return authSession.workspaces
}

export async function loginWithEmail(email: string, password: string): Promise<AuthLoginResult> {
  supersedeRefresh()
  authSession.loading = true
  try {
    const result = await login(email, password)
    if (result.kind === 'authenticated') syncAuthenticatedSession(result)
    return result
  } finally {
    authSession.loading = false
  }
}

export async function verifyMfaAndSync(challengeToken: string, code: string): Promise<AuthenticatedAuthResponse> {
  supersedeRefresh()
  authSession.loading = true
  try {
    const result = await verifyMfa(challengeToken, code)
    syncAuthenticatedSession(result)
    return result
  } finally {
    authSession.loading = false
  }
}

function clearAuthSession() {
  supersedeRefresh()
  setWorkspaceContext(undefined)
  authSession.user = null
  authSession.method = null
  authSession.sessionId = ''
  authSession.workspaces = []
  authSession.ready = true
  authSession.error = ''
}

export function clearCredentialChangeSession() {
  clearAuthSession()
  notifyOtherTabs()
}

export async function logoutCurrentUser(): Promise<void> {
  const sessionId = authSession.sessionId
  clearAuthSession()
  try {
    if (sessionId && sessionId !== 'development-bootstrap') {
      await logout(sessionId)
    }
  } finally {
    notifyOtherTabs()
  }
}

export async function switchWorkspace(workspaceId: string): Promise<void> {
  supersedeRefresh()
  const result = await selectWorkspace(workspaceId)
  supersedeRefresh()
  setWorkspaceContext(result.user.workspaceId, `${authSession.sessionId}:${result.user.id}`)
  notifyOtherTabs()
  authSession.user = result.user
  authSession.ready = true
  authSession.error = ''
  const version = refreshVersion
  try {
    const workspaces = await listWorkspaces()
    if (version === refreshVersion) authSession.workspaces = workspaces
  } catch {
    if (version !== refreshVersion) return
    authSession.workspaces = authSession.workspaces.map((workspace) => workspace.id === workspaceId ? { ...workspace, status: 'active' } : workspace)
  }
}

export async function saveCurrentUserProfile(input: UpdateCurrentUserProfileInput): Promise<AuthUser> {
  const result = await updateCurrentUserProfile(input)
  authSession.user = result.user
  return result.user
}

export async function switchAccount(userId: string): Promise<void> {
  supersedeRefresh()
  authSession.loading = true
  try {
    const result = await switchSavedAccount(userId)
    supersedeRefresh()
    setWorkspaceContext(result.user.workspaceId, `${result.sessionId}:${result.user.id}`)
    notifyOtherTabs()
    authSession.user = result.user
    authSession.method = result.method
    authSession.sessionId = result.sessionId
    authSession.workspaces = result.workspaces ?? []
    authSession.ready = true
    authSession.error = ''
  } finally {
    authSession.loading = false
  }
}
