import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import { ObjectCleanupService, cleanupRetryDelaySeconds } from './object-cleanup.js'
const id = '11111111-1111-4111-8111-111111111111'
function fixture(options: { references?: boolean; fail?: boolean; schema?: string; empty?: boolean; audio?: boolean; lost?: boolean; attempts?: number; location?: string | null } = {}) {
  const calls: { sql: string; values: unknown[] }[] = [], deleted: string[] = [], audioDeleted: string[] = []
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({sql, values})
    if (sql.startsWith('SELECT id FROM public.object_cleanup_tasks')) return {rows: options.lost ? [] : [{id:'task'}]}
    if (sql.includes('.resumes WHERE') || sql.includes('.interview_audio_recordings')) return {rows: options.references ? [{id:'retained'}] : []}
    return {rows: []}
  }, release() {} }
  const pool = {async connect() { return client }, async query(sql: string, values: unknown[] = []) {
    calls.push({sql, values})
    return {rows: sql.includes('SKIP LOCKED') && !options.empty ? [{id:'task', organization_id:id, storage_key:'resume-key', schema_name:options.schema ?? 'company_' + id.replaceAll('-',''), storage_kind:options.audio ? 'interview':'resume', storage_location_id: options.location === undefined ? 'location' : options.location, attempts:options.attempts ?? 1}] : []}
  }} as unknown as Pool
  const storage = {locationId:'location',async delete(key: string) { assert.equal(calls.at(-1)?.sql,'COMMIT'); deleted.push(key); if (options.fail) throw new Error('storage unavailable') }} as unknown as ObjectStorage
  const audioStorage = {locationId:'location',async delete(key: string) { assert.equal(calls.at(-1)?.sql,'COMMIT'); audioDeleted.push(key) }} as unknown as ObjectStorage
  return {service:new ObjectCleanupService(pool,storage,audioStorage),calls,deleted,audioDeleted}
}
test('清理在短事务内复核租约，释放事务后删除并提交完成状态', async () => {
  const f=fixture(); assert.equal(await f.service.processPending(),true)
  assert.deepEqual(f.deleted,['resume-key']); assert.match(f.calls[1]!.sql,/SKIP LOCKED/)
  assert.ok(f.calls.some(c=>c.sql.includes('lease_token=$2') && c.sql.includes('FOR UPDATE')))
  assert.match(f.calls.at(-2)!.sql,/status='completed'/); assert.equal(f.calls.at(-1)!.sql,'COMMIT')
})
test('共享引用、非法公司路径和失效租约均不得删除文件', async () => {
  for (const options of [{references:true},{schema:'company_bad; DROP TABLE users'},{lost:true}]) {
    const f=fixture(options); await f.service.processPending(); assert.deepEqual(f.deleted,[])
    if ('schema' in options) assert.ok(f.calls.some(c=>c.sql.includes('attempts>=12')))
  }
})
test('音频任务不能误用简历存储', async () => {
  const f=fixture({audio:true}); await f.service.processPending()
  assert.deepEqual(f.deleted,[]); assert.deepEqual(f.audioDeleted,['resume-key'])
})
test('存储配置切换和未知历史位置必须停止清理，不能误删同名对象', async () => {
  for (const location of [null, 'different-location']) {
    const f=fixture({location}); await f.service.processPending()
    assert.deepEqual(f.deleted,[]); assert.deepEqual(f.audioDeleted,[])
    assert.ok(f.calls.some(call=>call.sql.includes("status='failed'") && call.sql.includes('原存储位置未知')))
  }
})
test('失败保留持久退避状态，空队列不申请连接', async () => {
  const f=fixture({fail:true,attempts:12}); await f.service.processPending()
  const retry=f.calls.find(c=>c.sql.includes('attempts>=12'))!
  assert.ok(retry); assert.ok(Number(retry.values[2])>=2880); assert.ok(Number(retry.values[2])<=4320)
  assert.equal(await fixture({empty:true}).service.processPending(),false)
  assert.equal(cleanupRetryDelaySeconds(1,()=>0),8)
  assert.equal(cleanupRetryDelaySeconds(20,()=>1),3600)
})
