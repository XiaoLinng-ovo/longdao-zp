import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { DingTalkJobSyncError, type DingTalkJobSyncRepository } from './job-sync.js'

const provider = 'dingtalk'

export class PostgresDingTalkJobSyncRepository implements DingTalkJobSyncRepository {
  constructor(private readonly pool: Pool) {}

  async findEvent(eventId: string) {
    const result = await this.pool.query('SELECT payload_hash, status, result FROM external_event_receipts WHERE provider = $1 AND event_id = $2', [provider, eventId])
    const row = result.rows[0]
    return row ? { payloadHash: String(row.payload_hash), status: String(row.status) as 'processing' | 'completed' | 'failed', ...(row.result ? { result: row.result } : {}), ...(row.received_at ? { receivedAt: new Date(row.received_at) } : {}) } : undefined
  }

  async reserveEvent(eventId: string, payloadHash: string): Promise<void> {
    const retried = await this.pool.query(`UPDATE external_event_receipts SET status = 'processing', last_error = NULL, processed_at = NULL, received_at = now() WHERE provider = $1 AND event_id = $2 AND payload_hash = $3 AND status = 'failed'`, [provider, eventId, payloadHash])
    if (retried.rowCount === 1) return
    const stale = await this.pool.query(`UPDATE external_event_receipts SET status = 'processing', last_error = NULL, processed_at = NULL, received_at = now() WHERE provider = $1 AND event_id = $2 AND payload_hash = $3 AND status = 'processing' AND received_at < now() - interval '10 minutes'`, [provider, eventId, payloadHash])
    if (stale.rowCount === 1) return
    try {
      await this.pool.query(`INSERT INTO external_event_receipts (provider, event_id, event_type, payload_hash, status) VALUES ($1, $2, 'job.publish', $3, 'processing')`, [provider, eventId, payloadHash])
    } catch (error: any) {
      if (error?.code === '23505') throw new DingTalkJobSyncError('DINGTALK_EVENT_PENDING', '该钉钉事件已被接收', 409)
      throw error
    }
  }

  async completeEvent(eventId: string, result: unknown): Promise<void> {
    await this.pool.query(`UPDATE external_event_receipts SET status = 'completed', result = $3::jsonb, processed_at = now() WHERE provider = $1 AND event_id = $2`, [provider, eventId, JSON.stringify(result)])
  }

  async failEvent(eventId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await this.pool.query(`UPDATE external_event_receipts SET status = 'failed', last_error = $3, processed_at = now() WHERE provider = $1 AND event_id = $2`, [provider, eventId, message.slice(0, 2000)])
  }

  async createDraftJob(input: { externalJobId: string; title: string; departmentCode: string; headcount: number; creatorUserId: string }) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const existing = await client.query(`SELECT internal_id FROM external_entity_mappings WHERE provider = $1 AND external_type = 'job' AND external_id = $2 FOR UPDATE`, [provider, input.externalJobId])
      if (existing.rows[0]) throw new DingTalkJobSyncError('DINGTALK_JOB_ALREADY_SYNCED', '该钉钉岗位已经同步到招聘平台', 409)
      const department = await client.query('SELECT id FROM departments WHERE code = $1', [input.departmentCode])
      if (!department.rows[0]) throw new DingTalkJobSyncError('DINGTALK_DEPARTMENT_NOT_MAPPED', `平台不存在部门：${input.departmentCode}`)
      const creator = await this.resolveCreator(client, input.creatorUserId)
      const requestId = randomUUID(); const jobId = randomUUID()
      const requestNo = `REQ-DING-${randomUUID().slice(0, 8).toUpperCase()}`
      const jobCode = `JOB-DING-${randomUUID().slice(0, 8).toUpperCase()}`
      await client.query(`INSERT INTO recruitment_requests (id, request_no, title, department_id, requested_by, headcount, reason, status, version) VALUES ($1, $2, $3, $4, $5, $6, '钉钉快速发布，详情待平台完善', 'draft', 1)`, [requestId, requestNo, input.title, department.rows[0].id, creator, input.headcount])
      await client.query(`INSERT INTO jobs (id, job_no, recruitment_request_id, department_id, title, status, headcount, created_by) VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7)`, [jobId, jobCode, requestId, department.rows[0].id, input.title, input.headcount, creator])
      await client.query(`INSERT INTO external_entity_mappings (provider, external_type, external_id, internal_type, internal_id, metadata) VALUES ($1, 'job', $2, 'job', $3, $4::jsonb)`, [provider, input.externalJobId, jobId, JSON.stringify({ creatorUserId: input.creatorUserId })])
      await client.query('COMMIT')
      return { requestId, jobId, jobCode }
    } catch (error: any) {
      await client.query('ROLLBACK')
      if (error?.code === '23505' && String(error?.constraint ?? '').includes('external_entity_mappings')) {
        throw new DingTalkJobSyncError('DINGTALK_JOB_ALREADY_SYNCED', '该钉钉岗位已经同步到招聘平台', 409)
      }
      throw error
    } finally { client.release() }
  }

  private async resolveCreator(client: PoolClient, externalUserId: string): Promise<string | null> {
    const mapping = await client.query(`SELECT internal_id FROM external_entity_mappings WHERE provider = $1 AND external_type = 'user' AND external_id = $2`, [provider, externalUserId])
    return mapping.rows[0]?.internal_id ?? null
  }
}
