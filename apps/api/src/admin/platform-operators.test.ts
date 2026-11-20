import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { PlatformOperatorsService, validateOperatorInput } from './platform-operators.js'
import { isSystemAdministrationPath } from '../auth/system-administrator.js'
import { isPlatformManagementPath } from '../platform/access.js'
import { isWorkspaceScopedPath } from '../auth/workspace-context.js'

const actor = '00000000-0000-4000-8000-000000000001'
const target = '00000000-0000-4000-8000-000000000002'
function fixture(options: { userNo?: string; active?: boolean; previous?: { role: string; is_active: boolean }; admins?: string[]; targetExists?: boolean; auditFails?: boolean } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT user_no')) return { rows: [{ user_no: options.userNo ?? 'USR-123456789A' }] }
    if (sql.startsWith('SELECT u.id FROM platform_operators')) return { rows: (options.admins ?? [actor]).map(id => ({ id })) }
    if (sql.startsWith('SELECT id,is_active')) return { rows: options.targetExists === false ? [] : [{ id: target, is_active: options.active ?? true }] }
    if (sql.startsWith('SELECT role,is_active')) return { rows: options.previous ? [options.previous] : [] }
    if (sql.includes('INSERT INTO platform_audit_logs') && options.auditFails) throw new Error('audit unavailable')
    return { rows: [] }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool
  return { service: new PlatformOperatorsService(pool, { SYSTEM_ADMIN_USER_NO: 'USR-123456789A' }), calls }
}

test('operator endpoints are system-only, tenant-free, and outside platform grants', () => {
  for (const path of ['/api/v1/admin/platform-operators', `/api/v1/admin/platform-operators/${target}`]) {
    assert.equal(isSystemAdministrationPath(path), true)
    assert.equal(isPlatformManagementPath(path), false)
    assert.equal(isWorkspaceScopedPath(path), false)
  }
})
test('operator input rejects missing snapshots, system roles, forged binding and blank reasons', () => {
  for (const input of [{ role: 'admin', reason: 'reason' }, { role: 'system_admin', expectedRole: null, reason: 'reason' }, { role: 'admin', expectedRole: null, reason: ' ' }, { role: 'admin', expectedRole: null, reason: 'reason', isSystemAdmin: true }]) {
    assert.throws(() => validateOperatorInput(input), { code: 'VALIDATION_ERROR' })
  }
  assert.deepEqual(validateOperatorInput({ role: null, expectedRole: 'admin', reason: ' revoke ' }), { role: null, expectedRole: 'admin', reason: 'revoke' })
})
test('live system binding is required for list and mutation, independent of platform grants', async () => {
  const { service, calls } = fixture({ userNo: 'USR-AAAAAAAAAA' })
  await assert.rejects(service.list(actor, new URLSearchParams()), { code: 'SYSTEM_ADMIN_REQUIRED' })
  await assert.rejects(service.update(actor, target, { role: 'admin', expectedRole: null, reason: '授权运营' }), { code: 'SYSTEM_ADMIN_REQUIRED' })
  assert.equal(calls.some(call => call.sql.startsWith('INSERT')), false)
})
test('all historical delegation mutations are permanently disabled without database writes', async () => {
  for (const role of ['admin', 'viewer', null]) {
    const { service, calls } = fixture()
    await assert.rejects(service.update(actor, target, { role, expectedRole: null, reason: '调整职责' }, 'request-id'), { status: 410, code: 'PLATFORM_DELEGATION_DISABLED' })
    assert.equal(calls.length, 1)
    assert.equal(calls.some(call => /INSERT|UPDATE|DELETE|BEGIN/.test(call.sql)), false)
  }
})
test('the bound administrator can inspect historical grants without modifying them', async () => {
  const { service, calls } = fixture()
  const result = await service.list(actor, new URLSearchParams())
  assert.equal(result.total, 0)
  assert.deepEqual(result.items, [])
  assert.equal(calls.some(call => /INSERT|UPDATE|DELETE/.test(call.sql)), false)
})
