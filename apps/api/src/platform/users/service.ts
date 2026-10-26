import { randomInt } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { hashPassword } from '../../auth/password.js'
import { HttpError } from '../../http.js'
import { PlatformService } from '../service.js'
import type { PlatformUserDetail, PlatformUserListQuery, PlatformUserProfileInput, PlatformUserStatusInput } from './types.js'
import { validateProfileInput, validateReasonInput, validateStatusInput, validateUserId, validateUserListQuery } from './validation.js'

const date = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
const optionalDate = (value: unknown): string | null => value === null || value === undefined ? null : date(value)

function maskPhone(value: unknown): string | null {
  if (!value) return null
  const phone = String(value)
  if (phone.length < 7) return phone
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

function generateTemporaryPassword(): string {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%*-_']
  const all = groups.join('')
  const pick = (characters: string) => characters[randomInt(characters.length)]!
  const password = groups.map(pick)
  while (password.length < 16) password.push(pick(all))
  for (let index = password.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1)
    ;[password[index], password[swap]] = [password[swap]!, password[index]!]
  }
  return password.join('')
}

function userFromRow(row: Record<string, any>) {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: String(row.email),
    phone: row.phone === null || row.phone === undefined ? null : String(row.phone),
    isActive: Boolean(row.is_active),
    platformRole: row.platform_role ?? null,
    registrationSource: String(row.registration_source ?? 'legacy'),
    createdAt: date(row.created_at),
    lastLoginAt: optionalDate(row.last_login_at),
  }
}

function workspaceFromRow(row: Record<string, any>) {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind,
    status: row.status,
    serviceStatus: row.service_status,
    membershipRole: row.membership_role,
    businessRole: String(row.business_role),
    departmentId: row.department_id ?? null,
    departmentName: row.department_name ?? null,
    joinedAt: date(row.joined_at),
  }
}

export class PlatformUsersService {
  private readonly access: PlatformService

  constructor(private readonly pool: Pool) {
    this.access = new PlatformService(pool)
  }

  async list(actorId: string, searchParams: URLSearchParams) {
    await this.access.requireAccess(actorId)
    const query = validateUserListQuery(searchParams)
    const values: unknown[] = [
      query.q || null,
      query.status === 'active' ? true : query.status === 'disabled' ? false : null,
      query.workspaceId,
      query.platformRole === 'none' ? null : query.platformRole,
      query.platformRole,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ]
    const filter = `
      ($1::text IS NULL OR position(lower($1) in lower(concat_ws(' ',u.display_name,u.email,coalesce(u.phone,''),u.id))) > 0
        OR EXISTS (SELECT 1 FROM organization_members sm JOIN organizations so ON so.id=sm.organization_id
                   WHERE sm.user_id=u.id AND position(lower($1) in lower(so.name)) > 0))
      AND ($2::boolean IS NULL OR u.is_active=$2::boolean)
      AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM organization_members wm WHERE wm.user_id=u.id AND wm.organization_id=$3::uuid))
      AND ($5::text IS NULL OR ($5='none' AND p.role IS NULL) OR p.role=$4::text)`
    const count = await this.pool.query<{ total: number }>(
      `SELECT count(*)::integer AS total FROM users u
       LEFT JOIN platform_operators p ON p.user_id=u.id AND p.is_active=true
       WHERE ${filter}`,
      values.slice(0, 5),
    )
    const rows = await this.pool.query<any>(
      `SELECT u.id,u.display_name,u.email,u.phone,u.is_active,u.created_at,u.last_login_at,u.registration_source,
              p.role AS platform_role,
              (SELECT count(*)::integer FROM organization_members m WHERE m.user_id=u.id) AS workspace_count,
              pw.id AS workspace_id,pw.name AS workspace_name,pw.kind AS workspace_kind,pw.status AS workspace_status,
              pw.service_status AS workspace_service_status,pw.membership_role,pw.business_role
         FROM users u
         LEFT JOIN platform_operators p ON p.user_id=u.id AND p.is_active=true
         LEFT JOIN LATERAL (
           SELECT o.id,o.name,o.kind,o.status,o.service_status,m.role AS membership_role,m.business_role
             FROM organization_members m JOIN organizations o ON o.id=m.organization_id
            WHERE m.user_id=u.id ORDER BY m.joined_at,o.id LIMIT 1
         ) pw ON true
        WHERE ${filter}
        ORDER BY u.created_at DESC,u.id DESC
        LIMIT $6 OFFSET $7`,
      values,
    )
    return {
      items: rows.rows.map((row) => ({
        id: String(row.id),
        displayName: String(row.display_name),
        email: String(row.email),
        phoneMasked: maskPhone(row.phone),
        isActive: Boolean(row.is_active),
        platformRole: row.platform_role ?? null,
        registrationSource: String(row.registration_source ?? 'legacy'),
        createdAt: date(row.created_at),
        lastLoginAt: optionalDate(row.last_login_at),
        workspaceCount: Number(row.workspace_count ?? 0),
        primaryWorkspace: row.workspace_id ? {
          id: String(row.workspace_id),
          name: String(row.workspace_name),
          kind: row.workspace_kind,
          status: row.workspace_status,
          serviceStatus: row.workspace_service_status,
          membershipRole: row.membership_role,
          businessRole: String(row.business_role),
        } : null,
      })),
      total: Number(count.rows[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    }
  }

  async detail(actorId: string, userId: string): Promise<PlatformUserDetail> {
    await this.access.requireAccess(actorId)
    return this.readDetail(this.pool, validateUserId(userId))
  }

  private async readDetail(db: Pool | PoolClient, userId: string): Promise<PlatformUserDetail> {
    const userResult = await db.query<any>(
      `SELECT u.*,p.role AS platform_role FROM users u
       LEFT JOIN platform_operators p ON p.user_id=u.id AND p.is_active=true WHERE u.id=$1::uuid`,
      [userId],
    )
    const row = userResult.rows[0]
    if (!row) throw new HttpError(404, 'NOT_FOUND', '用户不存在')
    const [workspaces, sessions, platformAudit, workspaceAudit] = await Promise.all([
      db.query<any>(
        `SELECT o.id,o.name,o.kind,o.status,o.service_status,m.role AS membership_role,m.business_role,
                m.department_id,d.name AS department_name,m.joined_at
           FROM organization_members m JOIN organizations o ON o.id=m.organization_id
           LEFT JOIN departments d ON d.id=m.department_id
          WHERE m.user_id=$1::uuid ORDER BY m.joined_at,o.id`,
        [userId],
      ),
      db.query<any>(
        `SELECT id,created_at,last_seen_at,expires_at,ip_address,user_agent
           FROM sessions WHERE user_id=$1::uuid AND revoked_at IS NULL AND expires_at>now()
          ORDER BY last_seen_at DESC LIMIT 20`,
        [userId],
      ),
      db.query<any>(
        `SELECT a.id,'platform' AS source,a.action,a.organization_id,o.name AS organization_name,
                a.request_id,a.metadata,a.created_at
           FROM platform_audit_logs a LEFT JOIN organizations o ON o.id=a.organization_id
          WHERE a.actor_user_id=$1::uuid
             OR a.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id=$1::uuid)
          ORDER BY a.created_at DESC LIMIT 30`,
        [userId],
      ),
      db.query<any>(
        `SELECT a.id,'workspace' AS source,a.action,a.organization_id,o.name AS organization_name,
                a.request_id,a.metadata,a.created_at
           FROM audit_logs a LEFT JOIN organizations o ON o.id=a.organization_id
          WHERE a.actor_user_id=$1::uuid
             OR a.organization_id IN (SELECT organization_id FROM organization_members WHERE user_id=$1::uuid)
          ORDER BY a.created_at DESC LIMIT 30`,
        [userId],
      ),
    ])
    const recentAudit = [...platformAudit.rows, ...workspaceAudit.rows]
      .sort((left, right) => Date.parse(date(right.created_at)) - Date.parse(date(left.created_at)))
      .slice(0, 30)
      .map((item) => ({
        id: String(item.id),
        source: item.source,
        action: String(item.action),
        organizationId: item.organization_id ?? null,
        organizationName: item.organization_name ?? null,
        requestId: item.request_id ?? null,
        metadata: item.metadata ?? {},
        createdAt: date(item.created_at),
      }))
    return {
      user: userFromRow(row),
      workspaces: workspaces.rows.map(workspaceFromRow),
      activeSessions: sessions.rows.map((item) => ({
        id: String(item.id),
        createdAt: date(item.created_at),
        lastSeenAt: date(item.last_seen_at),
        expiresAt: date(item.expires_at),
        ipAddress: item.ip_address ?? null,
        userAgent: item.user_agent ?? null,
      })),
      recentAudit,
    }
  }

  private async transaction<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      const result = await action(db)
      await db.query('COMMIT')
      return result
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }

  private async audit(db: PoolClient, actorId: string, userId: string, action: string, requestId: string | undefined, metadata: Record<string, unknown>) {
    await db.query(
      `INSERT INTO platform_audit_logs (actor_user_id,organization_id,action,request_id,metadata)
       SELECT $1::uuid,(SELECT min(organization_id) FROM organization_members WHERE user_id=$2::uuid),$3,$4,$5::jsonb`,
      [actorId, userId, action, requestId ?? null, JSON.stringify({ targetUserId: userId, ...metadata })],
    )
  }

  async updateStatus(actorId: string, userId: string, input: Record<string, unknown>, requestId?: string) {
    validateUserId(userId)
    const data = validateStatusInput(input)
    if (actorId === userId && !data.isActive) throw new HttpError(409, 'SELF_DISABLE_FORBIDDEN', '不能停用当前登录的平台管理员')
    await this.transaction(async (db) => {
      await this.access.requireAccess(actorId, true, db, true)
      const target = await db.query<any>(
        `SELECT u.id,u.is_active,p.role AS platform_role FROM users u
         LEFT JOIN platform_operators p ON p.user_id=u.id AND p.is_active=true
         WHERE u.id=$1::uuid FOR UPDATE OF u`,
        [userId],
      )
      if (!target.rows[0]) throw new HttpError(404, 'NOT_FOUND', '用户不存在')
      if (!data.isActive && target.rows[0].platform_role === 'admin') {
        const activeAdmins = await db.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM platform_operators p JOIN users u ON u.id=p.user_id
           WHERE p.role='admin' AND p.is_active=true AND u.is_active=true`,
        )
        if (Number(activeAdmins.rows[0]?.count ?? 0) <= 1) throw new HttpError(409, 'LAST_PLATFORM_ADMIN', '不能停用最后一位有效平台管理员')
      }
      await db.query('UPDATE users SET is_active=$2,updated_at=now() WHERE id=$1::uuid', [userId, data.isActive])
      let revokedSessions = 0
      if (!data.isActive) {
        const revoked = await db.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1::uuid AND revoked_at IS NULL AND expires_at>now() RETURNING id`, [userId])
        revokedSessions = revoked.rowCount ?? revoked.rows.length
      }
      await this.audit(db, actorId, userId, 'platform.user.status', requestId, { reason: data.reason, isActive: data.isActive, revokedSessions })
    })
    return this.detail(actorId, userId)
  }

  async profile(actorId: string, userId: string, input: Record<string, unknown>, requestId?: string) {
    validateUserId(userId)
    const data: PlatformUserProfileInput = validateProfileInput(input)
    await this.transaction(async (db) => {
      await this.access.requireAccess(actorId, true, db, true)
      const sets: string[] = []
      const values: unknown[] = []
      if (data.displayName !== undefined) { values.push(data.displayName); sets.push(`display_name=$${values.length}`) }
      if (data.phone !== undefined) { values.push(data.phone); sets.push(`phone=$${values.length}`) }
      values.push(userId)
      const result = await db.query(`UPDATE users SET ${sets.join(',')},updated_at=now() WHERE id=$${values.length}::uuid RETURNING id`, values)
      if (!result.rows[0]) throw new HttpError(404, 'NOT_FOUND', '用户不存在')
      await this.audit(db, actorId, userId, 'platform.user.profile', requestId, {
        reason: data.reason,
        changed: Object.entries(data).filter(([key, value]) => key !== 'reason' && value !== undefined).map(([key]) => key),
      })
    })
    return this.detail(actorId, userId)
  }

  async revokeSessions(actorId: string, userId: string, input: Record<string, unknown>, requestId?: string) {
    validateUserId(userId)
    const data = validateReasonInput(input)
    let revokedSessions = 0
    await this.transaction(async (db) => {
      await this.access.requireAccess(actorId, true, db, true)
      const exists = await db.query('SELECT id FROM users WHERE id=$1::uuid FOR UPDATE', [userId])
      if (!exists.rows[0]) throw new HttpError(404, 'NOT_FOUND', '用户不存在')
      const revoked = await db.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1::uuid AND revoked_at IS NULL AND expires_at>now() RETURNING id`, [userId])
      revokedSessions = revoked.rowCount ?? revoked.rows.length
      await this.audit(db, actorId, userId, 'platform.user.sessions_revoked', requestId, { reason: data.reason, revokedSessions })
    })
    return { revokedSessions }
  }

  async resetPassword(actorId: string, userId: string, input: Record<string, unknown>, requestId?: string) {
    validateUserId(userId)
    const data = validateReasonInput(input)
    const temporaryPassword = generateTemporaryPassword()
    const passwordHash = await hashPassword(temporaryPassword)
    let revokedSessions = 0
    await this.transaction(async (db) => {
      await this.access.requireAccess(actorId, true, db, true)
      const exists = await db.query('SELECT id FROM users WHERE id=$1::uuid FOR UPDATE', [userId])
      if (!exists.rows[0]) throw new HttpError(404, 'NOT_FOUND', '用户不存在')
      await db.query('UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1::uuid', [userId, passwordHash])
      const revoked = await db.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1::uuid AND revoked_at IS NULL AND expires_at>now() RETURNING id`, [userId])
      revokedSessions = revoked.rowCount ?? revoked.rows.length
      await this.audit(db, actorId, userId, 'platform.user.password_reset', requestId, { reason: data.reason, revokedSessions })
    })
    return { temporaryPassword, revokedSessions }
  }
}
