import assert from 'node:assert/strict'
import test from 'node:test'
import { capacityPolicy, concurrentLanes, latencySummary, retry429Milliseconds } from '../capacity-load-policy.mjs'
import { loadApiEnvironment } from '../isolated-load-api.mjs'

test('容量验收保留默认上传限制，仅对明确的安全限流响应有限重试', () => {
  assert.equal(capacityPolicy.uploadConcurrency, 6); assert.equal(capacityPolicy.workspaceUploadConcurrency, 3)
  for (const status of [200, 400, 409, 500, 503]) assert.equal(retry429Milliseconds({ status }, 0), undefined)
  assert.equal(retry429Milliseconds({ status: 429, body: { error: { code: 'OTHER' } } }, 0), undefined)
  const response = { status: 429, retryAfter: '2', body: { error: { code: 'RESUME_UPLOAD_BUSY' } } }
  assert.equal(retry429Milliseconds(response, 0), 2000)
  assert.throws(() => retry429Milliseconds(response, 20), /耗尽/)
  for (const retryAfter of [undefined, '0', '-1', 'Infinity', '1000']) assert.throws(() => retry429Milliseconds({ ...response, retryAfter }, 0))
})
test('首次失败后停止调度并等候已启动的工作，避免清理与请求竞态', async () => {
  const started = [], finished = []
  await assert.rejects(concurrentLanes([0, 1, 2, 3], 2, async item => {
    started.push(item)
    if (item === 0) throw Error('合成失败')
    await new Promise(resolve => setTimeout(resolve, 20)); finished.push(item)
  }), /合成失败/)
  assert.deepEqual(started, [0, 1]); assert.deepEqual(finished, [1])
})
test('延迟分位数与空数据不制造成功请求', () => {
  assert.deepEqual(latencySummary([]), { count: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 })
  assert.deepEqual(latencySummary([3, 1, 2]), { count: 3, p50Ms: 2, p95Ms: 3, p99Ms: 3, maxMs: 3 })
})
test('容量 API 环境不继承真实连接、代理、密钥或限流覆盖', () => {
  const instance = { database: 'closure_verify_' + 'a'.repeat(32), port: 30001,
    env: { PATH: process.env.PATH, PGDATABASE: 'closure_verify_' + 'a'.repeat(32) } }
  const env = loadApiEnvironment(instance, { smtp: { port: 30002, password: 'synthetic' }, model: { port: 30003, apiKey: 'synthetic' }, otpSecret: 'synthetic' })
  assert.equal(env.DATABASE_URL, undefined); assert.equal(env.HTTPS_PROXY, undefined)
  assert.equal(env.RESUME_UPLOAD_CONCURRENCY, undefined); assert.equal(env.SYSTEM_ADMIN_USER_NO, undefined)
  assert.equal(env.ISOLATED_ALLOWED_PORTS, '30001,30002,30003')
  assert.equal(env.PGDATABASE, instance.database)
  assert.throws(() => loadApiEnvironment({ ...instance, database: 'business' }, { smtp: {}, model: {} }))
})
