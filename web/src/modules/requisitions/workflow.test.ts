import { describe, expect, it } from 'vitest'
import { requisitionActionsFor } from './workflow'

describe('招聘需求流程动作', () => {
  it('提交后直接生效，不显示审批动作', () => {
    expect(requisitionActionsFor('draft')).toEqual(['submit', 'cancel'])
    expect(requisitionActionsFor('rejected')).toEqual(['resubmit', 'cancel'])
    expect(requisitionActionsFor('pending_approval')).toEqual(['withdraw'])
  })

  it('已生效需求可以撤回或关闭', () => {
    expect(requisitionActionsFor('approved')).toEqual(['withdraw', 'close'])
    expect(requisitionActionsFor('converted')).toEqual(['close'])
  })
})
