import { randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export const INVITABLE_ROLES = ['recruiter', 'hiring_manager', 'approver', 'interviewer'] as const
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
export function validateInvitationInput(input: Record<string, unknown>) {
  const businessRole = String(input.businessRole ?? 'recruiter')
  if (!(INVITABLE_ROLES as readonly string[]).includes(businessRole)) fail('VALIDATION_ERROR', '请选择招聘专员、部门负责人、审批人或面试官')
  const membershipRole = String(input.membershipRole ?? 'member')
  if (!['member', 'admin'].includes(membershipRole)) fail('VALIDATION_ERROR', '企业身份只能为成员或企业管理员')
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (email && (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email))) fail('VALIDATION_ERROR', '请输入有效的接收邮箱')
  const expiresInDays = Number(input.expiresInDays ?? 7)
  if (![1, 3, 7, 30].includes(expiresInDays)) fail('VALIDATION_ERROR', '邀请有效期可选 1、3、7、30 天')
  const departmentId = typeof input.departmentId === 'string' && input.departmentId ? uuid(input.departmentId) : null
  if (businessRole === 'hiring_manager' && !departmentId) fail('VALIDATION_ERROR', '邀请部门负责人时必须选择所属部门')
  return { businessRole, membershipRole, email: email || null, expiresInDays, departmentId }
}
const date = (value: unknown) => value ? new Date(value as string).toISOString() : null
function toInvitation(row: Record<string, any>, includeCode = false) {
  return {
    id: row.id, workspaceId: row.organization_id, workspaceName: row.workspace_name,
    workspaceKind: row.workspace_kind, email: row.email, membershipRole: row.membership_role,
    businessRole: row.business_role, departmentId: row.department_id, departmentName: row.department_name,
    createdAt: date(row.created_at), expiresAt: date(row.expires_at), acceptedAt: date(row.accepted_at),
    status: row.revoked_at ? 'revoked' : row.accepted_at ? 'accepted' : new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'pending',
    ...(includeCode ? { code: String(row.code).match(/.{6}/g)!.join('-') } : {}),
  }
}
const selectInvitation =   `SELECT i.*, o.name AS workspace_name, o.kind AS workspace_kind, o.status AS workspace_status, organization_service_available(o.id) AS service_available,
          d.name AS department_name
     FROM organization_invitations i JOIN organizations o ON o.id=i.organization_id
     LEFT JOIN departments d ON d.id=i.department_id`

export class WorkspaceInvitationsService {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  private async admin(db: Pool | PoolClient, workspaceId: string, userId: string, lock = false): Promise<string> {
    const result = await db.query(
      `SELECT m.role FROM organizations o JOIN organization_members m ON m.organization_id=o.id
        WHERE o.id=$1 AND organization_service_available(o.id) AND m.user_id=$2 AND m.role IN ('owner','admin')
        ${lock ? 'FOR SHARE OF o, m' : ''}`, [uuid(workspaceId), userId])
    if (!result.rows[0]) fail('WORKSPACE_ADMIN_REQUIRED', '只有此企业的所有者或管理员可以管理成员和邀请', 403)
    return result.rows[0].role
  }

  async list(workspaceId: string, actorId: string) {
    await this.admin(this.pool, workspaceId, actorId)
    const result = await this.pool.query(selectInvitation + ' WHERE i.organization_id=$1 ORDER BY i.created_at DESC LIMIT 200', [workspaceId])
    return result.rows.map((row) => toInvitation(row, true))
  }

  async create(workspaceId: string, actorId: string, input: Record<string, unknown>) {
    const data = validateInvitationInput(input)
    return this.transaction(async (db) => {
      const actorRole = await this.admin(db, workspaceId, actorId, true)
      if (data.membershipRole === 'admin' && actorRole !== 'owner') fail('FORBIDDEN', '只有企业所有者可以邀请企业管理员', 403)
      if (data.departmentId) {
        const dept = await db.query('SELECT id FROM departments WHERE id=$1 AND is_active=true', [data.departmentId])
        if (!dept.rows[0]) fail('VALIDATION_ERROR', '所选部门不存在或已停用')
      }
      const code = randomBytes(12).toString('hex').toUpperCase()
      const result = await db.query(
        `INSERT INTO organization_invitations (organization_id, code, email, membership_role, business_role, department_id, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now()+$8*interval '1 day') RETURNING id`,
        [workspaceId, code, data.email, data.membershipRole, data.businessRole, data.departmentId, actorId, data.expiresInDays])
      await this.audit(db, workspaceId, actorId, 'workspace.invitation.create', result.rows[0].id)
      const row = await db.query(selectInvitation + ' WHERE i.id=$1', [result.rows[0].id])
      return toInvitation(row.rows[0], true)
    })
  }

  async revoke(workspaceId: string, actorId: string, invitationId: string) {
    return this.transaction(async (db) => {
      await this.admin(db, workspaceId, actorId, true)
      const result = await db.query(
        `UPDATE organization_invitations SET revoked_at=now()
         WHERE id=$1 AND organization_id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`, [uuid(invitationId), workspaceId])
      if (!result.rows[0]) fail('INVITATION_NOT_REVOCABLE', '邀请不存在、已经使用或已被撤销', 409)
      await this.audit(db, workspaceId, actorId, 'workspace.invitation.revoke', invitationId)
      return { ok: true }
    })
  }

  private async eligible(db: Pool | PoolClient, value: unknown, userId: string, lock = false) {
    const code = normalizeInvitationCode(value)
    const result = await db.query(selectInvitation + ' WHERE i.code=$1' + (lock ? ' FOR UPDATE OF i' : ''), [code])
    const row = result.rows[0]
    if (!row || row.workspace_status !== 'active' || row.service_available === false) fail('INVITATION_UNAVAILABLE', '邀请码无效，或企业已暂停、试用到期、归档', 404)
    if (row.revoked_at) fail('INVITATION_REVOKED', '此邀请已被管理员撤销，请联系管理员重新邀请', 410)
    if (row.accepted_at) fail('INVITATION_USED', '此邀请码已使用，请联系管理员获取新的邀请码', 409)
    if (new Date(row.expires_at).getTime() <= Date.now()) fail('INVITATION_EXPIRED', '此邀请码已过期，请联系管理员重新邀请', 410)
    const user = await db.query('SELECT email FROM users WHERE id=$1 AND is_active=true', [userId])
    if (!user.rows[0]) fail('AUTHENTICATION_REQUIRED', '登录状态已失效，请重新登录', 401)
    if (row.email && row.email.toLowerCase() !== user.rows[0].email.toLowerCase()) fail('INVITATION_EMAIL_MISMATCH', '此邀请限定接收邮箱，请使用收到邀请的邮箱登录', 403)
    return row
  }

  async preview(value: unknown, userId: string) { return toInvitation(await this.eligible(this.pool, value, userId)) }

  async accept(value: unknown, userId: string) {
    return this.transaction(async (db) => {
      const row = await this.eligible(db, value, userId, true)
      const org = await db.query("SELECT id FROM organizations WHERE id=$1 AND organization_service_available(id) FOR UPDATE", [row.organization_id])
      if (!org.rows[0]) fail('INVITATION_UNAVAILABLE', '企业已暂停、试用到期或归档，无法加入', 410)
      if (row.business_role === 'hiring_manager') {
        const dept = row.department_id && await db.query('SELECT id FROM departments WHERE id=$1 AND is_active=true', [row.department_id])
        if (!dept || !dept.rows[0]) fail('INVITATION_UNAVAILABLE', '邀请绑定的部门已停用，请联系管理员重新邀请', 409)
      }
      const inserted = await db.query(
        `INSERT INTO organization_members (organization_id,user_id,role,business_role,department_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING organization_id`,
        [row.organization_id,userId,row.membership_role,row.business_role,row.department_id])
      if (!inserted.rows[0]) fail('ALREADY_MEMBER', '你已经是此企业的成员，请直接切换到该企业；邀请码仍然有效', 409)
      await db.query('UPDATE organization_invitations SET accepted_at=now(),accepted_by=$2 WHERE id=$1', [row.id,userId])
      await this.audit(db, row.organization_id, userId, 'workspace.invitation.accept', row.id)
      return { workspaceId: row.organization_id, workspaceName: row.workspace_name }
    })
  }

  async members(workspaceId: string, actorId: string) {
    await this.admin(this.pool, workspaceId, actorId)
    const result = await this.pool.query(
      `SELECT u.id,u.display_name AS name,u.email,m.role AS membership_role,
         m.business_role,
         m.department_id,d.name AS department_name,m.joined_at
       FROM organization_members m JOIN users u ON u.id=m.user_id LEFT JOIN departments d ON d.id=m.department_id
       WHERE m.organization_id=$1 ORDER BY m.joined_at`, [workspaceId])
    return result.rows.map(row => ({id:row.id,name:row.name,email:row.email,membershipRole:row.membership_role,businessRole:row.business_role,departmentId:row.department_id,departmentName:row.department_name,joinedAt:date(row.joined_at)}))
  }

  async updateMember(workspaceId: string, actorId: string, userId: string, input: Record<string, unknown>) {
    const data = validateInvitationInput(input)
    return this.transaction(async (db) => {
      const actorRole = await this.admin(db, workspaceId, actorId, true)
      if (actorId === userId) fail('FORBIDDEN', '请由其他企业管理员调整你的权限', 403)
      const target = await db.query('SELECT role FROM organization_members WHERE organization_id=$1 AND user_id=$2 FOR UPDATE', [workspaceId, uuid(userId)])
      if (!target.rows[0]) fail('NOT_FOUND', '成员不存在', 404)
      if (target.rows[0].role === 'owner') fail('FORBIDDEN', '不能通过成员管理修改企业所有者', 403)
      if (actorRole !== 'owner' && (target.rows[0].role === 'admin' || data.membershipRole === 'admin')) fail('FORBIDDEN', '只有企业所有者可以调整企业管理员', 403)
      if (data.departmentId) {
        const dept = await db.query('SELECT id FROM departments WHERE id=$1 AND is_active=true', [data.departmentId])
        if (!dept.rows[0]) fail('VALIDATION_ERROR', '所选部门不存在或已停用')
      }
      await db.query('UPDATE organization_members SET role=$3,business_role=$4,department_id=$5 WHERE organization_id=$1 AND user_id=$2', [workspaceId,userId,data.membershipRole,data.businessRole,data.departmentId])
      await this.audit(db,workspaceId,actorId,'workspace.member.update',userId)
      return { ok: true }
    })
  }

  private async audit(db: PoolClient, workspaceId: string, actorId: string, action: string, id: string) {
    await db.query(
      `INSERT INTO audit_logs (organization_id,actor_user_id,action,resource_type,resource_id,metadata)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)`, [workspaceId,actorId,action,action.startsWith('workspace.member.') ? 'organization_member' : 'organization_invitation',id])
  }
}
