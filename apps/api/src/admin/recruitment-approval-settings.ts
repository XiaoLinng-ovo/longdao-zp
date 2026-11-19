export type RecruitmentApprovalMode = 'platform' | 'dingtalk'
export interface RecruitmentApprovalSettings { mode: RecruitmentApprovalMode }
interface Queryable {
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}

export class RecruitmentApprovalSettingsError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'RecruitmentApprovalSettingsError'
  }
}

/** Enterprise-scoped choice for new recruitment-request approval instances. */
export class RecruitmentApprovalSettingsService {
  constructor(private readonly pool: Queryable) {}

  private async assertEnterpriseAdmin(organizationId: string | undefined, actorId: string): Promise<string> {
    if (!organizationId) {
      throw new RecruitmentApprovalSettingsError('WORKSPACE_REQUIRED', '请先选择一个企业，再设置企业审批方式', 409)
    }
    const result = await this.pool.query<{ id: string }>(
      `SELECT o.id FROM organizations o
       JOIN organization_members om ON om.organization_id = o.id
       WHERE o.id = $1::uuid AND o.status = 'active'
         AND om.user_id = $2::uuid AND om.role IN ('owner', 'admin')
       LIMIT 1`,
      [organizationId, actorId],
    )
    const row = result.rows[0]
    if (!row) {
      throw new RecruitmentApprovalSettingsError('WORKSPACE_ADMIN_REQUIRED', '只有当前企业的所有者或管理员可以查看或修改审批方式', 403)
    }
    return row.id
  }

  async getMode(organizationId: string | undefined): Promise<RecruitmentApprovalSettings> {
    if (!organizationId) return { mode: 'platform' }
    const result = await this.pool.query<{ recruitment_approval_mode: RecruitmentApprovalMode }>(
      `SELECT recruitment_approval_mode FROM organizations
       WHERE id = $1::uuid AND status = 'active' LIMIT 1`,
      [organizationId],
    )
    const row = result.rows[0]
    if (!row) throw new RecruitmentApprovalSettingsError('WORKSPACE_NOT_FOUND', '当前企业不存在或已归档', 404)
    return { mode: row.recruitment_approval_mode }
  }

  async getForAdmin(organizationId: string | undefined, actorId: string): Promise<RecruitmentApprovalSettings> {
    const scopedId = await this.assertEnterpriseAdmin(organizationId, actorId)
    return this.getMode(scopedId)
  }

  async update(input: {
    organizationId?: string
    actorId: string
    mode: unknown
    requestId?: string
  }): Promise<RecruitmentApprovalSettings> {
    if (input.mode !== 'platform' && input.mode !== 'dingtalk') {
      throw new RecruitmentApprovalSettingsError('VALIDATION_ERROR', '审批方式必须是 platform 或 dingtalk', 400)
    }
    const scopedId = await this.assertEnterpriseAdmin(input.organizationId, input.actorId)
    const result = await this.pool.query<{ recruitment_approval_mode: RecruitmentApprovalMode }>(
      `WITH updated AS (
         UPDATE organizations o
         SET recruitment_approval_mode = $1, updated_at = now()
         WHERE o.id = $2::uuid AND o.status = 'active'
           AND EXISTS (SELECT 1 FROM organization_members om
                       WHERE om.organization_id = o.id AND om.user_id = $3::uuid AND om.role IN ('owner', 'admin'))
         RETURNING o.id, o.recruitment_approval_mode
       ), audited AS (
         INSERT INTO audit_logs
           (organization_id, actor_user_id, action, resource_type, resource_id, request_id, metadata)
         SELECT id, $3::uuid, 'admin.recruitment_approval_mode.update', 'organization_approval_settings', id, $4,
                jsonb_build_object('mode', recruitment_approval_mode)
         FROM updated
         RETURNING id
       )
       SELECT updated.recruitment_approval_mode
       FROM updated INNER JOIN audited ON true`,
      [input.mode, scopedId, input.actorId, input.requestId ?? null],
    )
    const row = result.rows[0]
    if (!row) throw new RecruitmentApprovalSettingsError('WORKSPACE_NOT_FOUND', '当前企业不存在或已归档', 404)
    return { mode: row.recruitment_approval_mode }
  }
}
