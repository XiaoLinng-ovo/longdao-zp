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
  role?: 'admin' | 'viewer'
  target?: Record<string, unknown> | null
  sourceAvailable?: boolean
  protectedAccount?: boolean
} = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values })
      if (sql.includes('AND user_no=$2')) return { rows: options.protectedAccount ? [{ id: targetUserId }] : [] }
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
    if (options.role === 'viewer' && write) {
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

test('platform support cannot take over or disable the deployment-bound system account', async () => {
  const previous = process.env.SYSTEM_ADMIN_USER_NO
  process.env.SYSTEM_ADMIN_USER_NO = 'USR-123456789A'
  try {
    const { service, calls } = serviceFixture({ protectedAccount: true })
    for (const action of [
      () => service.updateStatus(actorId, targetUserId, { isActive: false, reason: '测试保护' }),
      () => service.profile(actorId, targetUserId, { displayName: 'changed', reason: '测试保护' }),
      () => service.revokeSessions(actorId, targetUserId, { reason: '测试保护' }),
      () => service.resetPassword(actorId, targetUserId, { reason: '测试保护' }),
    ]) await assert.rejects(action(), { status: 403, code: 'SYSTEM_ADMIN_ACCOUNT_PROTECTED' })
    assert.equal(calls.filter(call => call.sql === 'ROLLBACK').length, 4)
    assert.equal(calls.some(call => /^(UPDATE|INSERT|DELETE)/.test(call.sql)), false)
  } finally {
    if (previous === undefined) delete process.env.SYSTEM_ADMIN_USER_NO
    else process.env.SYSTEM_ADMIN_USER_NO = previous
  }
})

test('platform admins can filter the user directory by the existing operator roles', async () => {
  async function listAs(role: 'admin' | 'viewer') {
    const calls: Array<{ sql: string; values: unknown[] }> = []
    const pool = {
      async query(sql: string, values: unknown[] = []) {
        calls.push({ sql, values })
        if (sql.startsWith('SELECT count(*)')) return { rows: [{ total: 0 }] }
        if (sql.includes('FROM users u')) return { rows: [] }
        throw new Error(`Unexpected query: ${sql}`)
      },
    } as unknown as Pool
    const service = new PlatformUsersService(pool)
    Object.defineProperty(service, 'access', { value: { requireAccess: async () => role } })
    await service.list(actorId, new URLSearchParams('platformRole=admin'))
    return calls
  }

  const adminCalls = await listAs('admin')
  assert.equal(adminCalls.length, 2)
  assert.match(adminCalls[0]!.sql, /AND \(\$5::text IS NULL OR \(\$5='none' AND p\.role IS NULL\) OR p\.role=\$4::text\)/)
  assert.equal(adminCalls[0]!.values[4], 'admin')
  assert.equal(adminCalls[1]!.values[4], 'admin')
  assert.match(adminCalls[1]!.sql, /LIMIT \$6 OFFSET \$7/)
  assert.equal((await listAs('viewer')).length, 2)
})

test('platform admins can read platform operator accounts by id', async () => {
  async function readAs(role: 'admin' | 'viewer') {
    const calls: string[] = []
    const pool = {
      async query(sql: string) {
        calls.push(sql)
        if (sql.includes('SELECT u.*,p.role AS platform_role FROM users u')) return { rows: [{
          id: targetUserId,
          display_name: '平台管理员',
          email: 'platform-owner@example.test',
          phone: null,
          is_active: true,
          platform_role: 'admin',
          registration_source: 'legacy',
          created_at: '2026-01-01T00:00:00.000Z',
          last_login_at: null,
        }] }
        return { rows: [] }
      },
    } as unknown as Pool
    const service = new PlatformUsersService(pool)
    Object.defineProperty(service, 'access', { value: { requireAccess: async () => role } })
    return { service, calls }
  }

  const admin = await readAs('admin')
  const detail = await admin.service.detail(actorId, targetUserId)
  assert.equal(detail.user.platformRole, 'admin')
  assert.equal(admin.calls.length, 5)
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

test('platform admins retain platform write access', async () => {
  const { service, calls } = serviceFixture({ role: 'admin' })
  await service.updateWorkspaceAiAccess(actorId, targetUserId, targetOrganizationId, {
    usePlatformAi: false,
    reason: '验证平台管理员写权限',
  })
  assert.equal(calls.some(call => call.sql.startsWith('UPDATE organizations')), true)
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true)
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

test('platform admins can reset the selected trial enterprise AI generation quota and retain an audit trail', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values })
      if (sql.includes('SELECT u.id AS user_id')) return { rows: [{
        user_id: targetUserId,
        organization_id: targetOrganizationId,
        organization_name: '龙道科技',
        service_status: 'trial',
        generations: 3,
      }] }
      if (sql.startsWith('UPDATE organization_trial_ai_usage')) return { rows: [{ generations: 0 }] }
      return { rows: [] }
    },
    release() {},
  }
  const pool = { connect: async () => client } as unknown as Pool
  const service = new PlatformUsersService(pool)
  Object.defineProperty(service, 'access', { value: { requireAccess: async () => 'admin' } })

  const result = await service.resetAiGenerationQuota(actorId, targetUserId, targetOrganizationId, { reason: '修复误扣额度' }, 'request-quota-1')

  assert.deepEqual(result, { organizationId: targetOrganizationId, organizationName: '龙道科技', previousGenerations: 3, generations: 0 })
  const reset = calls.find(call => call.sql.startsWith('UPDATE organization_trial_ai_usage'))
  assert.deepEqual(reset?.values, [targetOrganizationId])
  const audit = calls.find(call => call.sql.includes('platform.user.ai_generation_quota_reset'))
  assert.deepEqual(audit?.values.slice(0, 3), [actorId, targetOrganizationId, 'request-quota-1'])
  assert.deepEqual(JSON.parse(String(audit?.values[3])), {
    targetUserId,
    organizationId: targetOrganizationId,
    organizationName: '龙道科技',
    reason: '修复误扣额度',
    before: { generations: 3 },
    after: { generations: 0 },
  })
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true)
})

test('AI generation quota reset rejects non-trial enterprises', async () => {
  const calls: string[] = []
  const client = {
    async query(sql: string) {
      calls.push(sql)
      if (sql.includes('SELECT u.id AS user_id')) return { rows: [{
        user_id: targetUserId,
        organization_id: targetOrganizationId,
        organization_name: '正式企业',
        service_status: 'enabled',
        generations: 3,
      }] }
      return { rows: [] }
    },
    release() {},
  }
  const pool = { connect: async () => client } as unknown as Pool
  const service = new PlatformUsersService(pool)
  Object.defineProperty(service, 'access', { value: { requireAccess: async () => 'admin' } })

  await assert.rejects(
    service.resetAiGenerationQuota(actorId, targetUserId, targetOrganizationId, { reason: '不应重置正式企业额度' }),
    { code: 'AI_QUOTA_RESET_NOT_APPLICABLE', status: 409 },
  )
  assert.equal(calls.some(sql => sql.startsWith('UPDATE organization_trial_ai_usage')), false)
  assert.equal(calls.includes('ROLLBACK'), true)
})
