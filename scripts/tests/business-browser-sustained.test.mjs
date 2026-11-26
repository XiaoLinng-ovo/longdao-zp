import assert from 'node:assert/strict'
import test from 'node:test'
import { drainMixedRequestDiagnostics, mixedRequestLatency, verifyMixedNetworkFailures } from '../business-browser-sustained.mjs'
import { reconcileMixedBilling } from '../business-browser-mixed-audit.mjs'

test('混合证据排空只移动已结束请求，不能丢弃在途或静默截断的诊断', () => {
  const live = { finished: false, closed: false }
  const done = { finished: true, closed: false, elapsedMs: 20 }
  const aborted = { finished: false, closed: true, elapsedMs: 5 }
  const evidence = { requests: [live, done, aborted], droppedRequests: 0, droppedSocketErrors: 0 }
  assert.deepEqual(drainMixedRequestDiagnostics(evidence), [done, aborted])
  assert.deepEqual(evidence.requests, [live])
  live.finished = true
  assert.deepEqual(drainMixedRequestDiagnostics(evidence), [live])
  assert.deepEqual(evidence.requests, [])
  assert.throws(() => drainMixedRequestDiagnostics({ ...evidence, droppedRequests: 1 }))
  assert.throws(() => drainMixedRequestDiagnostics({ ...evidence, droppedSocketErrors: 1 }))
  assert.throws(() => drainMixedRequestDiagnostics({ ...evidence, requests: Array.from({ length: 128 }, () => ({ finished: false, closed: false })) }))
})

test('取消只读题库查询需匹配同一面试的成功 API 诊断，不豁免写请求或重复记录', () => {
  const row = { method: 'GET', path: '/api/v1/interviews/current/question-preparation', finished: true, status: 200,
    startedAt: '2026-11-16T00:00:00.010Z', elapsedMs: 60 }
  const aborted = { method: 'GET', path: row.path, at: '2026-11-16T00:00:00.015Z', code: 'net::ERR_ABORTED' }
  verifyMixedNetworkFailures([aborted], [row], 'current')
  for (const records of [[aborted, aborted], [{ ...aborted, method: 'POST' }], [{ ...aborted, path: row.path.replace('current', 'other') }]]) {
    assert.throws(() => verifyMixedNetworkFailures(records, [row], 'current'))
  }
  assert.throws(() => verifyMixedNetworkFailures([aborted], [{ ...row, status: 500 }], 'current'))
})

test('混合总账拒绝额外订单、重复通知、无来源额度、跨公司扣费和余额不一致', () => {
  const organization_id = 'company', order_id = 'subscription'
  const balances = {
    orders: [{ id: order_id, organization_id, billing_kind: 'subscription', status: 'fulfilled', transaction_id: 'transaction', paid_at: 'paid' }],
    events: [{ order_id, source: 'callback' }],
    grants: [['ai_points', 100], ['interview_seconds', 300], ['ocr_pages', 20]].map(([resource, total]) => ({ id: resource,
      resource, total, remaining: total - Number(resource === 'ai_points'), organization_id, order_id, revoked_at: null, expires_at: 'expires' })),
    trialGrants: [{ id: 'trial' }],
    tasks: [{ organization_id, operation: 'resume_analysis', request_key: 'analysis', state: 'settled', resource: 'ai_points', units: '1', allocations: [{ id: 'ai_points', units: 1 }] }],
  }
  balances.grants.push({ id: 'trial', organization_id: 'other', resource: 'ai_points', total: 100, remaining: 100, order_id: null })
  const expected = { memberId: organization_id, subscriptionId: order_id, addonIds: [], importedResumes: 1 }
  assert.deepEqual(reconcileMixedBilling(balances, expected), { orders: 1, paymentEvents: 1, orderGrants: 3, trialGrants: 1, billingTasks: 1, resumeCharges: 1 })
  for (const change of [data => data.orders.push({ ...data.orders[0], id: 'extra' }), data => data.events.push(data.events[0]),
    data => { data.trialGrants = [] }, data => { data.tasks[0].allocations[0].id = 'trial' }, data => { data.grants[0].remaining = 100 }]) {
    const altered = structuredClone(balances)
    change(altered)
    assert.throws(() => reconcileMixedBilling(altered, expected))
  }
})

test('混合延迟按实际完成请求统计，排除被取消或未结束的请求并拒绝空证据', () => {
  const records = Array.from({ length: 100 }, (_, index) => ({ finished: true, elapsedMs: index + 1 }))
  records.push({ finished: false, elapsedMs: 20000 }, { finished: true })
  assert.deepEqual(mixedRequestLatency(records), { count: 100, p50: 50, p95: 95, p99: 99, max: 100 })
  assert.throws(() => mixedRequestLatency([]))
})
