import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { DingTalkApprovalWorkflowError, type DingTalkApprovalRepository } from './approval-workflow.js'

const provider = 'dingtalk'

type ExternalNodeInput = {
  externalStepId?: string
  nodeName?: string
  status: 'pending' | 'approved' | 'rejected'
  approverUserId?: string
  comment?: string
  actedAt?: string
}

export class PostgresDingTalkApprovalRepository implements DingTalkApprovalRepository {
  constructor(private readonly pool: Pool) {}

  private async syncExternalNode(client: PoolClient, input: { approvalInstanceId: string; node: ExternalNodeInput; actorUserId?: string | null }): Promise<void> {
    const node = input.node
    const existing = await client.query<{ id: string; step_no: number }>(
      `SELECT id, step_no FROM approval_steps
       WHERE approval_instance_id = $1::uuid
         AND (
           ($2::text IS NOT NULL AND external_step_id = $2)
           OR ($3::text IS NOT NULL AND node_name = $3 AND external_step_id IS NULL)
           OR ($2::text IS NULL AND $3::text IS NULL AND external_step_id IS NULL AND status = 'pending')
           OR ($2::text IS NOT NULL AND external_step_id IS NULL AND status = 'pending')
         )
       ORDER BY CASE
         WHEN $2::text IS NOT NULL AND external_step_id = $2 THEN 0
         WHEN $3::text IS NOT NULL AND node_name = $3 THEN 1
         ELSE 2
       END, step_no LIMIT 1 FOR UPDATE`,
      [input.approvalInstanceId, node.externalStepId ?? null, node.nodeName ?? null],
    )
    let stepId = existing.rows[0]?.id
    if (!stepId) {
      const next = await client.query<{ next_step: number }>(
        `SELECT COALESCE(MAX(step_no), 0) + 1 AS next_step FROM approval_steps WHERE approval_instance_id = $1::uuid`,
        [input.approvalInstanceId],
      )
      stepId = randomUUID()
      await client.query(
        `INSERT INTO approval_steps
          (organization_id, id, approval_instance_id, step_no, approver_user_id, approver_role_code, external_step_id, node_name, status, acted_at)
         VALUES ((SELECT organization_id FROM approval_instances WHERE id = $2::uuid), $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, CASE WHEN $8 = 'pending' THEN NULL ELSE COALESCE($9::timestamptz, now()) END)`,
        [stepId, input.approvalInstanceId, Number(next.rows[0]?.next_step ?? 1), input.actorUserId ?? null, node.nodeName ?? 'approver', node.externalStepId ?? null, node.nodeName ?? null, node.status, node.actedAt ?? null],
      )
    } else {
      await client.query(
        `UPDATE approval_steps
         SET external_step_id = COALESCE($2, external_step_id),
             node_name = COALESCE($3, node_name),
             approver_user_id = COALESCE($4::uuid, approver_user_id),
             status = CASE WHEN approval_steps.status IN ('approved', 'rejected') AND $5 = 'pending' THEN approval_steps.status ELSE $5 END,
             acted_at = CASE WHEN $5 = 'pending' THEN acted_at ELSE COALESCE($6::timestamptz, acted_at, now()) END
         WHERE id = $1::uuid`,
        [stepId, node.externalStepId ?? null, node.nodeName ?? null, input.actorUserId ?? null, node.status, node.actedAt ?? null],
      )
    }
    await client.query(
      `UPDATE approval_instances
       SET current_step = COALESCE(
         (SELECT step_no FROM approval_steps WHERE approval_instance_id = $1::uuid AND status = 'pending' ORDER BY step_no LIMIT 1),
         (SELECT MAX(step_no) FROM approval_steps WHERE approval_instance_id = $1::uuid)
       ), updated_at = now()
       WHERE id = $1::uuid`,
      [input.approvalInstanceId],
    )
  }

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
       JOIN departments d ON d.id = p.department_id
       JOIN external_entity_mappings m ON m.provider = 'dingtalk' AND m.external_type = 'department'
        AND m.internal_type = 'department' AND m.internal_id = p.department_id
       WHERE (
         p.department_id = CASE
           WHEN $1 ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           THEN $1::uuid
           ELSE NULL::uuid
         END
         OR d.code = $1
       ) AND p.subject_type = $2 AND p.is_active = true`,
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
        `SELECT id, organization_id, subject_type, subject_id, status FROM approval_instances
         WHERE provider = $1 AND external_instance_id = $2 FOR UPDATE`,
        [provider, input.processInstanceId],
      )
      const instance = found.rows[0]
      if (!instance) throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_NOT_FOUND', '未找到对应的本地审批实例', 404)
      const actor = input.approverUserId
        ? (await client.query(`SELECT internal_id FROM external_entity_mappings WHERE provider = $1 AND external_type = 'user' AND external_id = $2`, [provider, input.approverUserId])).rows[0]?.internal_id ?? null
        : null
      if (instance.status !== 'pending') {
        if (instance.status !== input.decision) throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_DECISION_CONFLICT', '审批实例已记录不同结果', 409)
        await client.query(
          `UPDATE external_event_receipts SET status = 'completed', result = $3::jsonb, processed_at = now()
           WHERE provider = $1 AND event_id = $2`,
          [provider, input.eventId, JSON.stringify({ processInstanceId: input.processInstanceId, decision: input.decision, replay: true })],
        )
        await client.query('COMMIT')
        return { replayed: true }
      } else {
        const stepResult = await client.query(`SELECT id FROM approval_steps WHERE approval_instance_id = $1::uuid AND status = 'pending' ORDER BY step_no LIMIT 1 FOR UPDATE`, [instance.id])
        const step = stepResult.rows[0] ?? (await client.query(`SELECT id FROM approval_steps WHERE approval_instance_id = $1::uuid ORDER BY step_no DESC LIMIT 1 FOR UPDATE`, [instance.id])).rows[0]
        await client.query(
          `INSERT INTO approval_records (id, approval_instance_id, approval_step_id, actor_user_id, decision, comment, organization_id)
           VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid)`,
          [randomUUID(), instance.id, step?.id ?? null, actor, input.decision, input.comment ?? '', instance.organization_id],
        )
        if (step) await client.query(`UPDATE approval_steps SET status = $2, acted_at = now() WHERE id = $1::uuid`, [step.id, input.decision])
        await client.query(
          `UPDATE approval_instances
           SET status = $2,
               current_step = COALESCE(
                 (SELECT step_no FROM approval_steps WHERE approval_instance_id = $1::uuid AND status = 'pending' ORDER BY step_no LIMIT 1),
                 (SELECT MAX(step_no) FROM approval_steps WHERE approval_instance_id = $1::uuid)
               ),
               completed_at = now(), updated_at = now()
           WHERE id = $1::uuid`,
          [instance.id, input.decision],
        )
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
      const finalMetadata = {
        provider,
        processInstanceId: input.processInstanceId,
        eventId: input.eventId,
        status: input.decision,
        rawPayload: input.rawPayload,
      }
      await client.query(
        `INSERT INTO workflow_events
          (subject_type, subject_id, event_type, from_status, to_status, actor_user_id, reason, metadata, organization_id)
         VALUES ($1, $2::uuid, 'dingtalk.approval.finished', 'pending', $3, $4::uuid, $5, $6::jsonb, $7::uuid)`,
        [instance.subject_type, instance.subject_id, input.decision, actor, input.comment ?? '', JSON.stringify(finalMetadata), instance.organization_id],
      )
      await client.query(`UPDATE external_event_receipts SET status = 'completed', result = $3::jsonb, processed_at = now() WHERE provider = $1 AND event_id = $2`, [provider, input.eventId, JSON.stringify({ processInstanceId: input.processInstanceId, decision: input.decision })])
      await client.query('COMMIT')
      return { replayed: false }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async recordExternalProgress(input: {
    eventId: string
    processInstanceId: string
    status: 'pending' | 'approved' | 'rejected'
    externalStepId?: string
    nodeName?: string
    approverUserId?: string
    comment?: string
    actedAt?: string
    rawPayload: unknown
  }): Promise<{ replayed: boolean }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const payloadHash = createHash('sha256').update(JSON.stringify(input.rawPayload)).digest('hex')
      const inserted = await client.query(
        `INSERT INTO external_event_receipts (provider, event_id, event_type, payload_hash, status)
         VALUES ($1, $2, 'approval.progress', $3, 'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [provider, input.eventId, payloadHash],
      )
      if (!inserted.rows[0]) {
        const receipt = await client.query(
          'SELECT status, payload_hash FROM external_event_receipts WHERE provider = $1 AND event_id = $2 FOR UPDATE',
          [provider, input.eventId],
        )
        if (receipt.rows[0]?.payload_hash && receipt.rows[0].payload_hash !== payloadHash) {
          throw new DingTalkApprovalWorkflowError('DINGTALK_CALLBACK_CONFLICT', '同一回调事件包含不同数据', 409)
        }
        if (receipt.rows[0]?.status === 'completed') {
          await client.query('COMMIT')
          return { replayed: true }
        }
      }
      const found = await client.query(
        `SELECT id, organization_id, subject_type, subject_id, status FROM approval_instances
         WHERE provider = $1 AND external_instance_id = $2 FOR UPDATE`,
        [provider, input.processInstanceId],
      )
      const instance = found.rows[0]
      if (!instance) throw new DingTalkApprovalWorkflowError('DINGTALK_APPROVAL_NOT_FOUND', '未找到对应的本地审批实例', 404)
      const actor = input.approverUserId
        ? (await client.query(
          `SELECT internal_id FROM external_entity_mappings
           WHERE provider = $1 AND external_type = 'user' AND external_id = $2`,
          [provider, input.approverUserId],
        )).rows[0]?.internal_id ?? null
        : null
      await this.syncExternalNode(client, { approvalInstanceId: instance.id, actorUserId: actor, node: {
        status: input.status,
        ...(input.externalStepId ? { externalStepId: input.externalStepId } : {}),
        ...(input.nodeName ? { nodeName: input.nodeName } : {}),
        ...(input.actedAt ? { actedAt: input.actedAt } : {}),
        ...(input.approverUserId ? { approverUserId: input.approverUserId } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
      } })
      const metadata = {
        provider,
        processInstanceId: input.processInstanceId,
        eventId: input.eventId,
        status: input.status,
        ...(input.nodeName ? { nodeName: input.nodeName } : {}),
        ...(input.approverUserId ? { approverUserId: input.approverUserId } : {}),
        rawPayload: input.rawPayload,
      }
      await client.query(
        `INSERT INTO workflow_events
          (subject_type, subject_id, event_type, from_status, to_status, actor_user_id, reason, metadata, organization_id)
         VALUES ($1, $2::uuid, 'dingtalk.approval.progress', $3, $4, $5::uuid, $6, $7::jsonb, $8::uuid)`,
        [instance.subject_type, instance.subject_id, instance.status, input.status, actor, input.comment ?? '', JSON.stringify(metadata), instance.organization_id],
      )
      await client.query(
        `UPDATE external_event_receipts
         SET status = 'completed', result = $3::jsonb, processed_at = now()
         WHERE provider = $1 AND event_id = $2`,
        [provider, input.eventId, JSON.stringify({ processInstanceId: input.processInstanceId, status: input.status })],
      )
      await client.query('COMMIT')
      return { replayed: false }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }

  async listPendingExternalApprovals(): Promise<Array<{ processInstanceId: string }>> {
    const result = await this.pool.query<{ process_instance_id: string }>(
      `SELECT external_instance_id AS process_instance_id
       FROM approval_instances
       WHERE provider = $1 AND status = 'pending' AND external_instance_id IS NOT NULL
       ORDER BY updated_at ASC`,
      [provider],
    )
    return result.rows.map((row) => ({ processInstanceId: row.process_instance_id }))
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
