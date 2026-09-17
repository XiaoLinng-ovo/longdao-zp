import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DingTalkJobSyncService } from './job-sync.js'
import { MemoryDingTalkJobSyncRepository } from './memory-job-sync.js'

class FakeRepository {
  events = new Map<string, { payloadHash: string; status: 'processing' | 'completed' | 'failed'; result?: unknown; receivedAt?: Date }>()
  created: unknown[] = []
  failures: string[] = []
  failNextCreate = false

  async findEvent(eventId: string) { return this.events.get(eventId) }
  async reserveEvent(eventId: string, payloadHash: string) { this.events.set(eventId, { payloadHash, status: 'processing' }) }
  async completeEvent(eventId: string, result: unknown) { this.events.set(eventId, { ...this.events.get(eventId)!, status: 'completed', result }) }
  async failEvent(eventId: string, error: unknown) {
    this.failures.push(error instanceof Error ? error.message : String(error))
    this.events.set(eventId, { ...this.events.get(eventId)!, status: 'failed' })
  }
  async createDraftJob(input: unknown) {
    if (this.failNextCreate) {
      this.failNextCreate = false
      throw new Error('temporary database failure')
    }
    this.created.push(input)
    return { requestId: 'request-1', jobId: 'job-1', jobCode: 'JOB-1' }
  }
}

describe('DingTalkJobSyncService', () => {
  it('creates one draft platform job from a minimal DingTalk publish event', async () => {
    const repository = new FakeRepository()
    const service = new DingTalkJobSyncService(repository, { platformBaseUrl: 'https://recruit.example.com' })
    const event = { eventId: 'evt-001', externalJobId: 'ding-job-001', title: '高级后端工程师', departmentCode: 'dept-tech', headcount: 2, creatorUserId: 'ding-user-1' }

    const first = await service.publish(event)
    const replay = await service.publish(event)

    assert.equal(repository.created.length, 1)
    assert.equal(first.status, 'draft')
    assert.equal(replay.status, 'replayed')
    assert.equal(replay.jobId, first.jobId)
    assert.equal(first.completeUrl, 'https://recruit.example.com/jobs/job-1')
  })

  it('rejects reuse of an event id with a different payload', async () => {
    const repository = new FakeRepository()
    const service = new DingTalkJobSyncService(repository, { platformBaseUrl: 'https://recruit.example.com' })
    await service.publish({ eventId: 'evt-002', externalJobId: 'ding-job-2', title: '产品经理', departmentCode: 'dept-product', headcount: 1, creatorUserId: 'ding-user-2' })

    await assert.rejects(
      service.publish({ eventId: 'evt-002', externalJobId: 'ding-job-2', title: '产品总监', departmentCode: 'dept-product', headcount: 1, creatorUserId: 'ding-user-2' }),
      (error: any) => error?.code === 'DINGTALK_EVENT_CONFLICT',
    )
  })

  it('replays when payload fields arrive in a different order', async () => {
    const repository = new FakeRepository()
    const service = new DingTalkJobSyncService(repository, { platformBaseUrl: 'https://recruit.example.com' })
    await service.publish({ eventId: 'evt-order', externalJobId: 'ding-order', title: '后端工程师', departmentCode: 'dept-tech', headcount: 1, creatorUserId: 'ding-user' })
    const reordered = { creatorUserId: 'ding-user', headcount: 1, departmentCode: 'dept-tech', title: '后端工程师', externalJobId: 'ding-order', eventId: 'evt-order' }
    const replay = await service.publish(reordered)
    assert.equal(replay.status, 'replayed')
    assert.equal(repository.created.length, 1)
  })

  it('marks a failed event and allows the same payload to retry', async () => {
    const repository = new FakeRepository()
    repository.failNextCreate = true
    const service = new DingTalkJobSyncService(repository, { platformBaseUrl: 'https://recruit.example.com' })
    const event = { eventId: 'evt-retry', externalJobId: 'ding-job-retry', title: '数据工程师', departmentCode: 'dept-tech', headcount: 1, creatorUserId: 'ding-user-3' }

    await assert.rejects(service.publish(event), /temporary database failure/)
    assert.deepEqual(repository.failures, ['temporary database failure'])
    assert.equal(repository.events.get(event.eventId)?.status, 'failed')

    const retried = await service.publish(event)
    assert.equal(retried.status, 'draft')
    assert.equal(repository.created.length, 1)
  })

  it('reclaims a stale processing event instead of leaving it permanently stuck', async () => {
    const repository = new FakeRepository()
    const service = new DingTalkJobSyncService(repository, { platformBaseUrl: 'https://recruit.example.com' })
    const event = { eventId: 'evt-stale', externalJobId: 'ding-job-stale', title: '测试工程师', departmentCode: 'dept-tech', headcount: 1, creatorUserId: 'ding-user-stale' }
    await service.publish(event)
    const receipt = repository.events.get(event.eventId)!
    repository.events.set(event.eventId, { ...receipt, status: 'processing', receivedAt: new Date(Date.now() - 11 * 60 * 1000) })
    const replay = await service.publish(event)
    assert.equal(replay.status, 'draft')
    assert.equal(repository.created.length, 2)
  })

  it('rejects a second event for an already synced external job', async () => {
    const service = new DingTalkJobSyncService(new MemoryDingTalkJobSyncRepository(), { platformBaseUrl: 'https://recruit.example.com' })
    await service.publish({ eventId: 'evt-job-1', externalJobId: 'ding-job-same', title: '后端工程师', departmentCode: 'dept-tech', headcount: 1, creatorUserId: 'ding-user-1' })

    await assert.rejects(
      service.publish({ eventId: 'evt-job-2', externalJobId: 'ding-job-same', title: '后端工程师', departmentCode: 'dept-tech', headcount: 1, creatorUserId: 'ding-user-2' }),
      (error: any) => error?.code === 'DINGTALK_JOB_ALREADY_SYNCED',
    )
  })
})
