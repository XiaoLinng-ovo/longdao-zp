import assert from 'node:assert/strict'
import test from 'node:test'
import { sustainedMinutesFromArgs, sustainedResumePolicy as policy, runSustainedResumeCycles, checkSustainedResourceTrend } from '../sustained-resume-policy.mjs'

test('持续参数区分工具冒烟和验收档位，拒绝缺失、重复、任意缩时和混合模式', () => {
  assert.equal(sustainedMinutesFromArgs([]), undefined)
  for (const minutes of [1, 30, 120, 480]) assert.equal(sustainedMinutesFromArgs(['--sustain-minutes', String(minutes)]), minutes)
  for (const args of [['--sustain-minutes'], ['--sustain-minutes', '0'], ['--sustain-minutes', '2'],
    ['--sustain-minutes', 'NaN'], ['--sustain-minutes', '30', '--sustain-minutes', '30'],
    ['--sustain-minutes', '30', '--format-matrix']]) assert.throws(() => sustainedMinutesFromArgs(args))
})

test('调度单测使用虚拟钟，只验证算法，不作为真实墙钟验收', async () => {
  let clock = 0, checks = 0
  const cycles = []
  const result = await runSustainedResumeCycles({ minutes: 30, now: () => clock,
    sleep: async ms => { clock += ms }, healthy: () => { checks++ },
    runCycle: async count => { cycles.push({ at: clock, count }); clock += 40000 } })
  assert.equal(result.wallMs, 30 * 60000); assert.equal(result.cycles, 30)
  assert.equal(result.imported, 480); assert.equal(result.deleted, 120)
  assert.ok(cycles.every((row, index) => row.at === index * 60000 && row.count === 16)); assert.ok(checks > 30)
  assert.equal(result.passed, true); assert.match(result.acceptance, /不是全业务/)
})

test('失败立即停止后续周期，空闲间隔同样执行健康检查', async () => {
  let clock = 0, cycles = 0
  await assert.rejects(runSustainedResumeCycles({ minutes: 1, now: () => clock,
    sleep: async ms => { clock += ms }, runCycle: async () => { cycles++; clock += 100 },
    healthy: () => { if (clock >= 100) throw Error('后台失败') } }), /后台失败/)
  assert.equal(cycles, 1)
  await assert.rejects(runSustainedResumeCycles({ minutes: 1, healthy: () => {}, runCycle: async () => { throw Error('导入失败') } }), /导入失败/)
})

function samples(elapsedMs, changes = {}) {
  return Array.from({ length: Math.floor(elapsedMs / policy.sampleIntervalMs) + 1 }, (_, index) => {
    const elapsedMs = index * policy.sampleIntervalMs
    const last = elapsedMs >= 25 * 60000
    const item = { elapsedMs }
    for (const role of ['api', 'worker', 'runner']) item[role] = { rss: 200 * 1024 ** 2 + (last ? changes[role + 'Rss'] ?? 0 : 0), handles: 20 + (last ? changes[role + 'Handles'] ?? 0 : 0) }
    return item
  })
}
test('趋势预算检查预热后的完整窗口，不以未崩溃冒充资源稳定', () => {
  assert.equal(checkSustainedResourceTrend([], 60000).sufficient, false)
  assert.equal(checkSustainedResourceTrend(samples(30 * 60000), 30 * 60000).sufficient, true)
  assert.throws(() => checkSustainedResourceTrend(samples(30 * 60000, { workerRss: policy.maxWindowRssGrowthBytes + 1 }), 30 * 60000), /RSS/)
  assert.throws(() => checkSustainedResourceTrend(samples(30 * 60000, { apiHandles: policy.maxWindowHandleGrowth + 1 }), 30 * 60000), /句柄/)
  assert.throws(() => checkSustainedResourceTrend([], 30 * 60000), /采样不足/)
})
