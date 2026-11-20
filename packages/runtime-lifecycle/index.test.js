import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { bindPoolCancellation, combinedRuntimeSignal, createShutdownBudget, currentRuntimeSignal, runWithRuntimeSignal, runtimeFetch, ShutdownTimeoutError } from './index.js'

test('借出的数据库连接断开时必须销毁，复用不留下监听器', async () => {
  for (const signal of [undefined, new AbortController().signal]) {
    const pooledError = new Error('synthetic connection loss')
    const releases = []
    const connection = new EventEmitter()
    const pool = bindPoolCancellation({ async connect() {
      connection.release = error => releases.push(error)
      return connection
    } }, signal)
    const first = await pool.connect()
    assert.equal(first.listenerCount('error'), 1)
    first.release()
    assert.equal(first.listenerCount('error'), 0)
    const second = await pool.connect()
    second.emit('error', pooledError)
    second.release(false)
    assert.equal(second.listenerCount('error'), 0)
    assert.deepEqual(releases, [undefined, true])
  }
})

test('运行时信号跨异步保持且实例互不影响', async () => {
  const a = new AbortController(), b = new AbortController()
  await Promise.all([a, b].map(controller => runWithRuntimeSignal(controller.signal, async () => {
    await sleep(2)
    assert.equal(currentRuntimeSignal(), controller.signal)
  })))
  assert.equal(currentRuntimeSignal(), undefined)
  assert.equal(combinedRuntimeSignal(), undefined)
  runWithRuntimeSignal(a.signal, () => {
    const signal = combinedRuntimeSignal(b.signal)
    b.abort()
    assert.equal(signal.aborted, true)
    assert.equal(a.signal.aborted, false)
  })
})

test('正常排空不触发取消并移除所有残余标签', async () => {
  const budget = createShutdownBudget(200)
  assert.equal(await budget.run('正常资源', async () => 42), 42)
  assert.equal(budget.signal.aborted, false)
  assert.deepEqual(budget.pending(), [])
  await sleep(210)
  assert.equal(budget.signal.aborted, false)
})

test('关停预算实际取消任务并等待清理完成', async () => {
  const budget = createShutdownBudget(150)
  let cancelled = false, cleaned = false
  await budget.run('可取消操作', async () => {
    await sleep(10000, undefined, { signal: budget.signal }).catch(() => { cancelled = true })
    await sleep(5)
    cleaned = true
  })
  assert.ok(cancelled && cleaned)
  assert.deepEqual(budget.pending(), [])
})

test('不可取消工作明确超时，晚失败有处理且保留真实残余直到排空', async () => {
  const budget = createShutdownBudget(30)
  let fail
  const pending = new Promise((_, reject) => { fail = reject })
  await assert.rejects(budget.run('阻塞资源', () => pending), error => {
    assert.ok(error instanceof ShutdownTimeoutError)
    assert.equal(error.code, 'SHUTDOWN_TIMEOUT')
    assert.deepEqual(error.pending, ['阻塞资源'])
    return true
  })
  assert.deepEqual(budget.pending(), ['阻塞资源'])
  fail(new Error('晚失败'))
  await sleep(0)
  assert.deepEqual(budget.pending(), [])
})

test('嵌套排空共享绝对截止时间，不逐层叠加预算', async () => {
  const budget = createShutdownBudget(100)
  const started = performance.now()
  await assert.rejects(budget.run('外层', async () => {
    await sleep(60)
    await budget.run('内层', () => sleep(120))
  }), ShutdownTimeoutError)
  assert.ok(performance.now() - started < 160)
  await sleep(100)
  assert.deepEqual(budget.pending(), [])
})

test('同步错误传递且取消计时器清除', async () => {
  const budget = createShutdownBudget(20)
  await assert.rejects(budget.run('启动失败', () => { throw new Error('预期错误') }), /预期错误/)
  await sleep(30)
  assert.equal(budget.signal.aborted, false)
  assert.deepEqual(budget.pending(), [])
})

test('拒绝无效关停预算', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 600001]) assert.throws(() => createShutdownBudget(value))
})

test('取消等待连接立即失败且晚到连接被销毁', async () => {
  const controller = new AbortController()
  let arrive, connects = 0, destroyed = 0
  const pool = bindPoolCancellation({ connect() { connects++; return new Promise(resolve => { arrive = resolve }) } }, controller.signal)
  const acquiring = pool.connect()
  await sleep(0)
  controller.abort(new Error('运行时关闭'))
  await assert.rejects(acquiring, /运行时关闭/)
  arrive({ release(error) { assert.equal(error, true); destroyed++ } })
  await sleep(0)
  assert.equal(destroyed, 1)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  await assert.rejects(pool.connect(), /运行时关闭/)
  assert.equal(connects, 1)
})

test('借出连接只销毁一次，取消后的 finally 释放不会掩盖原错误', async () => {
  const controller = new AbortController(), releases = []
  const pool = bindPoolCancellation({ async connect() { return { release(error) { releases.push(error) } } } }, controller.signal)
  const client = await pool.connect()
  controller.abort()
  client.release()
  assert.deepEqual(releases, [true])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('租户包装覆盖 release 不影响取消所持连接', async () => {
  const controller = new AbortController(), releases = []
  const pool = bindPoolCancellation({ async connect() { return { release(error) { releases.push(error) } } } }, controller.signal)
  const client = await pool.connect()
  const ownedRelease = client.release
  let released = false
  client.release = () => { assert.equal(released, false); released = true; ownedRelease() }
  controller.abort()
  client.release()
  assert.deepEqual(releases, [true])
})

test('正常释放移除监听器，保留重复释放错误', async () => {
  const controller = new AbortController(), releases = []
  const pool = bindPoolCancellation({ async connect() { return { release(error) { releases.push(error) } } } }, controller.signal)
  const client = await pool.connect()
  client.release()
  assert.throws(() => client.release(), /already been released/)
  controller.abort()
  assert.deepEqual(releases, [undefined])
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('连接失败和回调模式均清理监听器', async () => {
  const controller = new AbortController()
  const pool = bindPoolCancellation({ async connect() { throw new Error('连接失败') } }, controller.signal)
  await assert.rejects(pool.connect(), /连接失败/)
  await new Promise(resolve => pool.connect(error => { assert.match(error.message, /连接失败/); resolve() }))
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  const good = bindPoolCancellation({ async connect() { return { release() {} } } }, controller.signal)
  await new Promise((resolve, reject) => good.connect((error, client, release) => {
    if (error) { reject(error); return }
    assert.equal(release, client.release); release(); resolve()
  }))
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('运行时取消真实 HTTP 响应体且不修改全局 fetch', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  let enter
  const entered = new Promise(resolve => { enter = resolve })
  const server = createServer((_req, res) => { res.writeHead(200); res.write('{'); enter() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const work = runWithRuntimeSignal(controller.signal, async () => {
      const response = await runtimeFetch('http://127.0.0.1:' + server.address().port)
      await response.json()
    })
    const rejected = assert.rejects(work)
    await entered
    controller.abort(new Error('关闭请求体'))
    await rejected
    assert.equal(globalThis.fetch, original)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

function cancellationFixture({ ssl = false, direct = false, confirm = true, failure, idle = false } = {}) {
  const events = [], controller = new AbortController()
  let target, channel
  class PgClient {
    constructor(parameters) {
      this.connectionParameters = parameters
      this.processID = 42
      this.secretKey = 123456
      this.readyForQuery = idle
      this.connection = new EventEmitter()
      const connection = this.connection
      connection.ssl = ssl
      connection.sslNegotiation = direct ? 'direct' : 'postgres'
      connection.stream = { destroy() { events.push('destroy-channel') } }
      connection.connect = () => queueMicrotask(() => {
        if (failure) { connection.emit('error', Object.assign(new Error('不应泄漏的连接细节'), { code: failure })); return }
        events.push('connect')
        connection.emit('connect')
        if (ssl && direct) connection.emit('sslconnect')
      })
      connection.requestSsl = () => { events.push('request-ssl'); queueMicrotask(() => connection.emit('sslconnect')) }
      connection.cancel = (pid, key) => {
        assert.equal(pid, 42); assert.equal(key, 123456)
        events.push('cancel')
        queueMicrotask(() => {
          connection.emit('error', Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
          if (confirm) { target.readyForQuery = true; target.connection.emit('readyForQuery') }
          connection.emit('end')
        })
      }
      if (target) channel = this
    }
    release(error) { assert.equal(error, true); events.push('release-target') }
  }
  target = new PgClient({ host: '127.0.0.1', port: 5432, ssl })
  const pool = bindPoolCancellation({ async connect() { return target }, async end() { events.push('end-pool') } }, controller.signal)
  return { pool, controller, events, target, channel: () => channel }
}

for (const options of [{}, { ssl: true }, { ssl: true, direct: true }]) {
  test('取消包等待目标确认再释放，保留加密握手：' + JSON.stringify(options), async () => {
    const fixture = cancellationFixture(options)
    const client = await fixture.pool.connect()
    fixture.controller.abort()
    client.release()
    assert.equal(fixture.events.includes('release-target'), false)
    await new Promise((resolve, reject) => fixture.pool.end(error => error ? reject(error) : resolve()))
    assert.equal(fixture.events.filter(event => event === 'cancel').length, 1)
    assert.equal(fixture.events.filter(event => event === 'release-target').length, 1)
    assert.ok(fixture.events.indexOf('cancel') < fixture.events.indexOf('release-target'))
    assert.ok(fixture.events.indexOf('release-target') < fixture.events.indexOf('end-pool'))
    assert.equal(fixture.target.connection.listenerCount('readyForQuery'), 0)
    assert.equal(fixture.events.includes('request-ssl'), Boolean(options.ssl && !options.direct))
  })
}

test('取消通道失败不能被正常关闭掩盖，错误只含脱敏代码', async () => {
  const fixture = cancellationFixture({ failure: 'ECONNREFUSED' })
  await fixture.pool.connect()
  fixture.controller.abort()
  await assert.rejects(fixture.pool.end(), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors[0].reasonCode, 'ECONNREFUSED')
    assert.equal(JSON.stringify(error).includes('不应泄漏'), false)
    return true
  })
  assert.equal(fixture.events.filter(event => event === 'release-target').length, 1)
})

test('仅收到取消通道重置而无目标确认时，不能宣称取消成功', async () => {
  const fixture = cancellationFixture({ confirm: false })
  await fixture.pool.connect()
  fixture.controller.abort()
  await assert.rejects(fixture.pool.end(), error => error.errors[0].reasonCode === 'CANCEL_CONFIRMATION_TIMEOUT')
  assert.equal(fixture.target.connection.listenerCount('readyForQuery'), 0)
})

test('空闲租约直接销毁，不发送无效取消包', async () => {
  const fixture = cancellationFixture({ idle: true })
  await fixture.pool.connect()
  fixture.controller.abort()
  await fixture.pool.end()
  assert.deepEqual(fixture.events, ['release-target', 'end-pool'])
})
