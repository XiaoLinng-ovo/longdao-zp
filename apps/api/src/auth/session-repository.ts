import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AuthSession, SessionUser } from './types.js'
import { verifyPassword } from './password.js'

export interface SessionRepository {
  findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined>
  createSession(user: SessionUser, ttlMs?: number, metadata?: { userAgent?: string; ipAddress?: string }): Promise<{ session: AuthSession; token: string }>
  findSessionByToken(token: string): Promise<AuthSession | undefined>
  revokeSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  cleanupExpiredSessions(): Promise<number>
}

interface Queryable { query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> }
const TTL_MS = 1000 * 60 * 60 * 12
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly db: Queryable) {}

  async findUserByEmailPassword(email: string, password: string): Promise<SessionUser | undefined> {
    const result = await this.db.query<any>(
      `SELECT u.id, u.display_name, u.email, u.password_hash, u.department_id,
              COALESCE((SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY r.code LIMIT 1), 'recruiter') AS role
         FROM users u WHERE lower(u.email) = lower($1) AND u.is_active = true LIMIT 1`, [email.trim()])
    const row = result.rows[0]
    if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) return undefined
    return { id: row.id, name: row.display_name, email: row.email, role: row.role, departmentId: row.department_id ?? '' }
  }

  async createSession(user: SessionUser, ttlMs = TTL_MS, metadata: { userAgent?: string; ipAddress?: string } = {}) {
    const token = randomBytes(32).toString('base64url')
    const now = new Date()
    const expires = new Date(now.getTime() + ttlMs)
    const id = randomUUID()
    const csrfHash = hash(randomBytes(32).toString('base64url'))
    const result = await this.db.query<{ id: string; user_id: string; token_hash: string; created_at: Date; expires_at: Date; last_seen_at: Date }>(
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
      `SELECT s.id, s.user_id, s.token_hash, s.created_at, s.expires_at, s.last_seen_at,
              u.name, u.email, COALESCE(ur.role, 'recruiter') AS role, u.department_id
         FROM sessions s JOIN users u ON u.id = s.user_id
         LEFT JOIN LATERAL (SELECT r.code AS role FROM user_roles x JOIN roles r ON r.id = x.role_id WHERE x.user_id = u.id ORDER BY r.code LIMIT 1) ur ON true
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        LIMIT 1`, [hash(token)])
    const row = result.rows[0]
    if (!row) return undefined
    await this.db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1::uuid', [row.id])
    const user: SessionUser = { id: row.user_id, name: row.name, email: row.email, role: row.role, departmentId: row.department_id }
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
