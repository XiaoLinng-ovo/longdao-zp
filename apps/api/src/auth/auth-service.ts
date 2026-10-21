import { LocalAuthSessionStore } from './session-store.js'
import type { AuthContext, AuthSession, LoginInput, RegisterInput, Role, SessionUser, WorkspaceCreateInput, WorkspaceSummary } from './types.js'
import { LoginRateLimiter } from './rate-limit.js'
import type { SessionRepository } from './session-repository.js'
import { PostgresSessionRepository } from './session-repository.js'
import { createDatabasePool } from '../db/connection.js'
import { loadDatabaseConfig } from '../db/config.js'

export type AuthSessionStore = Pick<LocalAuthSessionStore, 'findUserByEmailPassword' | 'createSession' | 'findSessionByToken' | 'deleteSession' | 'registerUser' | 'listWorkspaces' | 'createWorkspace' | 'archiveWorkspace' | 'resetWorkspace' | 'selectWorkspace'>

export function createAuthSessionStore(env: NodeJS.ProcessEnv = process.env): AuthSessionStore {
  const hasDatabase = Boolean(env.DATABASE_URL?.trim() || env.PGPASSWORD?.trim())
  if (env.NODE_ENV === 'production' && !hasDatabase) {
    throw new Error('Production authentication requires database configuration')
  }
  if (hasDatabase) {
    const pool = createDatabasePool(loadDatabaseConfig(env))
    return new PostgresSessionRepository(pool) as SessionRepository & AuthSessionStore
  }
  return new LocalAuthSessionStore()
}

export class AuthService {
  private readonly sessionStore: AuthSessionStore
  private readonly loginLimiter: LoginRateLimiter

  constructor(sessionStore = createAuthSessionStore(), loginLimiter = new LoginRateLimiter()) {
    this.sessionStore = sessionStore
    this.loginLimiter = loginLimiter
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
    const key = email.toLowerCase()
    if (!this.loginLimiter.allow(key)) {
      const error = new Error('登录尝试过于频繁，请稍后再试') as Error & { code?: string; status?: number }
      error.code = 'LOGIN_RATE_LIMITED'; error.status = 429
      throw error
    }
    const user = await this.sessionStore.findUserByEmailPassword(email, password)
    if (!user) {
      const error = new Error('邮箱或密码错误') as Error & { code?: string; status?: number }
      error.code = 'INVALID_CREDENTIALS'
      error.status = 401
      throw error
    }
    this.loginLimiter.clear(key)
    return this.sessionStore.createSession(user)
  }

  async logout(sessionId: string): Promise<void> {
    if (sessionId) await this.sessionStore.deleteSession(sessionId)
  }

  async register(input: RegisterInput): Promise<SessionUser> {
    return this.sessionStore.registerUser(input)
  }

  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    return this.sessionStore.listWorkspaces(userId)
  }

  async createWorkspace(userId: string, input: WorkspaceCreateInput): Promise<WorkspaceSummary> {
    return this.sessionStore.createWorkspace(userId, input)
  }

  async archiveWorkspace(userId: string, workspaceId: string): Promise<void> {
    return this.sessionStore.archiveWorkspace(userId, workspaceId)
  }

  async resetWorkspace(userId: string, workspaceId: string): Promise<void> {
    return this.sessionStore.resetWorkspace(userId, workspaceId)
  }

  async selectWorkspace(sessionId: string, userId: string, workspaceId: string): Promise<SessionUser> {
    return this.sessionStore.selectWorkspace(sessionId, userId, workspaceId)
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
