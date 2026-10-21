import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { executePlatformRecruitmentApprovalAction, executeRecruitmentApprovalAction } from './approval-routing.js'

describe('DingTalk recruitment approval routing', () => {
  it('starts DingTalk after a recruitment request is submitted', async () => {
    const calls: string[] = []
    const result = await executeRecruitmentApprovalAction({
      requestId: 'request-1',
      action: 'submit',
      actorId: 'user-1',
      request: {
        title: '后端工程师',
        departmentId: 'department-1',
        headcount: 2,
        salaryRange: {
          min: { amount: 10000, currency: 'CNY' },
          max: { amount: 20000, currency: 'CNY' },
        },
        justification: '负责后端系统开发与维护',
      },
      performLocalAction: async () => { calls.push('local'); return { status: 'pending_approval' } },
      getCurrentInstanceId: async () => 'instance-1',
      resolveOriginatorUserId: async () => 'ding-user-1',
      startExternalApproval: async (input) => {
        calls.push(`external:${input.internalInstanceId}:${input.originatorUserId}`)
        assert.deepEqual(input.formValues, [
          { name: '需求岗位', value: '后端工程师' },
          { name: '需求人数', value: '2' },
          { name: '岗位职责', value: '负责后端系统开发与维护' },
          { name: '任职要求', value: '负责后端系统开发与维护' },
          { name: '薪资水平', value: '10000 - 20000 CNY' },
        ])
      },
      assertLocalDecisionAllowed: async () => { calls.push('assert') },
    })
    assert.deepEqual(calls, ['local', 'external:instance-1:ding-user-1'])
    assert.deepEqual(result, { status: 'pending_approval' })
  })

  it('blocks local approve while an external approval is active', async () => {
    let mutated = false
    await assert.rejects(executeRecruitmentApprovalAction({
      requestId: 'request-1', action: 'approve', actorId: 'user-1',
      request: { title: '后端工程师', departmentId: 'department-1', headcount: 2 },
      performLocalAction: async () => { mutated = true; return {} },
      getCurrentInstanceId: async () => 'instance-1',
      resolveOriginatorUserId: async () => 'ding-user-1',
      startExternalApproval: async () => undefined,
      assertLocalDecisionAllowed: async () => { throw new Error('active') },
    }), /active/)
    assert.equal(mutated, false)
  })

  it('resolves the DingTalk user before mutating the local request', async () => {
    let mutated = false
    await assert.rejects(executeRecruitmentApprovalAction({
      requestId: 'request-1', action: 'submit', actorId: 'user-1',
      request: { title: '后端工程师', departmentId: 'department-1', headcount: 2 },
      performLocalAction: async () => { mutated = true; return {} },
      getCurrentInstanceId: async () => 'instance-1',
      resolveOriginatorUserId: async () => { throw new Error('mapping missing') },
      startExternalApproval: async () => undefined,
      assertLocalDecisionAllowed: async () => undefined,
    }), /mapping missing/)
    assert.equal(mutated, false)
  })
})


describe('platform recruitment approval routing', () => {
  it('submits locally without looking up a DingTalk user or starting an external approval', async () => {
    const calls: string[] = []
    const result = await executePlatformRecruitmentApprovalAction({
      requestId: 'request-1', action: 'submit',
      performLocalAction: async () => { calls.push('local'); return { status: 'pending_approval' } },
      assertLocalDecisionAllowed: async () => { calls.push('assert') },
    })
    assert.deepEqual(calls, ['local'])
    assert.deepEqual(result, { status: 'pending_approval' })
  })

  it('still blocks local decisions while a DingTalk approval instance is active', async () => {
    let mutated = false
    await assert.rejects(executePlatformRecruitmentApprovalAction({
      requestId: 'request-1', action: 'approve',
      performLocalAction: async () => { mutated = true; return {} },
      assertLocalDecisionAllowed: async () => { throw new Error('external approval active') },
    }), /external approval active/)
    assert.equal(mutated, false)
  })
  it('blocks local cancellation while an external approval is active', async () => {
    let performed = false
    await assert.rejects(() => executePlatformRecruitmentApprovalAction({
      requestId: 'request-1', action: 'cancel',
      performLocalAction: async () => { performed = true },
      assertLocalDecisionAllowed: async () => { throw new Error('external approval active') },
    }), /external approval active/)
    assert.equal(performed, false)
  })

})
