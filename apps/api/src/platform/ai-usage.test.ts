import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { AiUsageService, type UsageInput } from './ai-usage.js'

const input: UsageInput = {
  organizationId: 'enterprise', actorId: 'actor', operation: 'jd', resourceId: 'job',
  key: 'test-operation-key', input: { prompt: 'fixture' }, model: 'fixture-model',
}

function createPool(options: { serviceStatus?: string; settlement?: 'missing' | 'throws'; failMarker?: boolean } = {}) {
  let generations = 0
  let taskNumber = 0
  let lockTail = Promise.resolve()
  const tasks = new Map<string, Record<string, any>>()
  const keyFor = (values: unknown[] = []) => JSON.stringify(values.slice(0, 5))

  const pool = {
    async connect() {
      let unlock: (() => void) | undefined
      let snapshotTasks = new Map<string, Record<string, any>>()
      let snapshotGenerations = 0
      let inTransaction = false
      return {
        async query(sql: string, values: unknown[] = []) {
          if (sql === 'BEGIN') {
            const previous = lockTail
            lockTail = new Promise<void>(resolve => { unlock = resolve })
            await previous
            inTransaction = true
            snapshotTasks = new Map([...tasks].map(([key, task]) => [key, { ...task }]))
            snapshotGenerations = generations
            return { rows: [] }
          }
          if (sql === 'COMMIT') {
            inTransaction = false
            unlock?.()
            return { rows: [] }
          }
          if (sql === 'ROLLBACK') {
            if (inTransaction) {
              tasks.clear()
              for (const [key, task] of snapshotTasks) tasks.set(key, task)
              generations = snapshotGenerations
              inTransaction = false
              unlock?.()
            }
            return { rows: [] }
          }
          if (sql.includes('billing_policy_versions')) return {rows:[{id:'1',config:{trial:{aiGenerations:3}}}]}
          if (sql.includes('SELECT service_status FROM organizations')) {
            return { rows: [{ service_status: options.serviceStatus ?? 'trial' }] }
          }
          if (sql.includes('FROM organization_members m JOIN users u')) return { rows: [{}] }
          if (sql.includes('INSERT INTO ai_usage_tasks')) {
            const key = keyFor(values)
            if (tasks.has(key)) return { rows: [] }
            const task = {
              id: `task-${++taskNumber}`,
              fingerprint: values[5],
              state: 'reserved',
              result: null,
              trial_quota_charged: false,
            }
            tasks.set(key, task)
            return { rows: [{ id: task.id }] }
          }
          if (sql.includes('SELECT * FROM ai_usage_tasks')) return { rows: [tasks.get(keyFor(values))].filter(Boolean) }
          if (sql.includes('INSERT INTO organization_trial_ai_usage')) return { rows: [] }
          if (sql.includes('UPDATE organization_trial_ai_usage') && sql.includes('generations=generations+1')) {
            if (generations >= Number(values[1])) return { rows: [] }
            generations++
            return { rows: [{ generations }] }
          }
          if (sql.includes('UPDATE ai_usage_tasks SET trial_quota_charged=TRUE')) {
            const task = [...tasks.values()].find(candidate => candidate.id === values[0])
            if (task) task.trial_quota_charged = true
            return { rows: [], rowCount: task ? 1 : 0 }
          }
          throw new Error(`Unexpected transaction query: ${sql}`)
        },
        release() {
          if (inTransaction) {
            inTransaction = false
            unlock?.()
          }
        },
      }
    },
    async query(sql: string, values: unknown[] = []) {
      if (sql.includes("SET state='settled'")) {
        if (options.settlement === 'throws') throw new Error('fixture DB write failure')
        if (options.settlement === 'missing') return { rowCount: 0, rows: [] }
        const task = [...tasks.values()].find(candidate => candidate.id === values[0])
        if (!task || task.state !== 'reserved') return { rowCount: 0, rows: [] }
        task.state = 'settled'
        task.result = JSON.parse(String(values[1]))
        return { rowCount: 1, rows: [] }
      }
      if (sql.includes('WITH released AS')) {
        if (options.failMarker) throw new Error('fixture secondary DB failure')
        const task = [...tasks.values()].find(candidate => candidate.id === values[0])
        if (!task || task.state !== 'reserved') return { rowCount: 0, rows: [] }
        task.state = values[1]
        if (values[1] === 'released' && task.trial_quota_charged) generations = Math.max(0, generations - 1)
        return { rowCount: 1, rows: [] }
      }
      throw new Error(`Unexpected pool query: ${sql}`)
    },
  }
  return { pool: pool as unknown as Pool, usage: () => generations }
}

test('trial job specs and JDs exceed three generations without consuming trial credits', async () => {
  const { pool, usage } = createPool()
  const service = new AiUsageService(pool)
  let calls = 0
  for (let index = 0; index < 3; index++) {
    const operation = index % 2 === 0 ? 'jd' : 'job_spec'
    await service.execute({ ...input, operation, resourceId: `job-${index}`, key: `quota-key-${index}` }, async () => {
      calls++
      return { generated: index }
    })
  }
  await service.execute({ ...input, operation: 'job_spec', resourceId: 'job-four', key: 'quota-key-four' }, async () => {
      calls++
      return { generated: 4 }
    })
  assert.equal(calls, 4)
  assert.equal(usage(), 0)
})

test('settled idempotent replay returns the saved result without consuming another generation', async () => {
  const { pool, usage } = createPool()
  const service = new AiUsageService(pool)
  let calls = 0
  const generate = async () => { calls++; return { content: 'saved' } }
  const first = await service.execute(input, generate)
  const replay = await service.execute(input, generate)
  assert.deepEqual(replay, first)
  assert.equal(calls, 1)
  assert.equal(usage(), 0)
})

test('concurrent trial requests are not restricted by the retired three-generation limit', async () => {
  const { pool, usage } = createPool()
  const service = new AiUsageService(pool)
  let calls = 0
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => service.execute(
    { ...input, operation: index % 2 ? 'jd' : 'job_spec', resourceId: `concurrent-${index}`, key: `concurrent-key-${index}` },
    async () => { calls++; return { index } },
  )))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 8)
  assert.equal(results.filter(result => result.status === 'rejected').length, 0)
  assert.equal(calls, 8)
  assert.equal(usage(), 0)
})

test('enabled organizations do not use the trial AI generation limit', async () => {
  const { pool, usage } = createPool({ serviceStatus: 'enabled' })
  const service = new AiUsageService(pool)
  for (let index = 0; index < 5; index++) {
    await service.execute({ ...input, resourceId: `enabled-${index}`, key: `enabled-key-${index}` }, async () => ({ index }))
  }
  assert.equal(usage(), 0)
})

test('an explicitly rejected model request does not alter the retired trial counter', async () => {
  const { pool, usage } = createPool()
  const service = new AiUsageService(pool)
  const rejected = Object.assign(new Error('provider rejected request'), { code: 'MODEL_HTTP_ERROR' })
  await assert.rejects(service.execute(input, async () => { throw rejected }), error => error === rejected)
  assert.equal(usage(), 0)
  await service.execute({ ...input, key: 'replacement-operation' }, async () => ({ content: 'generated' }))
  assert.equal(usage(), 0)
})

for (const fault of ['missing-settlement-row', 'settlement-write-failed', 'error-marker-write-failed'] as const) {
  test('AI ledger preserves a non-retryable reservation on ' + fault, async () => {
    const { pool } = createPool({
      settlement: fault === 'missing-settlement-row' ? 'missing' : 'throws',
      failMarker: fault === 'error-marker-write-failed',
    })
    const service = new AiUsageService(pool)
    let calls = 0
    await assert.rejects(service.execute(input, async () => { calls++; return { content: 'generated' } }),
      fault === 'missing-settlement-row' ? { code: 'AI_USAGE_SETTLEMENT_FAILED' } : error => error instanceof Error && error.message === 'fixture DB write failure')
    await assert.rejects(service.execute(input, async () => { calls++; return {} }), { code: 'AI_USAGE_TASK_EXISTS' })
    assert.equal(calls, 1)
  })
}
