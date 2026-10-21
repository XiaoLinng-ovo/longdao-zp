import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AuthSession, RegisterInput, SessionUser, WorkspaceCreateInput, WorkspaceSummary } from './types.js'
import { hashPassword, verifyPassword } from './password.js'

export interface SessionRepository {
  findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined>
  createSession(user: SessionUser, ttlMs?: number, metadata?: { userAgent?: string; ipAddress?: string }): Promise<{ session: AuthSession; token: string }>
  findSessionByToken(token: string): Promise<AuthSession | undefined>
  revokeSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  cleanupExpiredSessions(): Promise<number>
  registerUser(input: RegisterInput): Promise<SessionUser>
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>
  createWorkspace(userId: string, input: WorkspaceCreateInput): Promise<WorkspaceSummary>
  archiveWorkspace(userId: string, workspaceId: string): Promise<void>
  resetWorkspace(userId: string, workspaceId: string): Promise<void>
  selectWorkspace(sessionId: string, userId: string, workspaceId: string): Promise<SessionUser>
}

interface Queryable { query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> }
const TTL_MS = 1000 * 60 * 60 * 12
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: Queryable) {}

  async findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined> {
    const result = await this.db.query<any>(
      `SELECT u.id, u.display_name, u.email, u.password_hash, u.department_id, d.code AS department_code,
              (SELECT p.role FROM platform_operators p WHERE p.user_id=u.id AND p.is_active=true) AS platform_role,
              COALESCE((SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY r.code LIMIT 1), 'recruiter') AS role
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE lower(u.email) = lower($1) AND u.is_active = true LIMIT 1`, [email.trim()])
    const row = result.rows[0]
    if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) return undefined
    return { id: row.id, name: row.display_name, email: row.email, role: row.role, departmentId: row.department_code ?? row.department_id ?? '', ...(row.platform_role ? {platformRole: row.platform_role} : {}) }
  }


  async registerUser(input: RegisterInput): Promise<SessionUser> {
    const name = input.name.trim(); const email = input.email.trim().toLowerCase(); const password = String(input.password)
    if (name.length < 2 || name.length > 80) throw Object.assign(new Error('姓名长度需为 2 到 80 个字符'), { code: 'VALIDATION_ERROR', status: 400 })
    if (!/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error('请输入有效邮箱'), { code: 'VALIDATION_ERROR', status: 400 })
    if (password.length < 8) throw Object.assign(new Error('密码至少需要 8 个字符'), { code: 'VALIDATION_ERROR', status: 400 })
    const passwordHash = await hashPassword(password)
    const id = randomUUID()
    const result = await this.db.query<any>(
      `WITH inserted AS (
         INSERT INTO users (id, email, display_name, password_hash, is_active)
         VALUES ($1::uuid, $2, $3, $4, true)
         ON CONFLICT DO NOTHING
         RETURNING id, email, display_name
       )
       SELECT i.id, i.email, i.display_name, COALESCE(d.code, '') AS department_id
       FROM inserted i LEFT JOIN departments d ON false`, [id, email, name, passwordHash])
    const row = result.rows[0]
    if (!row) throw Object.assign(new Error('该邮箱已注册，请直接登录'), { code: 'EMAIL_ALREADY_EXISTS', status: 409 })
    const role = await this.db.query<any>(`SELECT id FROM roles WHERE code = 'recruiter' LIMIT 1`)
    if (role.rows[0]?.id) await this.db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, [id, role.rows[0].id])
    return { id: row.id, name: row.display_name, email: row.email, role: 'recruiter', departmentId: row.department_id ?? '' }
  }

  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    const result = await this.db.query<any>(
      `SELECT o.id, o.name, o.kind, o.status, o.created_at, o.archived_at, o.service_status, o.trial_ends_at, organization_service_available(o.id) AS service_available, om.role
         FROM organizations o JOIN organization_members om ON om.organization_id = o.id
        WHERE om.user_id = $1::uuid ORDER BY o.status = 'active' DESC, o.created_at DESC`, [userId])
    return result.rows.map((row) => ({ id: row.id, name: row.name, kind: row.kind, status: row.status, role: row.role, createdAt: iso(row.created_at), serviceStatus: row.service_status, trialEndsAt: row.trial_ends_at ? iso(row.trial_ends_at) : null, serviceAvailable: row.service_available, ...(row.archived_at ? { archivedAt: iso(row.archived_at) } : {}) }))
  }

  async createWorkspace(userId: string, input: WorkspaceCreateInput): Promise<WorkspaceSummary> {
    const name = input.name.trim()
    if (!['test', 'production'].includes(input.kind)) throw Object.assign(new Error('企业类型只能是测试企业或正式企业'), { code: 'VALIDATION_ERROR', status: 400 })
    if (name.length < 2 || name.length > 120) throw Object.assign(new Error('企业名称长度需为 2 到 120 个字符'), { code: 'VALIDATION_ERROR', status: 400 })
    const result = await this.db.query<any>(
      `WITH created AS (INSERT INTO organizations (name, kind, created_by, service_status, trial_ends_at) VALUES ($1, $2, $3::uuid, 'trial', now() + interval '14 days') RETURNING id, name, kind, status, created_at, service_status, trial_ends_at), membership AS (INSERT INTO organization_members (organization_id, user_id, role, business_role) SELECT id, $3::uuid, 'owner', 'recruiter' FROM created RETURNING organization_id) SELECT created.* FROM created JOIN membership ON membership.organization_id = created.id`, [name, input.kind, userId])
    const row = result.rows[0]
    if (!row) throw new Error('创建企业失败')
    return { id: row.id, name: row.name, kind: row.kind, status: row.status, role: 'owner', createdAt: iso(row.created_at), serviceStatus: row.service_status, trialEndsAt: row.trial_ends_at ? iso(row.trial_ends_at) : null, serviceAvailable: true }
  }

  private async assertOwner(userId: string, workspaceId: string): Promise<any> {
    const result = await this.db.query<any>(`SELECT o.id, o.kind, o.status FROM organizations o JOIN organization_members om ON om.organization_id = o.id WHERE o.id = $1::uuid AND om.user_id = $2::uuid AND om.role = 'owner' LIMIT 1`, [workspaceId, userId])
    const row = result.rows[0]
    if (!row) throw Object.assign(new Error('无权操作该企业'), { code: 'FORBIDDEN', status: 403 })
    return row
  }

  async archiveWorkspace(userId: string, workspaceId: string): Promise<void> {
    await this.assertOwner(userId, workspaceId)
    await this.db.query(`UPDATE organizations SET status = 'archived', archived_at = now() WHERE id = $1::uuid`, [workspaceId])
    await this.db.query(`UPDATE sessions SET active_organization_id = NULL WHERE active_organization_id = $1::uuid`, [workspaceId])
  }

  async resetWorkspace(userId: string, workspaceId: string): Promise<void> {
    const workspace = await this.assertOwner(userId, workspaceId)
    if (workspace.status !== 'active') throw Object.assign(new Error('已归档的企业不能重置'), { code: 'WORKSPACE_ARCHIVED', status: 400 })
    if (workspace.kind !== 'test') throw Object.assign(new Error('只有测试企业可以重新开始'), { code: 'TEST_WORKSPACE_REQUIRED', status: 400 })
    await this.db.query(`UPDATE organizations SET updated_at = now(), status = 'active', archived_at = NULL WHERE id = $1::uuid`, [workspaceId])
  }

  async selectWorkspace(sessionId: string, userId: string, workspaceId: string): Promise<SessionUser> {
    const result = await this.db.query<any>(`SELECT o.id AS workspace_id, o.name AS workspace_name, o.kind, u.display_name AS name, u.email, (SELECT p.role FROM platform_operators p WHERE p.user_id=u.id AND p.is_active=true) AS platform_role, COALESCE(d.code,om.department_id::text) AS department_id, om.business_role AS role FROM organizations o JOIN organization_members om ON om.organization_id = o.id JOIN users u ON u.id = om.user_id LEFT JOIN departments d ON d.id=om.department_id WHERE o.id = $1::uuid AND om.user_id = $2::uuid AND u.is_active=true AND organization_service_available(o.id) LIMIT 1`, [workspaceId, userId])
    const row = result.rows[0]
    if (!row) throw Object.assign(new Error('无权访问该企业'), { code: 'FORBIDDEN', status: 403 })
    const updated = await this.db.query<any>(`UPDATE sessions SET active_organization_id = $1::uuid WHERE id = $2::uuid AND user_id = $3::uuid RETURNING id`, [workspaceId, sessionId, userId])
    if (!updated.rows[0]) throw Object.assign(new Error('登录状态已失效'), { code: 'AUTHENTICATION_REQUIRED', status: 401 })
    return { id: userId, name: row.name, email: row.email, role: row.role, departmentId: row.department_id ?? '', workspaceId: row.workspace_id, workspaceName: row.workspace_name, workspaceKind: row.kind, ...(row.platform_role ? {platformRole: row.platform_role} : {}) }
  }

  async createSession(user: SessionUser, ttlMs = TTL_MS, metadata: { userAgent?: string; ipAddress?: string } = {}) {
    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    const expires = new Date(now.getTime() + ttlMs)
    const id = randomUUID()
    const csrfHash = hash(randomBytes(32).toString('base64url'))
    const hasWorkspace = Boolean(user.workspaceId)
    const result = hasWorkspace
      ? await this.db.query<{ id: string; user_id: string; token_hash: string; created_at: Date; expires_at: Date; last_seen_at: Date }>(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at, created_at, last_seen_at, user_agent, ip_address, active_organization_id)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $6, $7, $8::inet, $9::uuid) RETURNING id, user_id, token_hash, created_at, expires_at, last_seen_at`,
        [id, user.id, hash(token), csrfHash, expires, now, metadata.userAgent ?? null, metadata.ipAddress ?? null, user.workspaceId],
      )
      : await this.db.query<{ id: string; user_id: string; token_hash: string; created_at: Date; expires_at: Date; last_seen_at: Date }>(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_token_hash, expires_at, created_at, last_seen_at, user_agent, ip_address)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $6, $7, $8::inet) RETURNING id, user_id, token_hash, created_at, expires_at, last_seen_at`,
        [id, user.id, hash(token), csrfHash, expires, now, metadata.userAgent ?? null, metadata.ipAddress ?? null],
      )
    const row = result.rows[0]
    if (!row) throw new Error('Failed to create session')
    return { token, session: { sessionId: row.id, userId: row.user_id, tokenHash: row.token_hash, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), lastSeenAt: iso(row.last_seen_at), user } }
  }

  async findSessionByToken(token: string): Promise<AuthSession | undefined> {
    if (!token) return undefined
    const result = await this.db.query<any>(
      `SELECT s.id, s.user_id, s.token_hash, s.created_at, s.expires_at, s.last_seen_at, s.active_organization_id, active_o.name AS active_o_name, active_o.kind AS active_o_kind,
              (SELECT p.role FROM platform_operators p WHERE p.user_id=u.id AND p.is_active=true) AS platform_role,
              u.display_name AS name, u.email,
              CASE WHEN s.active_organization_id IS NOT NULL THEN COALESCE(active_m.business_role,'recruiter') ELSE COALESCE(ur.role,'recruiter') END AS role,
              CASE WHEN s.active_organization_id IS NOT NULL THEN active_m.department_id ELSE u.department_id END AS department_id,
              CASE WHEN s.active_organization_id IS NOT NULL THEN active_d.code ELSE d.code END AS department_code
         FROM sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN LATERAL (SELECT r.code AS role FROM user_roles x JOIN roles r ON r.id = x.role_id WHERE x.user_id = u.id ORDER BY r.code LIMIT 1) ur ON true
        LEFT JOIN organization_members active_m ON active_m.organization_id=s.active_organization_id AND active_m.user_id=u.id AND EXISTS (SELECT 1 FROM organizations ao WHERE ao.id=active_m.organization_id AND organization_service_available(ao.id))
        LEFT JOIN departments active_d ON active_d.id=active_m.department_id
        LEFT JOIN organizations active_o ON active_o.id = s.active_organization_id AND organization_service_available(active_o.id) AND active_m.user_id IS NOT NULL
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.is_active = true
        LIMIT 1`, [hash(token)])
    const row = result.rows[0]
    if (!row) return undefined
    await this.db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1::uuid', [row.id])
    const user: SessionUser = { id: row.user_id, name: row.name, email: row.email, role: row.role, departmentId: row.department_code ?? row.department_id ?? '', ...(row.platform_role ? {platformRole: row.platform_role} : {}), ...(row.active_organization_id && !row.active_o_name ? {workspaceAccessIssue: 'unavailable' as const} : {}), ...(row.active_organization_id && row.active_o_name ? { workspaceId: row.active_organization_id, workspaceName: row.active_o_name, workspaceKind: row.active_o_kind } : {}) }
    return { sessionId: row.id, userId: row.user_id, tokenHash: row.token_hash, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), lastSeenAt: new Date().toISOString(), user }
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1::uuid AND revoked_at IS NULL', [sessionId])
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.revokeSession(sessionId)
  }

  async cleanupExpiredSessions(): Promise<number> {
    const result = await this.db.query<{ count: string }>('WITH deleted AS (DELETE FROM sessions WHERE expires_at <= now() OR revoked_at <= now() - interval \'30 days\' RETURNING 1) SELECT count(*)::text AS count FROM deleted')
    return Number(result.rows[0]?.count ?? 0)
  }
}
