import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateProfileInput, validateReasonInput, validateStatusInput, validateUserListQuery } from './validation.js'

test('platform user filters validate pagination, status and role', () => {
  assert.deepEqual(validateUserListQuery(new URLSearchParams('page=1&pageSize=20')), {
    page: 1,
    pageSize: 20,
    q: '',
    status: null,
    workspaceId: null,
    platformRole: null,
  })
  assert.throws(() => validateUserListQuery(new URLSearchParams('page=0')), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateUserListQuery(new URLSearchParams('status=deleted')), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateUserListQuery(new URLSearchParams('platformRole=owner')), { code: 'VALIDATION_ERROR' })
})

test('platform user mutations require a reason and supported fields', () => {
  assert.deepEqual(validateStatusInput({ isActive: false, reason: '安全处置' }), { isActive: false, reason: '安全处置' })
  assert.deepEqual(validateReasonInput({ reason: '用户申请退出' }), { reason: '用户申请退出' })
  assert.deepEqual(validateProfileInput({ displayName: '陈婉清', phone: '13800000000', reason: '纠正账号资料' }), {
    displayName: '陈婉清',
    phone: '+8613800000000',
    reason: '纠正账号资料',
  })
  assert.throws(() => validateStatusInput({ isActive: false, reason: ' ' }), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateProfileInput({ displayName: '陈婉清', role: 'admin', reason: '越权修改' }), { code: 'VALIDATION_ERROR' })
})
