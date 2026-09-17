import { createHash } from 'node:crypto'

export interface DingTalkJobPublishEvent {
  eventId: string
  externalJobId: string
  title: string
  departmentCode: string
  headcount: number
  creatorUserId: string
}

export interface DingTalkJobSyncRepository {
  findEvent(eventId: string): Promise<{ payloadHash: string; status: 'processing' | 'completed' | 'failed'; result?: unknown; receivedAt?: Date } | undefined>
  reserveEvent(eventId: string, payloadHash: string): Promise<void>
  completeEvent(eventId: string, result: unknown): Promise<void>
  failEvent(eventId: string, error: unknown): Promise<void>
  createDraftJob(input: { externalJobId: string; title: string; departmentCode: string; headcount: number; creatorUserId: string }): Promise<{ requestId: string; jobId: string; jobCode: string }>
}

export interface DingTalkJobSyncOptions { platformBaseUrl: string }

export class DingTalkJobSyncError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message) }
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DingTalkJobSyncError('DINGTALK_JOB_INVALID', `${name} 不能为空`)
  return value.trim()
}

/** Deterministic JSON representation used for idempotency hashes. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function payloadHash(event: DingTalkJobPublishEvent): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex')
}

export class DingTalkJobSyncService {
  constructor(private readonly repository: DingTalkJobSyncRepository, private readonly options: DingTalkJobSyncOptions) {}

  async publish(input: DingTalkJobPublishEvent): Promise<{ status: 'draft' | 'replayed'; requestId: string; jobId: string; jobCode: string; completeUrl: string }> {
    const eventId = required(input.eventId, 'eventId')
    const externalJobId = required(input.externalJobId, 'externalJobId')
    const title = required(input.title, '岗位名称')
    const departmentCode = required(input.departmentCode, '部门')
    const creatorUserId = required(input.creatorUserId, '创建人')
    if (!Number.isInteger(input.headcount) || input.headcount < 1) throw new DingTalkJobSyncError('DINGTALK_JOB_INVALID', '招聘人数必须是大于 0 的整数')
    const event = { eventId, externalJobId, title, departmentCode, headcount: input.headcount, creatorUserId }
    const hash = payloadHash(event)
    const existing = await this.repository.findEvent(eventId)
    if (existing) {
      if (existing.payloadHash !== hash) throw new DingTalkJobSyncError('DINGTALK_EVENT_CONFLICT', '同一钉钉事件不能对应不同岗位数据', 409)
      const result = existing.result as Omit<ReturnType<DingTalkJobSyncService['publish']>, 'status'> | undefined
      if (result) return { ...result, status: 'replayed' }
      if (existing.status !== 'failed') {
        const staleAt = existing.receivedAt && Date.now() - existing.receivedAt.getTime() > 10 * 60 * 1000
        if (!staleAt) throw new DingTalkJobSyncError('DINGTALK_EVENT_PENDING', '该钉钉事件正在处理中', 409)
      }
    }
    await this.repository.reserveEvent(eventId, hash)
    let created: Awaited<ReturnType<DingTalkJobSyncRepository['createDraftJob']>>
    try {
      created = await this.repository.createDraftJob({ externalJobId, title, departmentCode, headcount: input.headcount, creatorUserId })
    } catch (error) {
      // Preserve the original business error even if receipt bookkeeping fails.
      try { await this.repository.failEvent(eventId, error) } catch { /* best effort */ }
      throw error
    }
    const result = { requestId: created.requestId, jobId: created.jobId, jobCode: created.jobCode, completeUrl: `${this.options.platformBaseUrl.replace(/\/$/, '')}/jobs/${encodeURIComponent(created.jobId)}` }
    await this.repository.completeEvent(eventId, result)
    return { ...result, status: 'draft' }
  }
}
