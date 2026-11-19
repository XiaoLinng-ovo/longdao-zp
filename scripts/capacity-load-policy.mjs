import assert from 'node:assert/strict'

export const capacityPolicy = Object.freeze({ seed: 20261116, companies: 4, uploadLanes: 8,
  uploadConcurrency: 6, workspaceUploadConcurrency: 3, queueLimit: 2000, workspaceQueueLimit: 500,
  fileBytes: 4096, requestTimeoutMs: 15000, tierTimeoutMs: 20 * 60 * 1000,
  max429Retries: 20, minFreeBytes: 2 * 1024 ** 3, maxApiRssBytes: 768 * 1024 ** 2,
  maxWorkerRssBytes: 768 * 1024 ** 2, maxTierObjectBytes: 64 * 1024 ** 2,
  sampleIntervalMs: 2000, maxReadP99Ms: 5000,
})

export function retry429Milliseconds(response, attempt) {
  if (response.status !== 429) return undefined
  const code = response.body?.error?.code
  if (!['RESUME_UPLOAD_BUSY', 'RESUME_ANALYSIS_QUEUE_FULL'].includes(code)) return undefined
  assert.ok(Number.isInteger(attempt) && attempt >= 0 && attempt < capacityPolicy.max429Retries, '限流重试次数已耗尽')
  const seconds = Number(response.retryAfter)
  assert.ok(Number.isFinite(seconds) && seconds >= 1 && seconds <= 60, '限流响应缺少有效 Retry-After')
  return seconds * 1000
}

export function latencySummary(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0
  return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1) ?? 0 }
}

export async function concurrentLanes(items, count, action) {
  assert.ok(Number.isInteger(count) && count > 0)
  let next = 0, failure
  // Stop scheduling after the first failure, but drain every already-started request.
  const outcomes = await Promise.allSettled(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++
      try { await action(items[index], index) } catch (error) { failure ??= error; throw error }
    }
  }))
  if (failure) throw failure
  assert.ok(outcomes.every(outcome => outcome.status === 'fulfilled'))
}
