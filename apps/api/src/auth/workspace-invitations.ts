import { randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { assertSingleEnterprise } from './single-enterprise.js'
import { requireReadyWorkspaceSchema, type WorkspaceSchemaRegistry } from './workspace-context.js'

export const INVITABLE_ROLES = ['recruiter'] as const
const LEGACY_INVITABLE_ROLES = ['recruiter', 'hiring_manager', 'approver', 'interviewer']
const normalizeBusinessRole = (value: unknown): 'recruiter' => {
  const businessRole = String(value ?? 'recruiter')
  if (!LEGACY_INVITABLE_ROLES.includes(businessRole)) {
    fail('VALIDATION_ERROR', '企业成员只能使用企业用户身份，不能通过邀请授予系统管理员或平台权限')
  }
  // 旧客户端和历史数据仍可能传入旧角色值，统一落为兼容存储值 recruiter。
  return 'recruiter'
}
export class InvitationError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message) }
}
const fail = (code: string, message: string, status = 400): never => { throw new InvitationError(code, message, status) }
const uuid = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('VALIDATION_ERROR', '企业或成员标识无效')
  return value
}
export function normalizeInvitationCode(value: unknown): string {
  const code = typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : ''
  if (!/^[A-F0-9]{24}$/.test(code)) fail('INVITATION_INVALID', '请输入完整的 24 位邀请码，支持粘贴邀请链接')
  return code
}
export function validateMemberInput(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['businessRole','membershipRole','departmentId'].includes(key))) fail('VALIDATION_ERROR', '成员设置仅支持企业身份和所属部门')
  const businessRole = normalizeBusinessRole(input.businessRole)
  const membershipRole = String(input.membershipRole ?? 'member')
  if (membershipRole !== 'member' && membershipRole !== 'admin') fail('VALIDATION_ERROR', '企业身份只能为普通成员或子管理员')
  const departmentId = typeof input.departmentId === 'string' && input.departmentId ? uuid(input.departmentId) : null
  return { businessRole, membershipRole, departmentId }
}
const date = (value: unknown) => value ? new Date(value as string).toISOString() : null
function toInvitation(row: Record<string, any>, includeCode = false) {
  return {
    id: row.id, workspaceId: row.organization_id, workspaceName: row.workspace_name,
    workspaceKind: row.workspace_kind, email: row.email, membershipRole: row.membership_role,
    businessRole: 'recruiter' as const, departmentId: row.department_id, departmentName: row.department_name,
    createdAt: date(row.created_at), expiresAt: date(row.expires_at), acceptedAt: date(row.accepted_at),
    shared: row.is_shared === true, joinedCount: Number(row.joined_count ?? 0),
    status: row.revoked_at ? 'revoked' : !row.is_shared && row.accepted_at ? 'accepted' : new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'pending',
    ...(includeCode ? { code: String(row.code).match(/.{6}/g)!.join('-') } : {}),
  }
}
const selectInvitation = `SELECT i.*, o.name AS workspace_name, o.kind AS workspace_kind, o.status AS workspace_status, organization_service_available(o.id) AS service_available,
          d.name AS department_name, (SELECT count(*) FROM organization_invitation_joins j WHERE j.invitation_id=i.id) AS joined_count
     FROM organization_invitations i JOIN organizations o ON o.id=i.organization_id
     LEFT JOIN departments d ON d.id=i.department_id AND d.organization_id=i.organization_id`

export async function readSharedInvitation(db: WorkspaceSchemaRegistry, value: unknown, lock = false) {
  const result = await db.query(selectInvitation + ' WHERE i.code=$1' + (lock ? ' FOR UPDATE OF i' : ''), [normalizeInvitationCode(value)])
  const row = result.rows[0]
  if (!row || !row.is_shared || row.workspace_status !== 'active' || row.service_available === false) fail('INVITATION_UNAVAILABLE', '邀请无效或企业不可用，请联系管理员生成新邀请', 404)
  if (row.revoked_at) fail('INVITATION_REVOKED', '邀请已撤销，请联系管理员重新邀请', 410)
  if (new Date(row.expires_at).getTime() <= Date.now()) fail('INVITATION_EXPIRED', '邀请码已过期，请联系管理员重新邀请', 410)
  return row
}

// Caller owns the transaction. Organization first, then invitation: same order as revoke/replace.
export async function joinSharedInvitation(db: WorkspaceSchemaRegistry, value: unknown, userId: string, routeSchemas = process.env.TENANT_SCHEMA_ROUTING === 'on') {
  const initial = await readSharedInvitation(db, value)
  const org = await db.query('SELECT * FROM organizations WHERE id=$1 AND organization_service_available(id) FOR UPDATE', [initial.organization_id])
  if (!org.rows[0]) fail('INVITATION_UNAVAILABLE', '企业不可用，无法加入', 410)
  const row = await readSharedInvitation(db, value, true)
  await assertSingleEnterprise(db, userId, row.organization_id)
  const existing = await db.query('SELECT is_active FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND ended_at IS NULL FOR UPDATE', [row.organization_id,userId])
  if (existing.rows[0] && !existing.rows[0].is_active) fail('MEMBERSHIP_DISABLED', '你在此企业的成员身份已停用，请联系企业管理员恢复', 403)
  if (!existing.rows[0]) {
    await db.query(`INSERT INTO organization_members (organization_id,user_id,role,business_role,department_id) VALUES ($1,$2,'member','recruiter',NULL)
      ON CONFLICT (organization_id,user_id) DO UPDATE SET role='member',business_role='recruiter',department_id=NULL,is_active=true,ended_at=NULL,joined_at=now()`, [row.organization_id,userId])
    await db.query('INSERT INTO organization_invitation_joins (invitation_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id,userId])
    await writeInvitationAudit(db, routeSchemas, row.organization_id,userId,'workspace.invitation.accept',row.id,{ membershipRole:'member', shared:true })
  }
  return { workspaceId:row.organization_id, workspaceName:row.workspace_name, alreadyMember:!!existing.rows[0], workspace:org.rows[0] }
}

async function writeInvitationAudit(db: WorkspaceSchemaRegistry, routeSchemas: boolean, workspaceId: string, actorId: string, action: string, id: string, metadata: Record<string, unknown> = {}) {
  // Invitations and memberships are shared; audit rows belong to the target company,
  // which can differ from the actor's currently selected workspace.
  const schema = routeSchemas ? await requireReadyWorkspaceSchema(db, workspaceId) : 'public'
  const insert = `INSERT INTO "${schema}".audit_logs (organization_id,actor_user_id,action,resource_type,resource_id,metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`
  // Pre-cutover companies require identical copies; sealed legacy snapshots stay frozen.
  const columns = 'id,organization_id,actor_user_id,action,resource_type,resource_id,request_id,ip_address,user_agent,metadata,created_at'
  const sql = schema === 'public' ? insert : `WITH inserted AS (${insert} RETURNING *)
    INSERT INTO public.audit_logs (${columns}) SELECT ${columns} FROM inserted
    WHERE public.read_company_data_cutover($1::uuid) IS NULL`
  await db.query(sql, [workspaceId,actorId,action,action.startsWith('workspace.member.') ? 'organization_member' : 'organization_invitation',id,JSON.stringify(metadata)])
}

export class WorkspaceInvitationsService {
  private readonly summaryRequests = new Map<string, { count:number; expiresAt:number }>()

  private limitSummary(address: string) {
    const now = Date.now()
    if (this.summaryRequests.size >= 10000) {
      for (const [key,entry] of this.summaryRequests) if (entry.expiresAt <= now) this.summaryRequests.delete(key)
      if (!this.summaryRequests.has(address) && this.summaryRequests.size >= 10000) fail('INVITATION_RATE_LIMITED', '邀请查询过于频繁，请稍后再试', 429)
    }
    let entry = this.summaryRequests.get(address)
    if (!entry || entry.expiresAt <= now) { entry = {count:0,expiresAt:now+60000}; this.summaryRequests.set(address,entry) }
    if (++entry.count > 30) fail('INVITATION_RATE_LIMITED', '邀请查询过于频繁，请稍后再试', 429)
  }

  constructor(
    private readonly pool: Pool,
    private readonly routeSchemas = process.env.TENANT_SCHEMA_ROUTING === 'on',
  ) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  private async admin(db: Pool | PoolClient, workspaceId: string, userId: string, lock = false, requireService = true): Promise<string> {
    const result = await db.query(
      `SELECT m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id
        WHERE o.id=$1 AND (${requireService ? 'organization_service_available(o.id)' : 'true'}) AND m.user_id=$2 AND m.is_active AND m.role IN ('owner','admin') AND EXISTS(SELECT 1 FROM users u WHERE u.id=m.user_id AND u.is_active)
        ${lock ? 'FOR SHARE OF o, m' : ''}`, [uuid(workspaceId), userId])
    if (!result.rows[0]) fail('WORKSPACE_ADMIN_REQUIRED', '仅企业管理员可以管理本企业成员和邀请', 403)
    return result.rows[0].role
  }

  async list(workspaceId: string, actorId: string) {
    await this.admin(this.pool, workspaceId, actorId)
    const result = await this.pool.query(selectInvitation + ' WHERE i.organization_id=$1 ORDER BY i.created_at DESC LIMIT 200', [workspaceId])
    return result.rows.map(row => toInvitation(row, true))
  }

  async create(workspaceId: string, actorId: string, input: Record<string, unknown>) {
    if (Object.keys(input).some(key => key !== 'replace') || (input.replace !== undefined && typeof input.replace !== 'boolean')) fail('VALIDATION_ERROR', '邀请固定有效 3 天，不绑定邮箱或预设权限')
    return this.transaction(async db => {
      await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [uuid(workspaceId)])
      await this.admin(db, workspaceId, actorId, true)
      const active = await db.query(selectInvitation + ' WHERE i.organization_id=$1 AND i.is_shared AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp() ORDER BY i.created_at DESC LIMIT 1', [workspaceId])
      if (active.rows[0] && !input.replace) return toInvitation(active.rows[0], true)
      if (input.replace) await db.query('UPDATE organization_invitations SET revoked_at=now() WHERE organization_id=$1 AND revoked_at IS NULL', [workspaceId])
      const result = await db.query(
        `INSERT INTO organization_invitations (organization_id,code,email,membership_role,business_role,department_id,created_by,created_at,expires_at,is_shared)
         VALUES ($1,$2,NULL,'member','recruiter',NULL,$3,now(),now()+interval '72 hours',true) RETURNING id`,
        [workspaceId, randomBytes(12).toString('hex').toUpperCase(), actorId])
      await this.audit(db, workspaceId, actorId, 'workspace.invitation.create', result.rows[0].id, { shared: true, hours: 72, replaced: input.replace === true })
      const row = await db.query(selectInvitation + ' WHERE i.id=$1', [result.rows[0].id])
      return toInvitation(row.rows[0], true)
    })
  }

  async revoke(workspaceId: string, actorId: string, invitationId: string) {
    return this.transaction(async db => {
      await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [uuid(workspaceId)])
      await this.admin(db, workspaceId, actorId, true)
      const result = await db.query('UPDATE organization_invitations SET revoked_at=now() WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL RETURNING id', [uuid(invitationId), workspaceId])
      if (!result.rows[0]) fail('INVITATION_NOT_REVOCABLE', '邀请不存在或已经撤销', 409)
      await this.audit(db, workspaceId, actorId, 'workspace.invitation.revoke', invitationId)
      return { ok: true }
    })
  }

  async summary(value: unknown, address?: string) {
    if (address !== undefined) this.limitSummary(address)
    const row = await readSharedInvitation(this.pool, value)
    return { workspaceName: row.workspace_name, expiresAt: date(row.expires_at), shared: true }
  }

  async preview(value: unknown, userId: string) {
    const row = await readSharedInvitation(this.pool, value)
    const user = await this.pool.query('SELECT id FROM users WHERE id=$1 AND is_active=true', [userId])
    if (!user.rows[0]) fail('AUTHENTICATION_REQUIRED', '请重新登录', 401)
    return toInvitation(row)
  }

  async accept(value: unknown, userId: string) {
    return this.transaction(async db => {
      const { workspaceId,workspaceName,alreadyMember } = await joinSharedInvitation(db,value,userId,this.routeSchemas)
      return { workspaceId,workspaceName,alreadyMember }
    })
  }

  async members(workspaceId: string, actorId: string) {
    await this.admin(this.pool, workspaceId, actorId, false, false)
    const result = await this.pool.query(
      `SELECT u.id,u.display_name AS name,u.email,m.role AS membership_role,
         m.business_role,
         m.department_id,d.name AS department_name,m.joined_at,m.is_active,u.is_active AS account_active
      FROM organization_members m JOIN users u ON u.id=m.user_id LEFT JOIN departments d ON d.id=m.department_id AND d.organization_id=m.organization_id
       WHERE m.organization_id=$1 AND m.ended_at IS NULL ORDER BY m.joined_at`, [workspaceId])
      return result.rows.map(row => ({id:row.id,name:row.name,email:row.email,membershipRole:row.membership_role,businessRole:'recruiter' as const,departmentId:row.department_id,departmentName:row.department_name,joinedAt:date(row.joined_at),isActive:row.is_active,accountActive:row.account_active}))
  }

  async updateMember(workspaceId: string, actorId: string, userId: string, input: Record<string, unknown>) {
    const data = validateMemberInput(input)
    return this.transaction(async (db) => {
      await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [uuid(workspaceId)])
      const role = await this.admin(db, workspaceId, actorId, true)
      if (actorId === userId) fail('FORBIDDEN', '不能修改自己的企业权限', 403)
      const target = await db.query('SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND ended_at IS NULL FOR UPDATE', [workspaceId, uuid(userId)])
      if (!target.rows[0]) fail('NOT_FOUND', '成员不存在', 404)
      if (target.rows[0].role === 'owner') fail('FORBIDDEN', '主管理员身份只能通过交接变更', 403)
      if (role !== 'owner' && (target.rows[0].role !== 'member' || data.membershipRole !== 'member')) fail('FORBIDDEN', '只有企业主管理员可以任免或修改子管理员', 403)
      if (data.departmentId) {
        const dept = await db.query('SELECT id FROM departments WHERE id=$1 AND organization_id=$2 AND is_active=true', [data.departmentId, workspaceId])
        if (!dept.rows[0]) fail('VALIDATION_ERROR', '所选部门不存在或已停用')
      }
      await db.query('UPDATE organization_members SET role=$3,business_role=$4,department_id=$5 WHERE organization_id=$1 AND user_id=$2', [workspaceId,userId,data.membershipRole,data.businessRole,data.departmentId])
      await this.audit(db,workspaceId,actorId,'workspace.member.update',userId, { previousRole: target.rows[0].role, membershipRole: data.membershipRole, departmentId: data.departmentId })
      return { ok: true }
    })
  }

  async setMemberStatus(workspaceId: string, actorId: string, userId: string, input: Record<string, unknown>) {
    if (typeof input.isActive !== 'boolean' || Object.keys(input).some(key => !['isActive', 'reason'].includes(key))) fail('VALIDATION_ERROR', '请指定成员状态')
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 2 || reason.length > 500) fail('VALIDATION_ERROR', '请填写 2 到 500 字的操作原因')
    return this.transaction(async db => {
      await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [uuid(workspaceId)])
      const role = await this.admin(db, workspaceId, actorId, true)
      const target = await db.query('SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 AND ended_at IS NULL FOR UPDATE', [workspaceId, uuid(userId)])
      if (!target.rows[0]) fail('NOT_FOUND', '成员不存在', 404)
      if (actorId === userId || target.rows[0].role === 'owner' || (role !== 'owner' && target.rows[0].role !== 'member')) fail('FORBIDDEN', '不能停用自己或主管理员，子管理员只能管理普通成员', 403)
      await db.query('UPDATE organization_members SET is_active=$3 WHERE organization_id=$1 AND user_id=$2', [workspaceId, userId, input.isActive])
      await this.audit(db, workspaceId, actorId, 'workspace.member.status', userId, { isActive: input.isActive, reason })
      return { ok: true }
    })
  }

  async transferOwnership(workspaceId: string, actorId: string, userId: string, input: Record<string, unknown>) {
    const reason = String(input.reason ?? '').trim()
    if (reason.length < 2 || reason.length > 500) fail('VALIDATION_ERROR', '请填写 2 到 500 字的交接原因')
    return this.transaction(async db => {
      await db.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [uuid(workspaceId)])
      const role = await this.admin(db, workspaceId, actorId, true)
      if (role !== 'owner' || actorId === userId) fail('FORBIDDEN', '只有企业主管理员可以交接给其他成员', 403)
      const target = await db.query('SELECT m.user_id FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.is_active AND u.is_active FOR UPDATE OF m,u', [workspaceId, uuid(userId)])
      if (!target.rows[0]) fail('NOT_FOUND', '目标成员不存在或已停用', 404)
      await db.query("UPDATE organization_members SET role='admin' WHERE organization_id=$1 AND user_id=$2 AND role='owner'", [workspaceId, actorId])
      await db.query("UPDATE organization_members SET role='owner' WHERE organization_id=$1 AND user_id=$2", [workspaceId, userId])
      await this.audit(db, workspaceId, actorId, 'workspace.member.transfer', userId, { previousOwnerId: actorId, reason })
      return { ok: true }
    })
  }

  private async audit(db: PoolClient, workspaceId: string, actorId: string, action: string, id: string, metadata: Record<string, unknown> = {}) {
    await writeInvitationAudit(db, this.routeSchemas, workspaceId, actorId, action, id, metadata)
  }
}
