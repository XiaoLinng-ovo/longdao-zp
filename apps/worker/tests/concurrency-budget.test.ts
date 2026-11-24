import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createConcurrencyBudget } from '../src/db/concurrency-budget.js'

test('all company queues share one FIFO concurrency budget and release is idempotent', async () => {
  const acquire = createConcurrencyBudget(3)
  let active = 0, peak = 0
  const entered: number[] = []
  await Promise.all(Array.from({length: 48}, async (_, index) => {
    const release = await acquire()
    peak = Math.max(peak, ++active)
    entered.push(index)
    try { await delay(index % 3) } finally { active--; release(); release() }
  }))
  assert.equal(peak, 3)
  assert.equal(active, 0)
  assert.deepEqual(entered, Array.from({length: 48}, (_, index) => index))
})
test('invalid budgets are rejected', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => createConcurrencyBudget(value))
})

test('aborted waiters leave the FIFO without stealing a future permit', async () => {
  const acquire = createConcurrencyBudget(1)
  const release = await acquire()
  const aborted = new AbortController()
  const waiting = acquire(aborted.signal)
  const rejected = assert.rejects(waiting, { name: 'AbortError' })
  let nextEntered = false
  const next = acquire().then(releaseNext => { nextEntered = true; return releaseNext })
  aborted.abort()
  await rejected
  assert.equal(nextEntered, false)
  release()
  const releaseNext = await next
  assert.equal(nextEntered, true)
  releaseNext()
  ;(await acquire())()
})

test('an already-aborted request cannot reserve an available permit', async () => {
  const acquire = createConcurrencyBudget(1)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(acquire(aborted.signal), { name: 'AbortError' })
  ;(await acquire())()
})

test('aborting after permit handoff cannot leak the transferred permit', async () => {
  const acquire = createConcurrencyBudget(1)
  const release = await acquire()
  const aborted = new AbortController()
  const waiting = acquire(aborted.signal)
  release()
  aborted.abort()
  ;(await waiting)()
  ;(await acquire())()
})
