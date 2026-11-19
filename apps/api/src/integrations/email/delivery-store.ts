import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { HttpError } from '../../http.js'
import { currentTenantContext, organizationSchemaName } from '../../db/tenant-context.js'
import { NormalizedRecruitingRepository } from '../../recruiting/repositories/postgres-repository.js'
import { transitionOfferWorkflow } from '../../recruiting/offer-workflow.js'

export interface OfferEmailRequest {
  action: 'send' | 'resend' | 'resend_cancelled'
  expiresAt?: string
  metadata: Record<string, unknown>
}

export class OfferEmailDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async begin(organizationId: string, offerId: string, versionId: string, workflowVersion: number, request?: OfferEmailRequest): Promise<{ id: string; messageId: string }> {
    const client = await this.pool.connect()
    const id = randomUUID()
    const messageId = '<' + id + '@smartrecruit.local>'
    try {
      await client.query('BEGIN')
      const offer = await client.query('SELECT id,current_version_id,version FROM offers WHERE id=$1 AND organization_id=$2 FOR UPDATE', [offerId,organizationId])
      if (!offer.rows[0]) throw new HttpError(404, 'NOT_FOUND', '未找到 Offer')
      if (offer.rows[0].current_version_id !== versionId || offer.rows[0].version !== workflowVersion)
        throw new HttpError(409, 'OFFER_VERSION_CONFLICT', 'Offer 已有变更，请重新预览')
      const inserted = await client.query(
        "INSERT INTO public.offer_email_deliveries(id,organization_id,offer_id,version_id,workflow_version,message_id,schema_name,send_request,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'sending') ON CONFLICT DO NOTHING RETURNING id",
        [id,organizationId,offerId,versionId,workflowVersion,messageId,currentTenantContext()?.schemaName ?? 'public',JSON.stringify(request ?? {})])
      if (!inserted.rows.length) throw new HttpError(409, 'OFFER_EMAIL_STATUS_UNKNOWN', '该版本已发送或存在待核实的投递记录，请勿重复发送')
      await client.query('COMMIT')
      return { id, messageId }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }

  async setStatus(id: string, status: 'accepted' | 'unknown' | 'completed'): Promise<void> {
    const updated = await this.pool.query(
      "UPDATE public.offer_email_deliveries SET status=$2,updated_at=now() WHERE id=$1 AND status IN ('sending','accepted') RETURNING id", [id,status])
    if (!updated.rows.length) throw new HttpError(409, 'OFFER_EMAIL_STATUS_UNKNOWN', '邮件投递记录需人工核实')
  }

  async listUnresolved(): Promise<unknown[]> {
    return (await this.pool.query("SELECT id,organization_id,offer_id,version_id,message_id,status,created_at,updated_at FROM public.offer_email_deliveries WHERE status IN ('sending','accepted','unknown') ORDER BY created_at LIMIT 200")).rows
  }

  async resolve(id: string, status: 'completed' | 'not_sent', actorId: string, note: string): Promise<string> {
    if (!['completed', 'not_sent'].includes(status) || note.trim().length < 5 || note.length > 2000)
      throw new HttpError(400, 'VALIDATION_ERROR', '请填写至少五个字符的核对说明')
    if (status === 'not_sent') {
      const db=await this.pool.connect()
      try {
      await db.query('BEGIN')
      const updated = await db.query(
        "UPDATE public.offer_email_deliveries SET status=$2,resolved_by=$3,resolution_note=$4,updated_at=now() WHERE id=$1 AND (status='unknown' OR (status IN ('sending','accepted') AND updated_at < now()-interval '10 minutes')) RETURNING offer_id,organization_id",
        [id,status,actorId,note.trim()])
      if (!updated.rows.length) throw new HttpError(409, 'EMAIL_RESOLUTION_CONFLICT', '邮件仍可能在发送中，或记录已处理，请稍后刷新')
      await db.query("INSERT INTO public.platform_audit_logs(actor_user_id,organization_id,action,metadata) VALUES($1,$2,'email.delivery.resolve',$3::jsonb)",[actorId,updated.rows[0].organization_id,JSON.stringify({deliveryId:id,status,note:note.trim()})])
      await db.query('COMMIT')
      return String(updated.rows[0].offer_id)
      } catch(error) { await db.query('ROLLBACK').catch(()=>undefined); throw error }
      finally { db.release() }
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const initial = (await client.query('SELECT * FROM public.offer_email_deliveries WHERE id=$1', [id])).rows[0]
      if (!initial) throw new HttpError(404, 'NOT_FOUND', '未找到邮件投递记录')
      const schema = String(initial.schema_name)
      if (process.env.TENANT_SCHEMA_ROUTING === 'on' && schema === 'public')
        throw new HttpError(409, 'EMAIL_SCHEMA_CONFLICT', '公司数据路径已切换，请先核对历史投递记录')
      if (process.env.TENANT_SCHEMA_ROUTING !== 'on' && schema !== 'public')
        throw new HttpError(409, 'EMAIL_SCHEMA_CONFLICT', '公司数据路径未启用，不能恢复到历史路径')
      if (schema !== 'public') {
        if (schema !== organizationSchemaName(initial.organization_id)) throw new HttpError(409, 'EMAIL_SCHEMA_CONFLICT', '投递记录的公司路径无效')
        const ready = await client.query("SELECT 1 FROM public.organization_schemas WHERE organization_id=$1 AND schema_name=$2 AND status='ready' AND public.organization_schema_structure_ready(organization_id)", [initial.organization_id,schema])
        if (!ready.rows.length) throw new HttpError(409, 'EMAIL_SCHEMA_CONFLICT', '公司数据路径尚未就绪，不能恢复邮件状态')
      }
      await client.query('SELECT set_config($1,$2,true)', ['search_path', schema === 'public' ? 'public' : '"' + schema + '",public'])
      const offer = (await client.query('SELECT application_id FROM offers WHERE id=$1 AND organization_id=$2', [initial.offer_id,initial.organization_id])).rows[0]
      if (!offer) throw new HttpError(404, 'NOT_FOUND', '未找到该公司的 Offer')
      // Match normal transitions: application, offer, then delivery; SMTP runs outside these locks.
      await client.query('SELECT id FROM applications WHERE id=$1 AND organization_id=$2 FOR UPDATE', [offer.application_id,initial.organization_id])
      const locked = (await client.query('SELECT status,version,current_version_id FROM offers WHERE id=$1 AND organization_id=$2 FOR UPDATE', [initial.offer_id,initial.organization_id])).rows[0]
      const delivery = (await client.query("SELECT * FROM public.offer_email_deliveries WHERE id=$1 AND (status='unknown' OR (status IN ('sending','accepted') AND updated_at < now()-interval '10 minutes')) FOR UPDATE", [id])).rows[0]
      if (!delivery) throw new HttpError(409, 'EMAIL_RESOLUTION_CONFLICT', '邮件仍可能在发送中，或记录已处理，请稍后刷新')
      if (!locked || locked.version !== delivery.workflow_version || locked.current_version_id !== delivery.version_id)
        throw new HttpError(409, 'OFFER_VERSION_CONFLICT', 'Offer 已变更，不能把旧邮件恢复到新版本')
      const request = delivery.send_request as Partial<OfferEmailRequest>
      if (!request || !['send', 'resend', 'resend_cancelled'].includes(String(request.action)))
        throw new HttpError(409, 'EMAIL_RECOVERY_DATA_REQUIRED', '投递记录缺少业务恢复信息，需要人工核对')
      const transition = transitionOfferWorkflow(locked.status, request.action!)
      await client.query("UPDATE public.offer_email_deliveries SET status='accepted' WHERE id=$1", [id])
      const repository = new NormalizedRecruitingRepository(this.pool).withOrganization(delivery.organization_id)
      await repository.transitionOfferWithExecutor(client, delivery.offer_id, {
        action: request.action!, fromStatus: locked.status, toStatus: transition.offerStatus,
        applicationStatus: transition.applicationStatus, actorId, expectedVersionId: delivery.version_id,
        ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        metadata: { ...request.metadata, emailDeliveryId: id, messageId: delivery.message_id, recovered: true, resolutionNote: note.trim() },
      })
      await client.query("UPDATE public.offer_email_deliveries SET status='completed',resolved_by=$2,resolution_note=$3,updated_at=now() WHERE id=$1", [id,actorId,note.trim()])
      await client.query("INSERT INTO public.platform_audit_logs(actor_user_id,organization_id,action,metadata) VALUES($1,$2,'email.delivery.resolve',$3::jsonb)",[actorId,delivery.organization_id,JSON.stringify({deliveryId:id,status,note:note.trim()})])
      await client.query('COMMIT')
      return String(delivery.offer_id)
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally { client.release() }
  }
}
