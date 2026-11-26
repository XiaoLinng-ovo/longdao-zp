import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyObjectCleanup } from '../object-cleanup-verification.mjs'

function fixture(count = 9, mode = 'normal') {
  let clock = 0
  const keys = Array.from({ length: count }, (_, index) => 'object-' + index)
  const completed = () => mode === 'timeout' ? 0 : Math.min(count, Math.floor(clock / 10_000))
  const proof = {}
  return { keys, proof, now: () => clock, async wait(ms) { clock += ms }, async persist() {},
    pool: { async query(sql, values) {
      assert.match(sql, /object_cleanup_tasks/)
      assert.deepEqual(values, [keys])
      return { rows: keys.map((storage_key, index) => ({ storage_key,
        status: mode === 'failed' ? 'failed' : index < completed() ? 'completed' : 'pending',
        attempts: index < completed() ? 1 : 0,
        last_error: mode === 'retained' ? '对象仍被引用，已保留' : null })) }
    } },
    async inventory() { return keys.slice(completed()).map(key => ({ key })) },
  }
}
test('清理验收允许九个对象按正式十秒轮询逐个完成并保存证据', async () => {
  const input = fixture()
  await verifyObjectCleanup(input)
  assert.equal(input.proof.budgetMs, 120_000)
  assert.equal(input.proof.elapsedMs, 90_000)
  assert.equal(input.proof.passed, true)
  assert.equal(input.proof.snapshots.at(-1).remaining.length, 0)
})
test('清理失败与引用保留立即终止，不用延长预算掩盖', async () => {
  for (const mode of ['failed', 'retained']) {
    const input = fixture(1, mode)
    await assert.rejects(verifyObjectCleanup(input), /正式清理/u)
    assert.equal(input.now(), 0)
    assert.notEqual(input.proof.passed, true)
    assert.equal(input.proof.snapshots.length, 1)
  }
})
test('正式清理一直没有进展时按有界预算失败', async () => {
  const input = fixture(1, 'timeout')
  await assert.rejects(verifyObjectCleanup(input), /超时/u)
  assert.equal(input.now(), 40_000)
  assert.notEqual(input.proof.passed, true)
})
