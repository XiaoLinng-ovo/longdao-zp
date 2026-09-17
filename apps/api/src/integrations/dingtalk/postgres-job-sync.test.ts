import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { DingTalkJobSyncError } from './job-sync.js'
import { PostgresDingTalkJobSyncRepository } from './postgres-job-sync.js'

class FakeClient {
  readonly calls: string[] = []
  constructor(private readonly responses: Array<Record<string, unknown>[]>) {}

  async query(sql: string): Promise<QueryResult> {
    this.calls.push(sql)
    return { rows: this.responses.shift() ?? [], rowCount: 1 } as QueryResult
  }

  release(): void {}
}

function poolWith(client: FakeClient): Pool {
  return { connect: async () => client } as unknown as Pool
}

describe('PostgresDingTalkJobSyncRepository', () => {
  it('creates the request, draft job and external mapping in one transaction', async () => {
    const client = new FakeClient([[], [], [{ id: 'dept-id' }], [{ internal_id: 'user-id' }], [], [], [], []])
    const repository = new PostgresDingTalkJobSyncRepository(poolWith(client))

    const result = await repository.createDraftJob({ externalJobId: 'ding-job-1', title: '后端工程师', departmentCode: 'dept-tech', headcount: 2, creatorUserId: 'ding-user-1' })

    assert.match(result.jobId, /^[0-9a-f-]{36}$/i)
    assert.equal(client.calls[0], 'BEGIN')
    assert.ok(client.calls.some((sql) => sql.includes('INSERT INTO recruitment_requests')))
    assert.ok(client.calls.some((sql) => sql.includes('INSERT INTO jobs')))
    assert.ok(client.calls.some((sql) => sql.includes('INSERT INTO external_entity_mappings')))
    assert.equal(client.calls.at(-1), 'COMMIT')
  })

  it('rolls back when the DingTalk department is not mapped', async () => {
    const client = new FakeClient([[], [], []])
    const repository = new PostgresDingTalkJobSyncRepository(poolWith(client))

    await assert.rejects(
      repository.createDraftJob({ externalJobId: 'ding-job-2', title: '产品经理', departmentCode: 'missing', headcount: 1, creatorUserId: 'ding-user-2' }),
      (error: unknown) => error instanceof DingTalkJobSyncError && error.code === 'DINGTALK_DEPARTMENT_NOT_MAPPED',
    )
    assert.equal(client.calls.at(-1), 'ROLLBACK')
  })
})
