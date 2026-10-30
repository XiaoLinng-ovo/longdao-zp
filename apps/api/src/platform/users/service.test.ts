import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { PlatformUsersService } from './service.js'
import { validateProfileInput, validateReasonInput, validateStatusInput, validateUserListQuery, validateWorkspaceAiAccessInput } from './validation.js'

const actorId = '00000000-0000-4000-8000-000000000001'
const targetUserId = '00000000-0000-4000-8000-000000000002'
const targetOrganizationId = '00000000-0000-4000-8000-000000000003'
const sourceOrganizationId = '00000000-0000-4000-8000-000000000004'

function serviceFixture(options: {
  role?: string
  target?: Record<string, unknown> | null
  sourceAvailable?: boolean
} = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values })
      if (sql.startsWith('SELECT p.role')) return { rows: [{ role: options.role ?? 'admin' }] }
      if (sql.includes('to_jsonb(o) AS settings')) return { rows: options.target === null ? [] : [{
        id: targetOrganizationId,
        settings: options.target ?? { use_platform_ai: false, platform_ai_source_organization_id: null },
      }] }
      if (sql.includes('FROM enterprise_ai_settings s')) return { rows: options.sourceAvailable === false ? [] : [{ organization_id: sourceOrganizationId }] }
      return { rows: [] }
    },
    release() {},
  }
  const pool = { connect: async () => client } as unknown as Pool
  const service = new PlatformUsersService(pool)
  Object.defineProperty(service, 'access', { value: { requireAccess: async (_id: string, write: boolean) => {
    if (write && options.role !== undefined && options.role !== 'admin') {
      const error = new Error('platform write denied') as Error & { status: number; code: string }
      error.status = 403
      error.code = 'PLATFORM_PERMISSION_REQUIRED'
      throw error
    }
    return options.role ?? 'admin'
  } } })
  service.detail = async () => ({ user: { id: targetUserId } } as any)
  return { service, calls }
}

test('platform user filters validate pagination, status and role', () => {
  assert.deepEqual(validateUserListQuery(new URLSearchParams('page=1&pageSize=20')), {
    page: 1,
    pageSize: 20,
    q: '',
    status: null,
    workspaceId: null,
    platformRole: null,
  })
  assert.throws(() => validateUserListQuery(new URLSearchParams('page=0')), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateUserListQuery(new URLSearchParams('status=deleted')), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateUserListQuery(new URLSearchParams('platformRole=owner')), { code: 'VALIDATION_ERROR' })
})

test('platform user mutations require a reason and supported fields', () => {
  assert.deepEqual(validateStatusInput({ isActive: false, reason: '安全处置' }), { isActive: false, reason: '安全处置' })
  assert.deepEqual(validateReasonInput({ reason: '用户申请退出' }), { reason: '用户申请退出' })
  assert.deepEqual(validateWorkspaceAiAccessInput({ usePlatformAi: false, reason: '停用共享模型' }), { usePlatformAi: false, reason: '停用共享模型' })
  assert.deepEqual(validateProfileInput({ displayName: '陈婉清', phone: '13800000000', reason: '纠正账号资料' }), {
    displayName: '陈婉清',
    phone: '+8613800000000',
    reason: '纠正账号资料',
  })
  assert.throws(() => validateStatusInput({ isActive: false, reason: ' ' }), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateWorkspaceAiAccessInput({ usePlatformAi: 'false', reason: '不合法' }), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateWorkspaceAiAccessInput({ usePlatformAi: true, sourceOrganizationId, reason: '不允许客户端指定来源' }), { code: 'VALIDATION_ERROR' })
  assert.throws(() => validateProfileInput({ displayName: '陈婉清', role: 'admin', reason: '越权修改' }), { code: 'VALIDATION_ERROR' })
})

test('enabling shared AI updates only the target enterprise and records a secret-free scoped audit', async () => {
  const { service, calls } = serviceFixture()
  await service.updateWorkspaceAiAccess(actorId, targetUserId, targetOrganizationId, {
    usePlatformAi: true,
    reason: '平台统一模型服务',
  }, 'request-1', sourceOrganizationId)

  const update = calls.find(call => call.sql.startsWith('UPDATE organizations'))
  assert.deepEqual(update?.values, [targetOrganizationId, true, sourceOrganizationId])
  const audit = calls.find(call => call.sql.includes('INSERT INTO platform_audit_logs'))
  assert.deepEqual(audit?.values.slice(0, 3), [actorId, targetOrganizationId, 'request-1'])
  assert.deepEqual(JSON.parse(String(audit?.values[3])), {
    targetUserId,
    organizationId: targetOrganizationId,
    reason: '平台统一模型服务',
    before: { usePlatformAi: false, sourceOrganizationId: null },
    after: { usePlatformAi: true, sourceOrganizationId },
  })
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true)
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), false)
})

test('disabling shared AI clears only the source pointer and does not require source configuration', async () => {
  const { service, calls } = serviceFixture({ target: { use_platform_ai: true, platform_ai_source_organization_id: sourceOrganizationId } })
  await service.updateWorkspaceAiAccess(actorId, targetUserId, targetOrganizationId, {
    usePlatformAi: false,
    reason: '恢复企业自有配置',
  })

  assert.deepEqual(calls.find(call => call.sql.startsWith('UPDATE organizations'))?.values, [targetOrganizationId, false, null])
  assert.equal(calls.some(call => call.sql.includes('FROM enterprise_ai_settings s')), false)
})

test('the switch refuses to write when its database migration is unavailable', async () => {
  const { service, calls } = serviceFixture({ target: {} })
  await assert.rejects(service.updateWorkspaceAiAccess(actorId, targetUserId, targetOrganizationId, {
    usePlatformAi: false,
    reason: '验证未升级保护',
  }), { code: 'AI_SHARING_MIGRATION_REQUIRED', status: 503 })
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE organizations')), false)
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true)
})

test('platform viewers cannot change enterprise AI access', async () => {
  const { service, calls } = serviceFixture({ role: 'viewer' })
  await assert.rejects(service.updateWorkspaceAiAccess(actorId, targetUserId, targetOrganizationId, {
    usePlatformAi: false,
    reason: '验证只读权限',
  }), { code: 'PLATFORM_PERMISSION_REQUIRED', status: 403 })
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE organizations')), false)
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true)
})

test('shared access requires an active, configured source managed by the acting account', async () => {
  const { service, calls } = serviceFixture({ sourceAvailable: false })
  await assert.rejects(service.updateWorkspaceAiAccess(actorId, targetUserId, targetOrganizationId, {
    usePlatformAi: true,
    reason: '验证来源企业校验',
  }, undefined, sourceOrganizationId), { code: 'AI_SHARE_SOURCE_UNAVAILABLE', status: 409 })
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE organizations')), false)
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true)
})

test('a workspace switch cannot target an enterprise the account does not belong to', async () => {
  const { service, calls } = serviceFixture({ target: null })
  await assert.rejects(service.updateWorkspaceAiAccess(actorId, targetUserId, targetOrganizationId, {
    usePlatformAi: false,
    reason: '验证企业成员关系',
  }), { code: 'NOT_FOUND', status: 404 })
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE organizations')), false)
})
