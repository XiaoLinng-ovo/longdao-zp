import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { AiUsageService, type UsageInput } from './ai-usage.js'

const input: UsageInput = {
  organizationId: 'enterprise', actorId: 'actor', operation: 'jd', resourceId: 'job',
  key: 'test-operation-key', input: { prompt: 'fixture' }, model: 'fixture-model',
}

for (const fault of ['missing-settlement-row', 'settlement-write-failed', 'error-marker-write-failed'] as const) {
  test('AI ledger preserves a non-retryable reservation on ' + fault, async () => {
    let state = 'reserved', inserted = false, calls = 0
    const original = Object.assign(new Error('fixture DB write failure'), { code: 'DB_WRITE_FAILED' })
    const pool = { async query(sql: string, params?: unknown[]) {
      if (sql.includes('SELECT 1')) return { rows: [{}] }
      if (sql.includes('INSERT INTO ai_usage_tasks')) {
        if (inserted) return { rows: [] }
        inserted = true
        return { rows: [{ id: 'task' }] }
      }
      if (sql.includes('SELECT *')) return { rows: [{ state, fingerprint: fingerprintValue }] }
      if (sql.includes("SET state='settled'")) {
        if (fault === 'missing-settlement-row') return { rowCount: 0 }
        throw original
      }
      if (sql.includes('SET state=$2')) {
        if (fault === 'error-marker-write-failed') throw new Error('fixture secondary DB failure')
        state = String(params?.[1])
        return { rowCount: 1 }
      }
      throw new Error('Unexpected fixture query')
    } } as unknown as Pool
    const { createHash } = await import('node:crypto')
    const fingerprintValue = createHash('sha256').update(JSON.stringify([input.input, input.model])).digest('hex')
    const service = new AiUsageService(pool)
    await assert.rejects(service.execute(input, async () => { calls++; return { content: 'generated' } }),
      fault === 'missing-settlement-row' ? { code: 'AI_USAGE_SETTLEMENT_FAILED' } : (error: unknown) => error === original)
    assert.equal(state, fault === 'error-marker-write-failed' ? 'reserved' : 'uncertain')
    await assert.rejects(service.execute(input, async () => { calls++; return {} }), { code: 'AI_USAGE_TASK_EXISTS' })
    assert.equal(calls, 1)
  })
}
