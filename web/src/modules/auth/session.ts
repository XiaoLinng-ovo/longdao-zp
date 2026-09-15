import { reactive } from 'vue'
import { getCurrentUser, login, logout, type AuthUser } from './api'

interface AuthSessionState {
  ready: boolean
  user: AuthUser | null
  method: 'session' | 'development-bootstrap' | null
  sessionId: string
  loading: boolean
}

export const authSession = reactive<AuthSessionState>({
  ready: false,
  user: null,
  method: null,
  sessionId: '',
  loading: false,
})

export async function refreshAuthSession(): Promise<void> {
  authSession.loading = true
  try {
    const me = await getCurrentUser()
    authSession.user = me.user
    authSession.method = me.method
    authSession.sessionId = me.sessionId
  } catch {
    authSession.user = null
    authSession.method = null
    authSession.sessionId = ''
  } finally {
    authSession.ready = true
    authSession.loading = false
  }
}

export async function loginWithEmail(email: string, password: string): Promise<void> {
  authSession.loading = true
  try {
    const result = await login(email, password)
    authSession.user = result.user
    authSession.method = 'session'
    authSession.sessionId = result.sessionId
  } finally {
    authSession.loading = false
  }
}

export async function logoutCurrentUser(): Promise<void> {
  const sessionId = authSession.sessionId
  authSession.user = null
  authSession.method = null
  authSession.sessionId = ''
  if (sessionId && sessionId !== 'development-bootstrap') {
    await logout(sessionId)
  }
}
