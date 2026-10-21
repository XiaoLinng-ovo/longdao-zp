import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { executeOfferApprovalAction } from './offer-approval.js'

describe('executeOfferApprovalAction', () => {
  it('starts the department offer process after local submission', async () => {
    const calls: unknown[] = []

    const result = await executeOfferApprovalAction({
      offerId: 'offer-1',
      action: 'submit_approval',
      actorId: 'user-1',
      offer: { positionTitle: 'Senior Engineer', departmentId: 'dept-1', baseSalary: { amount: 32000, currency: 'CNY' } },
      performLocalAction: async () => 'submitted',
      getCurrentInstanceId: async () => 'instance-1',
      resolveOriginatorUserId: async () => 'ding-user-1',
      startExternalApproval: async (input) => { calls.push(input) },
      assertLocalDecisionAllowed: async () => undefined,
    })

    assert.equal(result, 'submitted')
    assert.deepEqual(calls, [{
      internalInstanceId: 'instance-1',
      departmentId: 'dept-1',
      subjectType: 'offer',
      originatorUserId: 'ding-user-1',
      formValues: [
        { name: '职位名称', value: 'Senior Engineer' },
        { name: '基本薪资', value: '32000 CNY' },
      ],
    }])
  })

  it('blocks a local offer decision while DingTalk approval is active', async () => {
    let performed = false
    await assert.rejects(executeOfferApprovalAction({
      offerId: 'offer-1',
      action: 'approve',
      actorId: 'user-1',
      offer: { positionTitle: 'Senior Engineer', departmentId: 'dept-1', baseSalary: { amount: 32000, currency: 'CNY' } },
      performLocalAction: async () => { performed = true },
      getCurrentInstanceId: async () => 'instance-1',
      resolveOriginatorUserId: async () => 'ding-user-1',
      startExternalApproval: async () => undefined,
      assertLocalDecisionAllowed: async (subjectType, subjectId) => {
        assert.deepEqual([subjectType, subjectId], ['offer', 'offer-1'])
        throw new Error('external approval active')
      },
    }), /external approval active/)
    assert.equal(performed, false)
  })
})
