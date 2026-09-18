import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { DingTalkApprovalWorkflowError, type DingTalkApprovalRepository } from './approval-workflow.js'

const provider = 'dingtalk'

export class PostgresDingTalkApprovalRepository implements DingTalkApprovalRepository {
  constructor(private readonly pool: Pool) {}

  async resolveExternalUserId(internalUserId: string): Promise<string> {
    const result = await this.pool.query(
      `SELECT external_id FROM external_entity_mappings
       WHERE provider = $1 AND external_type = 'user' AND internal_type = 'user' AND internal_id = $2::uuid`,
      [provider, internalUserId],
    )
    const externalId = result.rows[0]?.external_id
    if (!externalId) throw new DingTalkApprovalWorkflowError('DINGTALK_USER_MAPPING_MISSING', '当前用户尚未映射钉钉用户 ID', 409)
    return String(externalId)
  }

  async getDepartmentPolicy(departmentId: string, subjectType: string) {
    const result = await this.pool.query(
      `SELECT p.process_code, m.external_id
       FROM department_approval_policies p
       JOIN external_entity_mappings m ON m.provider = 'dingtalk' AND m.external_type = 'department'
        AND m.internal_type = 'department' AND m.internal_id = p.department_id
       WHERE p.department_id = $1::uuid AND p.subject_type = $2 AND p.is_active = true`,
      [departmentId, subjectType],
    )
    const row = result.rows[0]
    if (!row) return undefined
    const externalId = Number(row.external_id)
    if (!Number.isSafeInteger(externalId)) throw new DingTalkApprovalWorkflowError('DINGTALK_DEPARTMENT_MAPPING_INVALID', '钉钉部门映射必须是数字部门 ID', 409)
    return { processCode: String(row.process_code), departmentExternalId: externalId }
  }

  async attachExternalInstance(input: { internalInstanceId: string; processInstanceId: string }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE approval_instances SET provider = $2, external_instance_id = $3, updated_at = now()
       WHERE id = $1::uuid AND status = 'pending' AND external_instance_id IS NULL`,
      [input.internalInstanceId, provider, input.processInstanceId],
    )
    if (result.rowCount !== 1) throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_ATTACH_CONFLICT', '审批实例不存在、已结束或已关联钉钉', 409)
  }

  async cancelPendingStart(input: { internalInstanceId: string; reason: string }): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const found = await client.query(
        `SELECT id, subject_type, subject_id FROM approval_instances
         WHERE id = $1::uuid AND status = 'pending' AND external_instance_id IS NULL FOR UPDATE`,
        [input.internalInstanceId],
      )
      const instance = found.rows[0]
      if (!instance) throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_RECOVERY_CONFLICT', '审批实例已关联、已完成或不存在，不能自动撤销', 409)
      await client.query(`UPDATE approval_steps SET status = 'cancelled', acted_at = now() WHERE approval_instance_id = $1::uuid AND status = 'pending'`, [instance.id])
      await client.query(`UPDATE approval_instances SET status = 'cancelled', completed_at = now(), updated_at = now() WHERE id = $1::uuid`, [instance.id])
      if (instance.subject_type === 'recruitment_request') {
        await client.query(
          `UPDATE recruitment_requests SET status = 'draft', version = version + 1, updated_at = now()
           WHERE id = $1::uuid AND status = 'pending_approval'`,
          [instance.subject_id],
        )
      } else if (instance.subject_type === 'offer') {
        await client.query(
          `UPDATE offers SET status = 'draft', approval_status = 'cancelled', version = version + 1, updated_at = now()
           WHERE id = $1::uuid AND status = 'pending_approval'`,
          [instance.subject_id],
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async applyDecision(input: { eventId: string; processInstanceId: string; decision: 'approved' | 'rejected'; approverUserId?: string; comment?: string; rawPayload: unknown }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const hash = createHash('sha256').update(JSON.stringify(input.rawPayload)).digest('hex')
      const inserted = await client.query(
        `INSERT INTO external_event_receipts (provider, event_id, event_type, payload_hash, status)
         VALUES ($1, $2, 'approval.finished', $3, 'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [provider, input.eventId, hash],
      )
      if (!inserted.rows[0]) {
        const receipt = await client.query('SELECT status, payload_hash FROM external_event_receipts WHERE provider = $1 AND event_id = $2 FOR UPDATE', [provider, input.eventId])
        if (receipt.rows[0]?.payload_hash && receipt.rows[0].payload_hash !== hash) throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_CONFLICT', '同一回调事件包含不同数据', 409)
        if (receipt.rows[0]?.status === 'completed') { await client.query('COMMIT'); return { replayed: true } }
      }
      const found = await client.query(
        `SELECT id, subject_type, subject_id, status FROM approval_instances
         WHERE provider = $1 AND external_instance_id = $2 FOR UPDATE`,
        [provider, input.processInstanceId],
      )
      const instance = found.rows[0]
      if (!instance) throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_NOT_FOUND', '未找到对应的本地审批实例', 404)
      if (instance.status !== 'pending') {
        if (instance.status !== input.decision) throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_DECISION_CONFLICT', '审批实例已记录不同结果', 409)
      } else {
        const stepResult = await client.query(`SELECT id FROM approval_steps WHERE approval_instance_id = $1::uuid AND status = 'pending' ORDER BY step_no LIMIT 1 FOR UPDATE`, [instance.id])
        const step = stepResult.rows[0]
        const actor = input.approverUserId
          ? (await client.query(`SELECT internal_id FROM external_entity_mappings WHERE provider = $1 AND external_type = 'user' AND external_id = $2`, [provider, input.approverUserId])).rows[0]?.internal_id ?? null
          : null
        await client.query(
          `INSERT INTO approval_records (id, approval_instance_id, approval_step_id, actor_user_id, decision, comment)
           VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6)`,
          [randomUUID(), instance.id, step?.id ?? null, actor, input.decision, input.comment ?? ''],
        )
        if (step) await client.query(`UPDATE approval_steps SET status = $2, acted_at = now() WHERE id = $1::uuid`, [step.id, input.decision])
        await client.query(`UPDATE approval_instances SET status = $2, completed_at = now(), updated_at = now() WHERE id = $1::uuid`, [instance.id, input.decision])
        if (instance.subject_type === 'recruitment_request') {
          await client.query(`UPDATE recruitment_requests SET status = $2, version = version + 1, updated_at = now() WHERE id = $1::uuid AND status = 'pending_approval'`, [instance.subject_id, input.decision])
        } else if (instance.subject_type === 'offer') {
          const offerStatus = input.decision === 'approved' ? 'approved' : 'draft'
          await client.query(
            `UPDATE offers SET status = $2, approval_status = $3, version = version + 1, updated_at = now()
             WHERE id = $1::uuid AND status = 'pending_approval'`,
            [instance.subject_id, offerStatus, input.decision],
          )
        }
      }
      await client.query(`UPDATE external_event_receipts SET status = 'completed', result = $3::jsonb, processed_at = now() WHERE provider = $1 AND event_id = $2`, [provider, input.eventId, JSON.stringify({ processInstanceId: input.processInstanceId, decision: input.decision })])
      await client.query('COMMIT')
      return { replayed: false }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async hasActiveExternalApproval(subjectType: string, subjectId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM approval_instances WHERE subject_type = $1 AND subject_id = $2::uuid
       AND provider = $3 AND external_instance_id IS NOT NULL AND status = 'pending' LIMIT 1`,
      [subjectType, subjectId, provider],
    )
    return Boolean(result.rows[0])
  }
}
