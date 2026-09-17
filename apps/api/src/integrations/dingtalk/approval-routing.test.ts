import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { executeRecruitmentApprovalAction } from './approval-routing.js'

describe('DingTalk recruitment approval routing', () => {
  it('starts DingTalk after a recruitment request is submitted', async () => {
    const calls: string[] = []
    const result = await executeRecruitmentApprovalAction({
      requestId: 'request-1',
      action: 'submit',
      actorId: 'user-1',
      request: { title: '后端工程师', departmentId: 'department-1', headcount: 2 },
      performLocalAction: async () => { calls.push('local'); return { status: 'pending_approval' } },
      getCurrentInstanceId: async () => 'instance-1',
      resolveOriginatorUserId: async () => 'ding-user-1',
      startExternalApproval: async (input) => { calls.push(`external:${input.internalInstanceId}:${input.originatorUserId}`) },
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
