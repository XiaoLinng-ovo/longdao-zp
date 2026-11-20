import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

// Observe the production poller; never perform cleanup on its behalf.
export async function verifyObjectCleanup({ pool, keys, inventory, proof, persist,
  now = Date.now, wait = delay }) {
  assert.ok(keys.length > 0 && new Set(keys).size === keys.length)
  const started = now()
  proof.budgetMs = keys.length * 10_000 + 30_000
  proof.snapshots = []
  let previous
  for (;;) {
    const { rows } = await pool.query(`SELECT storage_key,status,attempts,last_error FROM public.object_cleanup_tasks
      WHERE storage_kind='resume' AND storage_key=ANY($1::text[]) ORDER BY storage_key`, [keys])
    assert.equal(rows.length, keys.length, '删除后必须为每个对象登记正式清理任务')
    assert.deepEqual(rows.map(row => row.storage_key).sort(), [...keys].sort())
    const remaining = (await inventory()).map(file => file.key).sort()
    const state = JSON.stringify({ tasks: rows, remaining })
    if (state !== previous) {
      proof.snapshots.push({ elapsedMs: now() - started, tasks: rows, remaining })
      previous = state
      await persist()
    }
    for (const row of rows) {
      assert.ok(['pending', 'completed'].includes(row.status), '正式清理任务失败：' + JSON.stringify(row))
      assert.equal(row.last_error, null, '正式清理出现错误或保留引用：' + JSON.stringify(row))
    }
    if (rows.every(row => row.status === 'completed') && remaining.length === 0) {
      proof.elapsedMs = now() - started
      proof.passed = true
      return
    }
    assert.ok(now() - started < proof.budgetMs, '正式后台物理清理超时：' + state)
    await wait(250)
  }
}
