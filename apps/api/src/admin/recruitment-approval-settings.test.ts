import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RecruitmentApprovalSettingsError, RecruitmentApprovalSettingsService, type RecruitmentApprovalMode } from './recruitment-approval-settings.js'

class FakePool {
  calls: Array<{ sql: string; values: unknown[] }> = []
  responses: unknown[]
  constructor(responses: unknown[] = []) { this.responses = responses }
  async query<T extends Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values })
    return { rows: (this.responses.shift() ?? []) as T[] }
  }
}

const orgA = '11111111-1111-4111-8111-111111111111'
const orgB = '22222222-2222-4222-8222-222222222222'
const actor = '33333333-3333-4333-8333-333333333333'

describe('RecruitmentApprovalSettingsService', () => {
  it('defaults sessions without an active workspace to platform mode', async () => {
    const pool = new FakePool()
    assert.deepEqual(await new RecruitmentApprovalSettingsService(pool).getMode(undefined), { mode: 'platform' })
    assert.equal(pool.calls.length, 0)
  })

  it('allows any enterprise member to read the selected mode for workflow routing', async () => {
    const pool = new FakePool([[{ recruitment_approval_mode: 'dingtalk' as RecruitmentApprovalMode }]])
    assert.deepEqual(await new RecruitmentApprovalSettingsService(pool).getMode(orgA), { mode: 'dingtalk' })
    assert.deepEqual(pool.calls[0]?.values, [orgA])
  })

  it('requires current enterprise owner/admin membership to read admin settings', async () => {
    const pool = new FakePool([[{ id: orgA }], [{ recruitment_approval_mode: 'dingtalk' as RecruitmentApprovalMode }]])
    assert.deepEqual(await new RecruitmentApprovalSettingsService(pool).getForAdmin(orgA, actor), { mode: 'dingtalk' })
    assert.match(pool.calls[0]!.sql, /om\.role IN \('owner', 'admin'\)/)
  })

  it('updates the enterprise mode only for an owner/admin and records an organization-scoped audit entry', async () => {
    const pool = new FakePool([[{ id: orgB }], [{ recruitment_approval_mode: 'dingtalk' as RecruitmentApprovalMode }]])
    const result = await new RecruitmentApprovalSettingsService(pool).update({ organizationId: orgB, actorId: actor, mode: 'dingtalk', requestId: 'req-1' })
    assert.deepEqual(result, { mode: 'dingtalk' })
    assert.deepEqual(pool.calls[1]?.values, ['dingtalk', orgB, actor, 'req-1'])
    assert.match(pool.calls[1]!.sql, /organization_id, actor_user_id, action/)
    assert.match(pool.calls[1]!.sql, /WHERE o\.id = \$2::uuid/)
  })

  it('rejects unsupported modes and updates without an active enterprise', async () => {
    const service = new RecruitmentApprovalSettingsService(new FakePool())
    await assert.rejects(service.update({ organizationId: orgA, actorId: actor, mode: 'personal' }), (error: unknown) => error instanceof RecruitmentApprovalSettingsError && error.status === 400)
    await assert.rejects(service.update({ actorId: actor, mode: 'platform' }), (error: unknown) => error instanceof RecruitmentApprovalSettingsError && error.status === 409)
  })

  it('does not report a successful update when the actor is not an enterprise owner/admin', async () => {
    const service = new RecruitmentApprovalSettingsService(new FakePool([[]]))
    await assert.rejects(service.update({ organizationId: orgA, actorId: actor, mode: 'platform' }), (error: unknown) => error instanceof RecruitmentApprovalSettingsError && error.status === 403)
    await assert.rejects(service.getForAdmin(orgA, actor), (error: unknown) => error instanceof RecruitmentApprovalSettingsError && error.status === 403)
  })
})
