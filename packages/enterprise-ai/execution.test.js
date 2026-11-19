import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { withExecutionPermit, executionSignal, isExecutionBusy } from './execution.js'

function fixture() {
  const locks = new Map(), clients = []
  const pool = { async connect() {
    const client = new EventEmitter()
    client.query = async (sql, args) => {
      const key = args.join(':')
      if (sql.includes('pg_try_advisory_lock')) {
        if (locks.has(key)) return { rows: [{ acquired: false }] }
        locks.set(key, client); return { rows: [{ acquired: true }] }
      }
      assert.equal(locks.get(key), client); locks.delete(key)
      return { rows: [{}] }
    }
    client.release = damaged => {
      if (damaged) for (const [key, owner] of locks) { if (owner === client) locks.delete(key) }
      assert.ok(![...locks.values()].includes(client), 'No owned lock may return to pool')
    }
    clients.push(client); return client
  } }
  return { pool, clients, locks, run: (channel, action, org = 'org', env = {}) => withExecutionPermit(pool, org, channel, env, 2, action) }
}
const gate = () => { let release; const wait = new Promise(resolve => { release = resolve }); return { wait, release } }

test('background, interactive and audio use isolated bounded slots', async () => {
  const f = fixture(), running = gate(), done = gate()
  const first = f.run('background', async () => { running.release(); await done.wait })
  await running.wait
  try {
    await assert.rejects(f.run('background', () => assert.fail('must not dispatch')), { code: 'AI_CHANNEL_BUSY' })
    assert.equal(await f.run('interactive', async () => 'interactive'), 'interactive')
    assert.equal(await f.run('audio', async () => 'audio'), 'audio')
    await assert.rejects(f.run('background', () => assert.fail('global cap'), 'other'), { code: 'AI_CHANNEL_BUSY' })
  } finally { done.release(); await first }
  assert.equal(f.locks.size, 0)
  await f.run('background', async () => true)
})

test('audio cannot consume text capacity or exceed its own global cap', async () => {
  const f = fixture(), running = gate(), done = gate()
  const first = f.run('audio', async () => { running.release(); await done.wait })
  await running.wait
  try {
    await assert.rejects(f.run('audio', () => assert.fail(), 'other'), { code: 'AI_CHANNEL_BUSY' })
    await f.run('interactive', async () => true)
    await f.run('background', async () => true)
  } finally { done.release(); await first }
})

test('provider failures release execution ownership, not provider replay decisions', async () => {
  const f = fixture()
  await assert.rejects(f.run('background', async () => { throw Object.assign(Error('unknown outcome'), { code: 'MODEL_REQUEST_FAILED' }) }))
  assert.equal(f.locks.size, 0)
  await f.run('background', async () => true)
  assert.equal(isExecutionBusy({ code: 'MODEL_REQUEST_FAILED' }), false)
  assert.equal(isExecutionBusy({ code: 'BILLING_QUOTA_EXHAUSTED' }), false)
  assert.equal(isExecutionBusy({ code: 'AI_CHANNEL_BUSY' }), true)
})

test('connection loss aborts owned fetch context and destroys the client', async () => {
  const f = fixture()
  await f.run('background', async () => {
    const signal = executionSignal()
    assert.equal(signal.aborted, false)
    f.clients[0].emit('error', Error('connection lost'))
    assert.equal(signal.aborted, true)
  })
  assert.equal(f.locks.size, 0)
  assert.equal(executionSignal(), undefined)
})

test('invalid limits fail closed before acquiring database resources', async () => {
  const f = fixture()
  await assert.rejects(f.run('audio', () => assert.fail(), 'org', { AI_AUDIO_GLOBAL_CONCURRENT: '0' }), { code: 'AI_EXECUTION_CONFIG_INVALID' })
  assert.equal(f.clients.length, 0)
})

test('insufficient pool headroom fails before dispatch or acquisition', async () => {
  const f = fixture()
  f.pool.options = { max: 4 }
  await assert.rejects(f.run('interactive', () => assert.fail('must not dispatch')), { code: 'AI_EXECUTION_CONFIG_INVALID' })
  assert.equal(f.clients.length, 0)
})

test('interactive waits for a busy slot and resumes after its owner exits', async () => {
  const f = fixture(), ready = gate(), done = gate()
  const first = f.run('interactive', async () => { ready.release(); await done.wait }, 'org', { AI_TEXT_GLOBAL_CONCURRENT: '1' })
  await ready.wait
  const waiting = f.run('interactive', async () => 'resumed', 'org', { AI_TEXT_GLOBAL_CONCURRENT: '1' })
  setTimeout(done.release, 200)
  await first
  assert.equal(await waiting, 'resumed')
  assert.equal(f.locks.size, 0)
})
