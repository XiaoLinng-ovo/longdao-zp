import type { Pool, PoolClient } from 'pg'
import { HttpError } from '../http.js'
export type PlatformRole = 'admin' | 'viewer'
export type ServiceStatus = 'enabled' | 'trial' | 'suspended'
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', '企业 ID 无效')
  return value
}
const integer = (value: unknown, min: number, max: number, fallback: number) => {
  const n = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, 'VALIDATION_ERROR', '分页参数无效')
  return n
}
export function validateLifecyclePatch(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['serviceStatus', 'trialEndsAt', 'reason', 'expectedVersion'].includes(key))) throw new HttpError(400, 'VALIDATION_ERROR', '不支持的客户配置项')
  if (!['enabled', 'trial', 'suspended'].includes(String(input.serviceStatus))) throw new HttpError(400, 'VALIDATION_ERROR', '请选择启用、试用或暂停')
  if (typeof input.reason !== 'string' || input.reason.trim().length < 2 || input.reason.trim().length > 500) throw new HttpError(400, 'VALIDATION_ERROR', '请填写 2～500 字的操作原因')
  if (!Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion) < 1) throw new HttpError(400, 'VALIDATION_ERROR', '缺少有效版本，请刷新后重试')
  const status = input.serviceStatus as ServiceStatus
  let deadline: string | null = null
  if (status === 'trial') {
    if (typeof input.trialEndsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(input.trialEndsAt) || !Number.isFinite(Date.parse(input.trialEndsAt)) || Date.parse(input.trialEndsAt) <= Date.now()) throw new HttpError(400, 'VALIDATION_ERROR', '试用到期时间必须是带时区的未来时间')
    deadline = new Date(input.trialEndsAt).toISOString()
  } else if (input.trialEndsAt !== undefined && input.trialEndsAt !== null) throw new HttpError(400, 'VALIDATION_ERROR', '只有试用状态可设置到期时间')
  return { status, deadline, reason: input.reason.trim(), version: Number(input.expectedVersion) }
}
const view = (row: any) => ({
  id: row.id, name: row.name, kind: row.kind, status: row.status,
  serviceStatus: row.service_status, trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
  serviceVersion: Number(row.service_version), serviceAvailable: Boolean(row.service_available),
  memberCount: Number(row.member_count ?? 0), createdAt: new Date(row.created_at).toISOString(),
})
export class PlatformService {
  constructor(private readonly pool: Pool) {}
  async requireAccess(actorId: string, write = false, db: Pool | PoolClient = this.pool, lock = false): Promise<PlatformRole> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(actorId)) throw new HttpError(403, 'PLATFORM_PERMISSION_REQUIRED', '此账号未获平台运营授权')
    const result = await db.query(`SELECT p.role FROM platform_operators p JOIN users u ON u.id=p.user_id
      WHERE p.user_id=$1::uuid AND p.is_active=true AND u.is_active=true ${lock ? 'FOR SHARE OF p, u' : ''}`, [actorId])
    const role = result.rows[0]?.role
    if (!['admin', 'viewer'].includes(role) || (write && role !== 'admin')) throw new HttpError(403, 'PLATFORM_PERMISSION_REQUIRED', write ? '只有平台管理员可以执行此操作' : '此功能仅对已授权的平台运营人员开放')
    return role
  }
  async listCustomers(actorId: string, query: URLSearchParams) {
    await this.requireAccess(actorId)
    const page = integer(query.get('page'), 1, 1000000, 1), pageSize = integer(query.get('pageSize'), 1, 100, 20)
    const search = (query.get('search') ?? '').trim()
    if (search.length > 120) throw new HttpError(400, 'VALIDATION_ERROR', '搜索内容过长')
    const status = query.get('serviceStatus') || null
    if (status !== null && !['enabled', 'trial', 'suspended'].includes(status)) throw new HttpError(400, 'VALIDATION_ERROR', '客户状态筛选无效')
    const filter = `($1::text IS NULL OR position(lower($1) in lower(o.name)) > 0) AND ($2::text IS NULL OR o.service_status=$2)`
    const values = [search || null, status]
    const count = await this.pool.query(`SELECT count(*)::integer AS total FROM organizations o WHERE ${filter}`, values)
    const rows = await this.pool.query(`SELECT o.*, organization_service_available(o.id) AS service_available,
      (SELECT count(*) FROM organization_members m WHERE m.organization_id=o.id) AS member_count
      FROM organizations o WHERE ${filter} ORDER BY o.created_at DESC, o.id LIMIT $3 OFFSET $4`, [...values, pageSize, (page - 1) * pageSize])
    // Deliberately excludes HR records, owner personal data, model credentials, and enterprise prompts.
    return { items: rows.rows.map(view), total: Number(count.rows[0]?.total ?? 0), page, pageSize }
  }
  async updateLifecycle(actorId: string, organizationId: string, input: Record<string, unknown>, requestId?: string) {
    uuid(organizationId)
    const patch = validateLifecyclePatch(input)
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      await this.requireAccess(actorId, true, db, true)
      const current = (await db.query('SELECT * FROM organizations WHERE id=$1::uuid FOR UPDATE', [organizationId])).rows[0]
      if (!current) throw new HttpError(404, 'NOT_FOUND', '企业不存在')
      if (current.status !== 'active') throw new HttpError(409, 'WORKSPACE_ARCHIVED', '归档企业不能通过服务开关恢复，请单独处理归档流程')
      if (Number(current.service_version) !== patch.version) throw new HttpError(409, 'VERSION_CONFLICT', '客户状态已被其他运营人员修改，请刷新后重试')
      const result = await db.query(`UPDATE organizations SET service_status=$2, trial_ends_at=$3::timestamptz,
        service_version=service_version+1 WHERE id=$1::uuid RETURNING *, organization_service_available(id) AS service_available,
        (SELECT count(*) FROM organization_members WHERE organization_id=$1::uuid) AS member_count`, [organizationId, patch.status, patch.deadline])
      // Compute availability from the returned columns: STABLE SQL function may see the statement's pre-update snapshot.
      const row = result.rows[0]!
      row.service_available = row.status === 'active' && row.service_status !== 'suspended' && (row.service_status !== 'trial' || new Date(row.trial_ends_at).getTime() > Date.now()) && (row.paid_subscription_expires_at == null || new Date(row.paid_subscription_expires_at).getTime() > Date.now())
      await db.query(`INSERT INTO platform_audit_logs (actor_user_id,organization_id,action,request_id,metadata)
        VALUES ($1::uuid,$2::uuid,'platform.customer.lifecycle',$3,$4::jsonb)`, [actorId, organizationId, requestId ?? null, JSON.stringify({ reason: patch.reason, before: { serviceStatus: current.service_status, trialEndsAt: current.trial_ends_at }, after: { serviceStatus: patch.status, trialEndsAt: patch.deadline } })])
      await db.query('COMMIT')
      return view(row)
    } catch (error) { await db.query('ROLLBACK'); throw error }
    finally { db.release() }
  }
  async listAudit(actorId: string) {
    await this.requireAccess(actorId)
    const result = await this.pool.query(`SELECT a.id,a.action,a.organization_id,a.request_id,a.metadata,a.created_at,
      o.name AS organization_name FROM platform_audit_logs a LEFT JOIN organizations o ON o.id=a.organization_id
      ORDER BY a.created_at DESC,a.id DESC LIMIT 100`)
    return result.rows.map(row => ({ id: row.id, action: row.action, organizationId: row.organization_id, organizationName: row.organization_name, requestId: row.request_id, metadata: row.metadata, createdAt: new Date(row.created_at).toISOString() }))
  }
}
