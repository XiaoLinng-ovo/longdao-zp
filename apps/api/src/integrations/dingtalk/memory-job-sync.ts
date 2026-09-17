import { randomUUID } from 'node:crypto'
import { DingTalkJobSyncError, type DingTalkJobSyncRepository } from './job-sync.js'

type StoredEvent = Awaited<ReturnType<DingTalkJobSyncRepository['findEvent']>> & {}

export class MemoryDingTalkJobSyncRepository implements DingTalkJobSyncRepository {
  private readonly events = new Map<string, StoredEvent>()
  private readonly jobs = new Map<string, { requestId: string; jobId: string; jobCode: string }>()

  async findEvent(eventId: string): Promise<StoredEvent | undefined> {
    return this.events.get(eventId)
  }

  async reserveEvent(eventId: string, payloadHash: string): Promise<void> {
    this.events.set(eventId, { payloadHash, status: 'processing', receivedAt: new Date() })
  }

  async completeEvent(eventId: string, result: unknown): Promise<void> {
    const event = this.events.get(eventId)
    if (event) this.events.set(eventId, { ...event, status: 'completed', result })
  }

  async failEvent(eventId: string): Promise<void> {
    const event = this.events.get(eventId)
    if (event) this.events.set(eventId, { ...event, status: 'failed' })
  }

  async createDraftJob(input: { externalJobId: string }): Promise<{ requestId: string; jobId: string; jobCode: string }> {
    const existing = this.jobs.get(input.externalJobId)
    if (existing) throw new DingTalkJobSyncError('DINGTALK_JOB_ALREADY_SYNCED', '该钉钉岗位已经同步到招聘平台', 409)
    const jobId = randomUUID()
    const created = { requestId: randomUUID(), jobId, jobCode: `JOB-TEST-${jobId.slice(0, 8).toUpperCase()}` }
    this.jobs.set(input.externalJobId, created)
    return created
  }
}
