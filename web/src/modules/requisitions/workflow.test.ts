import { describe, expect, it } from 'vitest'
import { requisitionActionsForApproval } from './workflow'

describe('requisition approval channel actions', () => {
  it('hides local decisions when DingTalk owns the pending approval', () => {
    expect(requisitionActionsForApproval('pending_approval', {
      provider: 'dingtalk', status: 'pending', externalInstanceId: 'external-1',
    })).toEqual([])
  })

  it('keeps platform decisions available without an active external instance', () => {
    for (const approval of [undefined, { provider: 'platform', status: 'pending' },
      { provider: 'dingtalk', status: 'pending' },
      { provider: 'dingtalk', status: 'approved', externalInstanceId: 'external-1' }]) {
      expect(requisitionActionsForApproval('pending_approval', approval)).toEqual(['approve', 'reject', 'withdraw'])
    }
  })

  it('allows closure after the external approval has finished', () => {
    expect(requisitionActionsForApproval('approved', {
      provider: 'dingtalk', status: 'approved', externalInstanceId: 'external-1',
    })).toEqual(['withdraw', 'close'])
  })
})
