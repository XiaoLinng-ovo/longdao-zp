import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analysisQueueDepth, reserveAnalysisCapacity } from './analysis-capacity.js'
import { organizationSchemaName } from '../db/tenant-context.js'
import type { RepositoryQueryExecutor } from './repositories/types.js'

const org = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

test('队列统计汇总所有公司并排除 public 历史副本', async () => {
  const calls: string[] = []
  const db = { async query(sql: string, values: unknown[]) {
    calls.push(sql)
    if (sql.includes('organization_schemas')) return { rows: [org, other].map(id => ({ organization_id: id, schema_name: organizationSchemaName(id) })) }
    if (sql.includes('public.analysis_tasks')) {
      assert.deepEqual(values[1], [org, other])
      return { rows: [{ total: 1, workspace: 0 }] }
    }
    return { rows: [{ total: 3, workspace: sql.includes(organizationSchemaName(org)) ? 3 : 0 }] }
  } } as unknown as RepositoryQueryExecutor
  assert.deepEqual(await analysisQueueDepth(db, org, true), { total: 7, workspace: 3 })
  assert.equal(calls.length, 4)
})

test('非法公司 Schema 在拼接 SQL 前被拒绝', async () => {
  let calls = 0
  const db = { async query() { calls++; return { rows: [{ organization_id: org, schema_name: 'public;DROP TABLE users' }] } } } as unknown as RepositoryQueryExecutor
  await assert.rejects(analysisQueueDepth(db, org, true), /INVALID_TENANT_SCHEMA/)
  assert.equal(calls, 1)
})

test('预留先获取跨进程事务锁，队列已满时拒绝', async () => {
  const calls: string[] = []
  const db = { async query(sql: string) {
    calls.push(sql)
    if (sql.includes('organization_schemas')) return { rows: [] }
    return { rows: [{ total: 1000000000, workspace: 1000000000 }] }
  } } as unknown as RepositoryQueryExecutor
  await assert.rejects(reserveAnalysisCapacity(db, org), { status: 429, code: 'RESUME_ANALYSIS_QUEUE_FULL' })
  assert.match(calls[0]!, /pg_advisory_xact_lock/)
})
