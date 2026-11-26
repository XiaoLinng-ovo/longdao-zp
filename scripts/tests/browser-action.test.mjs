import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { browserAction } from '../browser-action.mjs'

test('浏览器动作与事件同时完成后返回实际事件', async () => {
  let acted = false
  const result = await browserAction(Promise.resolve('response'), async () => { await delay(10); acted = true })
  assert.equal(result, 'response')
  assert.equal(acted, true)
})

test('事件先超时仍进入调用方清理，稍后动作失败不会形成未处理拒绝', async () => {
  let cleaned = false
  const timeout = new Error('synthetic-event-timeout')
  await assert.rejects(async () => {
    try { await browserAction(delay(5).then(() => { throw timeout }), async () => { await delay(25); throw new Error('synthetic-action-timeout') }) }
    finally { cleaned = true }
  }, error => error === timeout)
  assert.equal(cleaned, true)
  await delay(40)
})

test('动作先失败或同步抛错，后到事件拒绝仍已受处理', async () => {
  for (const action of [() => { throw new Error('synthetic-action-failed') }, async () => { throw new Error('synthetic-action-failed') }]) {
    await assert.rejects(browserAction(delay(15).then(() => { throw new Error('synthetic-late-event') }), action), /synthetic-action-failed/)
    await delay(30)
  }
})
