import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export const sustainedResumePolicy = Object.freeze({ cycleCount: 16, cycleIntervalMs: 60000,
  sampleIntervalMs: 2000, postgresIntervalMs: 1000, processTreeIntervalMs: 30000,
  warmupMs: 5 * 60000, trendWindowMs: 5 * 60000, maxWindowRssGrowthBytes: 128 * 1024 ** 2,
  maxWindowHandleGrowth: 128, maxRunnerRssBytes: 768 * 1024 ** 2,
  maxProcessTreeRssBytes: 3 * 1024 ** 3, resourceJournalBytes: 64 * 1024 ** 2,
  postgresJournalBytes: 128 * 1024 ** 2, processTreeJournalBytes: 32 * 1024 ** 2,
})

export function sustainedMinutesFromArgs(args) {
  const index = args.indexOf('--sustain-minutes')
  if (index < 0) return undefined
  assert.equal(args.filter(value => value === '--sustain-minutes').length, 1, '持续时间参数不可重复')
  const minutes = Number(args[index + 1])
  assert.ok([1, 30, 120, 480].includes(minutes), '持续时间仅接受1（工具冒烟）、30、120、480分钟')
  assert.ok(!args.includes('--format-matrix'), '格式矩阵与持续负载应分开运行')
  return minutes
}

export async function runSustainedResumeCycles({ minutes, runCycle, healthy, onProgress = async () => {},
  now = () => performance.now(), sleep = delay }) {
  assert.ok([1, 30, 120, 480].includes(minutes))
  const started = now(), durationMs = minutes * 60000
  const result = { requestedMinutes: minutes, acceptance: minutes === 1 ? '工具冒烟，不是长期验收' : '仅简历链路持续负载，不是全业务混合验收',
    startedAt: new Date().toISOString(), cycles: 0, imported: 0, deleted: 0, wallMs: 0, passed: false }
  // One unchanged instance throughout; a completed cycle never substitutes for elapsed wall time.
  while (now() - started < durationMs) {
    healthy()
    const began = now()
    await runCycle(sustainedResumePolicy.cycleCount)
    result.cycles++; result.imported += sustainedResumePolicy.cycleCount; result.deleted += 4
    result.wallMs = now() - started
    await onProgress(result)
    const next = Math.min(started + durationMs, began + sustainedResumePolicy.cycleIntervalMs)
    while (now() < next) { healthy(); await sleep(Math.min(1000, next - now())) }
  }
  healthy(); result.wallMs = now() - started
  assert.ok(result.wallMs >= durationMs && result.cycles >= 1, '实际墙钟持续时间或有效业务周期不足')
  result.finishedAt = new Date().toISOString(); result.passed = true
  await onProgress(result)
  return result
}

function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] }
export function checkSustainedResourceTrend(samples, elapsedMs) {
  const policy = sustainedResumePolicy
  if (elapsedMs < policy.warmupMs + 2 * policy.trendWindowMs) return { sufficient: false, reason: '预热后不足两个完整观察窗口' }
  const first = samples.filter(row => row.elapsedMs >= policy.warmupMs && row.elapsedMs < policy.warmupMs + policy.trendWindowMs)
  const last = samples.filter(row => row.elapsedMs >= elapsedMs - policy.trendWindowMs && row.elapsedMs <= elapsedMs)
  const minimum = Math.floor(policy.trendWindowMs / policy.sampleIntervalMs / 2)
  assert.ok(first.length >= minimum && last.length >= minimum, '资源趋势采样不足，不能判定稳定')
  const result = { sufficient: true, firstWindowSamples: first.length, lastWindowSamples: last.length, processes: {} }
  for (const role of ['api', 'worker', 'runner']) {
    const rssGrowthBytes = median(last.map(row => row[role].rss)) - median(first.map(row => row[role].rss))
    const handleGrowth = median(last.map(row => row[role].handles)) - median(first.map(row => row[role].handles))
    result.processes[role] = { rssGrowthBytes, handleGrowth }
    assert.ok(rssGrowthBytes <= policy.maxWindowRssGrowthBytes, role + '预热后窗口RSS增长超过预算')
    assert.ok(handleGrowth <= policy.maxWindowHandleGrowth, role + '预热后窗口句柄增长超过预算')
  }
  return result
}
