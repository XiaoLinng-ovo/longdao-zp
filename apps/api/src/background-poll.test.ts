import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startBackgroundPoll } from './background-poll.js'

test('轮询限制并发，关闭后不领取新任务，且等待所有在途任务', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  const release: Array<() => void> = []
  let calls = 0, drained = false
  const stop = startBackgroundPoll({ intervalMs: 10, concurrency: 2, onError: assert.fail, run: async stopped => {
    calls++
    await new Promise<void>(resolve => release.push(resolve))
    assert.equal(stopped(), true)
  } })
  assert.equal(calls, 1)
  context.mock.timers.tick(10)
  assert.equal(calls, 2)
  context.mock.timers.tick(100)
  assert.equal(calls, 2)
  const closing = stop()
  assert.equal(stop(), closing)
  void closing.then(() => { drained = true })
  release[0]!()
  await Promise.resolve()
  assert.equal(drained, false)
  release[1]!()
  await closing
  context.mock.timers.tick(100)
  assert.equal(calls, 2)
  context.mock.timers.reset()
})

test('轮询失败释放并发名额，错误不阻止关闭', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  let errors = 0
  const stop = startBackgroundPoll({ intervalMs: 10, run: async () => { throw Error('synthetic') }, onError: () => { errors++ } })
  await stop()
  assert.equal(errors, 1)
  context.mock.timers.reset()
})
