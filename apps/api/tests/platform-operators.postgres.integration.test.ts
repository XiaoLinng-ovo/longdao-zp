import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { PlatformOperatorsService } from '../src/admin/platform-operators.js'
import { PlatformService } from '../src/platform/service.js'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'

test('system-only operator delegation uses real PostgreSQL and rolls every fixture back', async t => {
  if (shouldSkipPostgresIntegration()) { t.skip('PostgreSQL is not configured'); return }
  const pool = createPostgresHealthPool(), db = await pool.connect()
  const query = (sql: string, values: unknown[] = []) => db.query(sql === 'BEGIN' ? 'SAVEPOINT operator_test' : sql === 'COMMIT' ? 'RELEASE SAVEPOINT operator_test' : sql === 'ROLLBACK' ? 'ROLLBACK TO SAVEPOINT operator_test' : sql, values)
  const adapter = { query, async connect() { return { query, release() {} } } } as unknown as Pool
  const system = randomUUID(), target = randomUUID(), other = randomUUID()
  await db.query('BEGIN')
  try {
    for (const id of [system, target, other]) await db.query("INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'Operator delegation fixture',true)", [id, `${id}@example.invalid`])
    const userNo = (await db.query('SELECT user_no FROM users WHERE id=$1', [system])).rows[0].user_no
    const service = new PlatformOperatorsService(adapter, { SYSTEM_ADMIN_USER_NO: userNo })
    const access = new PlatformService(adapter)
    await t.test('system-only directory is available without enterprise membership or platform grants', async () => {
      const directory = await service.list(system, new URLSearchParams({ q: `${target}@example.invalid` }))
      assert.equal(directory.total, 1)
      assert.equal(directory.items[0]!.platformRole, null)
      await assert.rejects(access.requireAccess(system), { status: 403 })
    })
    await service.update(system, target, { role: 'admin', expectedRole: null, reason: '授权管理运营' }, 'operator-integration')
    assert.equal(await access.requireAccess(target, true), 'admin')
    await t.test('platform administrators cannot delegate and stale edits reject', async () => {
      await assert.rejects(service.update(target, other, { role: 'admin', expectedRole: null, reason: '禁止自行授权' }), { code: 'SYSTEM_ADMIN_REQUIRED' })
      await assert.rejects(service.list(target, new URLSearchParams()), { code: 'SYSTEM_ADMIN_REQUIRED' })
      await assert.rejects(service.update(system, target, { role: 'viewer', expectedRole: null, reason: '旧页面版本' }), { code: 'VERSION_CONFLICT' })
    })
    await service.update(system, other, { role: 'admin', expectedRole: null, reason: '保留运营管理' })
    await service.update(system, target, { role: 'viewer', expectedRole: 'admin', reason: '调整为只读运营' })
    assert.equal(await access.requireAccess(target), 'viewer')
    await assert.rejects(access.requireAccess(target, true), { status: 403 })
    await assert.rejects(service.update(target, other, { role: null, expectedRole: 'admin', reason: '只读不能授权' }), { code: 'SYSTEM_ADMIN_REQUIRED' })
    await service.update(system, target, { role: null, expectedRole: 'viewer', reason: '撤销运营权限' })
    await assert.rejects(access.requireAccess(target), { status: 403 })
    const audit = (await db.query("SELECT metadata FROM platform_audit_logs WHERE action='platform.operator.provision' AND metadata->>'targetUserId'=$1", [target])).rows
    assert.equal(audit.length, 3)
    assert.ok(audit.some(row => row.metadata.before?.role === 'admin' && row.metadata.after.role === 'viewer'))
    assert.ok(audit.some(row => row.metadata.after.role === null && row.metadata.after.isActive === false))
    assert.equal((await db.query('SELECT count(*)::int AS n FROM organization_members WHERE user_id=ANY($1::uuid[])', [[system, target, other]])).rows[0].n, 0)
    assert.equal((await db.query('SELECT password_hash FROM users WHERE id=$1', [target])).rows[0].password_hash, null)
    await t.test('disabled or unbound system accounts cannot delegate', async () => {
      await db.query('UPDATE users SET is_active=false WHERE id=$1', [system])
      await assert.rejects(service.update(system, target, { role: 'viewer', expectedRole: null, reason: '停用账号测试' }), { code: 'SYSTEM_ADMIN_REQUIRED' })
      await db.query('UPDATE users SET is_active=true WHERE id=$1', [system])
      await assert.rejects(new PlatformOperatorsService(adapter, {}).list(system, new URLSearchParams()), { code: 'SYSTEM_ADMIN_REQUIRED' })
    })
    await t.test('last active platform administrator cannot be downgraded or revoked', async () => {
      // The outer transaction rolls back this temporary change to existing grants.
      await db.query('UPDATE platform_operators SET is_active=false WHERE user_id<>$1', [other])
      for (const role of ['viewer', null]) await assert.rejects(service.update(system, other, { role, expectedRole: 'admin', reason: '最后管理员保护' }), { code: 'LAST_PLATFORM_ADMIN_REQUIRED' })
    })
  } finally { await db.query('ROLLBACK'); db.release(); await pool.end() }
})
