import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSubscriptionRenewal } from './subscription-renewal.js'

const current = { catalog_id: 'catalog-a', plan_version_id: 'plan-a', seat_limit: 5, job_limit: 10,
  all_modules: false, billing_entitlements: { quotas: { ai_points: 100 }, grantPeriod: 'monthly', rollover: false } }
test('同商品仅调价、描述、期限或旧版本套餐编号变化仍延续订阅', () => {
  assert.equal(isSubscriptionRenewal(current, { ...current, plan_version_id: 'plan-b', amount_fen: 999, duration_days: 90 }), true)
})
test('同容量独立商品不自动视为续费，权益变化不沿用旧周期', () => {
  assert.equal(isSubscriptionRenewal(current, { ...current, plan_version_id: 'plan-b', catalog_id: 'catalog-b' }), false)
  for (const patch of [{ seat_limit: 6 }, { all_modules: true }, { billing_kind: 'addon' },
    { billing_entitlements: { quotas: { ai_points: 200 }, grantPeriod: 'monthly', rollover: false } }])
    assert.equal(isSubscriptionRenewal(current, { ...current, ...patch }), false)
})
test('无付款历史的人工套餐仅按原套餐编号兼容，不按名称或容量猜测', () => {
  assert.equal(isSubscriptionRenewal(undefined, current, 'plan-a'), true)
  assert.equal(isSubscriptionRenewal(undefined, current, 'plan-b'), false)
})
