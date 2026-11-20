import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startPostgresWaitSampler } from './postgres-wait-sampler.mjs'

async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) { assert.ok(Date.now() < deadline, '采样器测试等待超时'); await delay(5) }
}

test('等待诊断仅查询运行状态，记录有界且停止后不再查询', async () => {
  let calls = 0
  const sampler = await startPostgresWaitSampler({ async query(sql, values) {
    calls++
    assert.deepEqual(values, ['isolated-database'])
    assert.match(sql, /pg_stat_activity/)
    assert.doesNotMatch(sql, /\b(?:query|usename|client_addr|password)\b/i)
    return { rows: [{ pid: 12, state: 'active', blockers: 0 }] }
  } }, 'isolated-database', { intervalMs: 5, limit: 2 })
  try {
    await until(() => sampler.evidence.dropped > 0)
    assert.equal(sampler.evidence.samples.length, 2)
    assert.deepEqual(sampler.evidence.errors, [])
  } finally { await sampler.stop() }
  const stopped = calls
  await sampler.stop(); await delay(25)
  assert.equal(calls, stopped)
})

test('采样不重叠，停止会等待在途查询完成', async () => {
  let calls = 0, release, finished = false
  const pending = new Promise(resolve => { release = resolve })
  const sampler = await startPostgresWaitSampler({ async query() {
    if (++calls > 1) await pending
    return { rows: [] }
  } }, 'isolated-database', { intervalMs: 5 })
  try {
    await until(() => calls === 2)
    await delay(25); assert.equal(calls, 2)
    const stop = sampler.stop().then(() => { finished = true })
    await delay(10); assert.equal(finished, false)
    release(); await stop
    assert.equal(sampler.evidence.samples.length, 2)
  } finally { release(); await sampler.stop() }
})

test('周期故障只记录错误码，不记录可能包含凭据的消息', async () => {
  let calls = 0
  const sampler = await startPostgresWaitSampler({ async query() {
    if (++calls > 1) throw Object.assign(new Error('synthetic-secret-do-not-record'), { code: '57014' })
    return { rows: [] }
  } }, 'isolated-database', { intervalMs: 5 })
  try {
    await until(() => sampler.evidence.errors.length > 0)
    assert.equal(sampler.evidence.errors[0].code, '57014')
    assert.ok(!JSON.stringify(sampler.evidence).includes('synthetic-secret'))
  } finally { await sampler.stop() }
})

test('首次采样失败直接阻止启动而不是生成空的成功证据', async () => {
  await assert.rejects(startPostgresWaitSampler({ async query() { throw new Error('initial-sample-failed') } }, 'isolated-database'), /initial-sample-failed/)
})

test('长期采样可以逐条落盘，内存不保留记录且不静默丢弃', async () => {
  const records = []
  const sampler = await startPostgresWaitSampler({ async query() { return { rows: [{ pid: 42 }] } } }, 'isolated-database',
    { intervalMs: 5, limit: 0, async onSample(record) { records.push(record) } })
  try {
    await until(() => records.length >= 3)
    assert.equal(sampler.evidence.samples.length, 0); assert.equal(sampler.evidence.dropped, 0)
    assert.equal(sampler.evidence.streamed, records.length)
  } finally { await sampler.stop() }
})

test('落盘失败不能算作已保存，记录错误并由验收健康检查停止', async () => {
  let calls = 0
  const sampler = await startPostgresWaitSampler({ async query() { return { rows: [] } } }, 'isolated-database',
    { intervalMs: 5, limit: 0, async onSample() { if (++calls > 1) throw Error('disk-budget-exceeded') } })
  try {
    await until(() => sampler.evidence.errors.length > 0)
    assert.equal(sampler.evidence.streamed, 1); assert.equal(sampler.evidence.errors[0].code, 'SAMPLING_FAILED')
  } finally { await sampler.stop() }
})
