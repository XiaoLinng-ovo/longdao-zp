import { LocalAuthSessionStore } from './session-store.js'
import type { AuthContext, AuthSession, LoginInput, Role, SessionUser } from './types.js'

export class AuthService {
  private readonly sessionStore: LocalAuthSessionStore

  constructor(sessionStore = new LocalAuthSessionStore()) {
    this.sessionStore = sessionStore
  }

  async login(input: LoginInput): Promise<{ session: AuthSession; token: string }> {
    const email = (input.email ?? '').trim()
    const password = String(input.password ?? '')
    if (!email || !password) {
      const error = new Error('邮箱和密码不能为空') as Error & { code?: string; status?: number }
      error.code = 'VALIDATION_ERROR'
      error.status = 400
      throw error
    }
    const user = await this.sessionStore.findUserByEmailPassword(email, password)
    if (!user) {
      const error = new Error('邮箱或密码错误') as Error & { code?: string; status?: number }
      error.code = 'INVALID_CREDENTIALS'
      error.status = 401
      throw error
    }
    return this.sessionStore.createSession(user)
  }

  async logout(sessionId: string): Promise<void> {
    if (sessionId) await this.sessionStore.deleteSession(sessionId)
  }

  async authenticateToken(token: string | undefined): Promise<AuthContext | undefined> {
    if (!token) return undefined
    const session = await this.sessionStore.findSessionByToken(token)
    if (!session) return undefined
    return {
      user: session.user,
      sessionId: session.sessionId,
      method: 'session',
    }
  }

  getBootstrapUser(env: NodeJS.ProcessEnv = process.env): SessionUser | undefined {
    if (env.NODE_ENV !== 'development') return undefined
    const enabled = env.ALLOW_DEV_BOOTSTRAP_AUTH !== 'false'
    if (!enabled) return undefined
    return {
      id: env.DEV_BOOTSTRAP_USER_ID?.trim() || 'user-recruiter',
      name: env.DEV_BOOTSTRAP_USER_NAME?.trim() || '招聘专员（开发）',
      email: env.DEV_BOOTSTRAP_USER_EMAIL?.trim() || 'recruiter@smartrecruit.local',
      role: (env.DEV_BOOTSTRAP_USER_ROLE?.trim() || 'recruiter') as Role,
      departmentId: env.DEV_BOOTSTRAP_USER_DEPARTMENT?.trim() || 'dept-tech',
    }
  }

  requirePermission(auth: AuthContext | undefined, roles?: Role[]): void {
    if (!auth) {
      const error = new Error('未登录，请先完成身份认证') as Error & { code?: string; status?: number }
      error.code = 'AUTHENTICATION_REQUIRED'
      error.status = 401
      throw error
    }
    if (roles && roles.length > 0 && !roles.includes(auth.user.role)) {
      const error = new Error('当前账号没有执行此操作的权限') as Error & { code?: string; status?: number }
      error.code = 'FORBIDDEN'
      error.status = 403
      throw error
    }
  }
}
