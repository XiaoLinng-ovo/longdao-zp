import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool, QueryResult } from 'pg'
import { PostgresDingTalkApprovalRepository } from './postgres-approval-workflow.js'

class FakePool {
  calls: Array<{ sql: string; values?: unknown[] }> = []
  constructor(private responses: Array<Record<string, unknown>[]>) {}
  async query(sql: string, values?: unknown[]): Promise<QueryResult> {
    this.calls.push({ sql, ...(values ? { values } : {}) })
    const rows = this.responses.shift() ?? []
    return { rows, rowCount: rows.length } as QueryResult
  }
  async connect() { return { query: this.query.bind(this), release() {} } }
}

describe('PostgresDingTalkApprovalRepository', () => {
  it('resolves a platform user to the mapped DingTalk user id', async () => {
    const pool = new FakePool([[{ external_id: 'ding-user-1' }]])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)
    assert.equal(await repository.resolveExternalUserId('11111111-1111-4111-8111-111111111111'), 'ding-user-1')
    assert.deepEqual(pool.calls[0]?.values, ['dingtalk', '11111111-1111-4111-8111-111111111111'])
  })

  it('loads a department policy with its mapped DingTalk department id', async () => {
    const pool = new FakePool([[{ process_code: 'PROC-TECH', external_id: '42' }]])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)
    assert.deepEqual(await repository.getDepartmentPolicy('dept-1', 'recruitment_request'), { processCode: 'PROC-TECH', departmentExternalId: 42 })
  })

  it('cancels an unlinked pending instance and returns its request to draft atomically', async () => {
    const pool = new FakePool([[], [{ id: 'instance-1', subject_type: 'recruitment_request', subject_id: 'request-1' }], [], [], [], []])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)

    await repository.cancelPendingStart({ internalInstanceId: 'instance-1', reason: 'DingTalk unavailable' })

    assert.ok(pool.calls.some(({ sql }) => sql.includes("UPDATE approval_instances SET status = 'cancelled'")))
    assert.ok(pool.calls.some(({ sql }) => sql.includes("UPDATE recruitment_requests SET status = 'draft'")))
    assert.equal(pool.calls.at(-1)?.sql, 'COMMIT')
  })

  it('cancels an unlinked offer instance and returns its offer to draft atomically', async () => {
    const pool = new FakePool([[], [{ id: 'instance-1', subject_type: 'offer', subject_id: 'offer-1' }], [], [], [], []])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)

    await repository.cancelPendingStart({ internalInstanceId: 'instance-1', reason: 'DingTalk unavailable' })

    const update = pool.calls.find(({ sql }) => sql.includes('UPDATE offers'))
    assert.ok(update)
    assert.match(update.sql, /approval_status = 'cancelled'/)
    assert.equal(pool.calls.at(-1)?.sql, 'COMMIT')
  })

  it('persists a callback decision transactionally and records its receipt', async () => {
    const pool = new FakePool([[], [{ status: 'processing' }], [{ id: 'instance-1', subject_type: 'recruitment_request', subject_id: 'request-1', status: 'pending' }], [{ id: 'step-1' }], [], [], [], [], []])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)
    assert.deepEqual(await repository.applyDecision({ eventId: 'event-1', processInstanceId: 'ding-1', decision: 'approved', approverUserId: 'ding-user-1', comment: 'ok', rawPayload: {} }), { replayed: false })
    assert.ok(pool.calls.some(({ sql }) => sql.includes('UPDATE recruitment_requests')))
    assert.ok(pool.calls.some(({ sql }) => sql.includes('INSERT INTO approval_records')))
    assert.equal(pool.calls.at(-1)?.sql, 'COMMIT')
  })

  it('applies an approved callback to the linked offer', async () => {
    const pool = new FakePool([[], [{ status: 'processing' }], [{ id: 'instance-1', subject_type: 'offer', subject_id: 'offer-1', status: 'pending' }], [{ id: 'step-1' }], [], [], [], [], []])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)

    assert.deepEqual(await repository.applyDecision({ eventId: 'event-offer-1', processInstanceId: 'ding-offer-1', decision: 'approved', rawPayload: {} }), { replayed: false })

    const update = pool.calls.find(({ sql }) => sql.includes('UPDATE offers'))
    assert.ok(update)
    assert.deepEqual(update.values, ['offer-1', 'approved', 'approved'])
    assert.match(update.sql, /status = \$2, approval_status = \$3/)
  })

  it('applies a rejected callback by returning the offer to draft', async () => {
    const pool = new FakePool([[], [{ status: 'processing' }], [{ id: 'instance-1', subject_type: 'offer', subject_id: 'offer-1', status: 'pending' }], [], [], [], [], [], []])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)

    await repository.applyDecision({ eventId: 'event-offer-2', processInstanceId: 'ding-offer-2', decision: 'rejected', rawPayload: {} })

    const update = pool.calls.find(({ sql }) => sql.includes('UPDATE offers'))
    assert.ok(update)
    assert.deepEqual(update.values, ['offer-1', 'draft', 'rejected'])
  })

  it('treats an already completed callback receipt as a replay', async () => {
    const pool = new FakePool([[], [], [{ status: 'completed' }], []])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)
    assert.deepEqual(await repository.applyDecision({ eventId: 'event-1', processInstanceId: 'ding-1', decision: 'approved', rawPayload: {} }), { replayed: true })
    assert.equal(pool.calls.at(-1)?.sql, 'COMMIT')
  })
  it('keeps callback audit records in the approval instance organization', async () => {
    const organizationId = '99999999-9999-4999-8999-999999999999'
    const pool = new FakePool([[], [{ status: 'processing' }], [{ id: 'instance-1', organization_id: organizationId, subject_type: 'recruitment_request', subject_id: 'request-1', status: 'pending' }], [{ id: 'step-1' }]])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)
    await repository.applyDecision({ eventId: 'tenant-event', processInstanceId: 'ding-tenant', decision: 'approved', rawPayload: {} })
    for (const table of ['approval_records', 'workflow_events']) {
      const insert = pool.calls.find(({ sql }) => sql.includes(`INSERT INTO ${table}`))
      assert.ok(insert)
      assert.match(insert.sql, /organization_id/)
      assert.equal(insert.values?.at(-1), organizationId)
    }
  })

  it('inherits organization scope for new external nodes and progress events', async () => {
    const organizationId = '99999999-9999-4999-8999-999999999999'
    const pool = new FakePool([[], [{ status: 'processing' }], [{ id: 'instance-1', organization_id: organizationId, subject_type: 'recruitment_request', subject_id: 'request-1', status: 'pending' }], [], [{ next_step: 2 }]])
    const repository = new PostgresDingTalkApprovalRepository(pool as unknown as Pool)
    await repository.recordExternalProgress({ eventId: 'progress-tenant', processInstanceId: 'ding-tenant', status: 'pending', externalStepId: 'node-2', rawPayload: {} })
    const step = pool.calls.find(({ sql }) => sql.includes('INSERT INTO approval_steps'))
    assert.ok(step)
    assert.match(step.sql, /SELECT organization_id FROM approval_instances WHERE id = \$2::uuid/)
    const event = pool.calls.find(({ sql }) => sql.includes('INSERT INTO workflow_events'))
    assert.equal(event?.values?.at(-1), organizationId)
    assert.equal(pool.calls.at(-1)?.sql, 'COMMIT')
  })

})
