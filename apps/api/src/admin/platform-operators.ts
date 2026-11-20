import type { Pool, PoolClient } from 'pg'
import { HttpError } from '../http.js'
import { isSystemAdministrator } from '../auth/system-administrator.js'
import { isPlatformRole, type PlatformRole } from '../platform/roles.js'
import { validateReason, validateUserId, validateUserListQuery } from '../platform/users/validation.js'

export function validateOperatorInput(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['role', 'expectedRole', 'reason'].includes(key)) ||
      !(input.role === null || isPlatformRole(input.role)) ||
      !(input.expectedRole === null || isPlatformRole(input.expectedRole))) {
    throw new HttpError(400, 'VALIDATION_ERROR', '请选择有效的平台运营身份并提供原身份')
  }
  return { role: input.role as PlatformRole | null, expectedRole: input.expectedRole as PlatformRole | null, reason: validateReason(input.reason) }
}

export class PlatformOperatorsService {
  constructor(private readonly pool: Pool, private readonly env: NodeJS.ProcessEnv = process.env) {}

  private async authorize(db: Pool | PoolClient, actorId: string, lock = false) {
    validateUserId(actorId)
    const result = await db.query('SELECT user_no FROM users WHERE id=$1::uuid AND is_active=true' + (lock ? ' FOR SHARE' : ''), [actorId])
    if (!isSystemAdministrator({ userNo: result.rows[0]?.user_no } as Parameters<typeof isSystemAdministrator>[0], this.env)) {
      throw new HttpError(403, 'SYSTEM_ADMIN_REQUIRED', '仅系统管理员可以管理平台运营授权')
    }
  }

  async update(actorId: string, userId: string, input: Record<string, unknown>, requestId?: string) {
    await this.authorize(this.pool, actorId)
    throw new HttpError(410, 'PLATFORM_DELEGATION_DISABLED', '平台授权已停用，系统仅允许绑定的唯一系统管理员操作')
  }

  async list(actorId: string, searchParams: URLSearchParams) {
    await this.authorize(this.pool, actorId)
    const query = validateUserListQuery(searchParams)
    const values = [query.q || null, query.platformRole]
    const filter = `($1::text IS NULL OR position(lower($1) in lower(concat_ws(' ',u.display_name,u.email,u.user_no))) > 0)
      AND ($2::text IS NULL OR ($2='none' AND p.role IS NULL) OR p.role=$2)`
    const count = await this.pool.query(`SELECT count(*)::integer AS total FROM users u
      LEFT JOIN platform_operators p ON p.user_id=u.id AND p.is_active=true WHERE ${filter}`, values)
    const result = await this.pool.query(`SELECT u.id,u.user_no,u.display_name,u.email,u.is_active,p.role
      FROM users u LEFT JOIN platform_operators p ON p.user_id=u.id AND p.is_active=true
      WHERE ${filter} ORDER BY u.created_at DESC,u.id LIMIT $3 OFFSET $4`, [...values, query.pageSize, (query.page - 1) * query.pageSize])
    const audits = await this.pool.query(`SELECT a.id,a.created_at,a.metadata,actor.display_name AS actor_name,
      target.email AS target_email FROM platform_audit_logs a
      LEFT JOIN users actor ON actor.id=a.actor_user_id
      LEFT JOIN users target ON target.id::text=a.metadata->>'targetUserId'
      WHERE a.action='platform.operator.provision' ORDER BY a.created_at DESC,a.id DESC LIMIT 20`)
    return {
      items: result.rows.map(row => ({ id: row.id, userNo: row.user_no, displayName: row.display_name, email: row.email, isActive: row.is_active, platformRole: row.role ?? null })),
      total: Number(count.rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize,
      recentAudit: audits.rows.map(row => ({ id: row.id, createdAt: new Date(row.created_at).toISOString(), actorName: row.actor_name ?? '部署运维', targetEmail: row.target_email ?? '已删除账号', reason: row.metadata.reason, beforeRole: row.metadata.before?.is_active === false ? null : row.metadata.before?.role ?? null, afterRole: row.metadata.after?.isActive === false ? null : row.metadata.after?.role ?? null })),
    }
  }
}
