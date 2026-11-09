import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthService, type AuthSessionStore } from '../auth/auth-service.js'
import type { AuthContext, SessionUser } from '../auth/types.js'
import type { RequestContext } from '../http.js'
import { isSystemAdministrator, isSystemAdministrationPath } from '../auth/system-administrator.js'
import { createWorkspaceContextMiddleware, isWorkspaceScopedPath } from '../auth/workspace-context.js'
import { createPlatformAccessMiddleware, isPlatformManagementPath } from '../platform/access.js'
import { currentTenantContext } from '../db/tenant-context.js'
import { createSystemAdministrationAccessMiddleware } from './access.js'

const account = 'USR-123456789A'
const env = { SYSTEM_ADMIN_USER_NO: account }
const user: SessionUser = { id: 'bound-user', userNo: account, name: 'Admin', email: 'owner@example.invalid', role: 'recruiter', departmentId: '' }

function fixture(initial: SessionUser | undefined = user) {
  let current: SessionUser | undefined = initial
  let lookups = 0
  const service = new AuthService({ async findUserById() { lookups++; return current } } as unknown as AuthSessionStore, { env })
  return { service, middleware: createSystemAdministrationAccessMiddleware(service, {}), change(value: SessionUser | undefined) { current = value }, lookups: () => lookups }
}

function context(path = '/api/v1/admin/settings', method = 'GET', authenticated = true): RequestContext {
  return {
    url: new URL(path, 'http://localhost'),
    req: { method, headers: {} }, res: { setHeader() {} },
    auth: authenticated ? { method: 'session', sessionId: 's', user: { ...user } } : undefined,
  } as unknown as RequestContext
}

test('only one explicitly bound immutable account code is administrator; missing or malformed config denies all', () => {
  assert.equal(isSystemAdministrator(user, env), true)
  for (const value of [undefined, '', '*', `${account},USR-AAAAAAAAAA`, 'admin@smartrecruit.local']) {
    assert.equal(isSystemAdministrator(user, { SYSTEM_ADMIN_USER_NO: value }), false)
  }
  assert.equal(isSystemAdministrator({ ...user, userNo: 'USR-AAAAAAAAAA', role: 'admin', platformRole: 'admin', isSystemAdmin: true }, env), false)
})

test('all restored global configuration paths are outside enterprise schemas and platform grants', async () => {
  for (const name of ['users', 'users/id', 'account-organizations', 'departments', 'departments/id', 'roles', 'roles/id', 'settings', 'ai-settings', 'ai-connection-test', 'smtp-settings', 'smtp-connection-test', 'smtp-test-email', 'dingtalk-settings', 'dingtalk-connection-test', 'resume-virus-scan', 'channel-settings', 'channel-connections/provider/test', 'audit-logs']) {
    const path = `/api/v1/admin/${name}`
    assert.equal(isSystemAdministrationPath(path), true, path)
    assert.equal(isWorkspaceScopedPath(path), false, path)
    assert.equal(isPlatformManagementPath(path), false, path)
    const ctx = context(path)
    ctx.auth!.user.workspaceId = 'irrelevant-enterprise'
    await createWorkspaceContextMiddleware(true, { async query() { throw new Error('must not select tenant schema') } }, true)(ctx, async () => {
      assert.equal(currentTenantContext(), undefined)
      await fixture().middleware(ctx, async () => {})
    })
  }
  for (const path of ['/api/v1/platform/users', '/api/v1/admin/settings-other', '/api/v1/admin/unknown']) {
    assert.equal(isSystemAdministrationPath(path), false, path)
    assert.equal(isPlatformManagementPath(path), true, path)
  }
  assert.equal(isWorkspaceScopedPath('/api/v1/admin/ai-skills'), true)
})

test('unauthenticated and bootstrap requests cannot reach configuration', async () => {
  const f = fixture()
  await assert.rejects(async () => f.middleware(context(undefined, undefined, false), async () => { assert.fail('must not continue') }), { status: 401 })
  const ctx = context()
  ctx.auth!.method = 'development-bootstrap'
  await assert.rejects(async () => f.middleware(ctx, async () => { assert.fail('must not continue') }), { status: 401 })
  assert.equal(f.lookups(), 0)
})

test('ordinary enterprise members retain department CRUD without system or platform privileges', async () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111'
  const f = fixture(undefined)
  const platform = createPlatformAccessMiddleware({ async requireAccess() { assert.fail('enterprise departments must not require a platform grant') } })
  for (const [path, method] of [
    ['/api/v1/departments', 'GET'], ['/api/v1/departments', 'POST'],
    ['/api/v1/departments/department-id', 'PATCH'], ['/api/v1/departments/department-id', 'DELETE'],
  ]) {
    const ctx = context(path, method)
    ctx.auth!.user = { ...user, userNo: 'USR-AAAAAAAAAA', workspaceId, isSystemAdmin: false }
    ctx.req.headers['x-workspace-id'] = workspaceId
    assert.equal(isWorkspaceScopedPath(path!), true)
    let reached = false
    await createWorkspaceContextMiddleware(true)(ctx, async () => {
      await f.middleware(ctx, async () => {
        await platform(ctx, async () => { reached = true })
      })
    })
    assert.equal(reached, true, `${method} ${path}`)
    ctx.req.headers['x-workspace-id'] = 'another-enterprise'
    await assert.rejects(
      async () => createWorkspaceContextMiddleware(true)(ctx, async () => { assert.fail('must not cross enterprises') }),
      { status: 409, code: 'WORKSPACE_CONTEXT_CHANGED' },
    )
  }
  assert.equal(f.lookups(), 0)
})

test('ordinary users, legacy admins and platform grants cannot substitute for the bound account', async () => {
  for (const role of ['recruiter', 'admin', 'hr_admin'] as const) {
    const ordinary = { ...user, id: 'other', userNo: 'USR-AAAAAAAAAA', role, platformRole: 'admin' as const, isSystemAdmin: true }
    const ctx = context()
    ctx.auth!.user = ordinary
    await assert.rejects(async () => fixture(ordinary).middleware(ctx, async () => { assert.fail('must not continue') }), { status: 403, code: 'SYSTEM_ADMIN_REQUIRED' })
    assert.equal(ctx.auth!.user.isSystemAdmin, false)
  }
})

test('live account authorization runs before every replay and rejects removed accounts or revoked binding', async () => {
  const f = fixture()
  const ctx = context()
  let replays = 0
  await f.middleware(ctx, async () => { replays++ })
  assert.equal(ctx.auth!.user.isSystemAdmin, true)
  f.change({ ...user, userNo: 'USR-AAAAAAAAAA' })
  await assert.rejects(async () => f.middleware(ctx, async () => { replays++ }), { code: 'SYSTEM_ADMIN_REQUIRED' })
  f.change(undefined)
  await assert.rejects(async () => f.middleware(ctx, async () => { replays++ }), { code: 'SYSTEM_ADMIN_REQUIRED' })
  assert.equal(replays, 1)
  assert.equal(f.lookups(), 3)
})

test('mutations always require trusted Origin and matching CSRF before replay, including when legacy CSRF is disabled', async () => {
  const f = fixture()
  const middleware = createSystemAdministrationAccessMiddleware(f.service, { REQUIRE_CSRF: 'false' })
  for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
    const ctx = context('/api/v1/admin/settings', method)
    let writes = 0
    const next = async () => { writes++ }
    await assert.rejects(async () => middleware(ctx, next), { code: 'CSRF_ORIGIN_MISMATCH' })
    ctx.req.headers.origin = 'https://attacker.invalid'
    await assert.rejects(async () => middleware(ctx, next), { code: 'CSRF_ORIGIN_MISMATCH' })
    ctx.req.headers.origin = 'http://127.0.0.1:5174'
    await assert.rejects(async () => middleware(ctx, next), { code: 'CSRF_TOKEN_INVALID' })
    ctx.req.headers.cookie = 'smartrecruit_csrf=test-token'
    ctx.req.headers['x-csrf-token'] = 'test-token'
    await middleware(ctx, next)
    assert.equal(writes, 1)
  }
})

test('session responses recompute system admin status rather than trusting stored flags, including enterprise switches', async () => {
  let current = { ...user, isSystemAdmin: true }
  const store = {
    async findSessionByToken() { return { user: current, sessionId: 's' } },
    async selectWorkspace() { return { ...current, workspaceId: 'w' } },
  } as unknown as AuthSessionStore
  const service = new AuthService(store, { env })
  assert.equal((await service.authenticateToken('token'))?.user.isSystemAdmin, true)
  assert.equal((await service.selectWorkspace('s', user.id, 'w')).isSystemAdmin, true)
  current = { ...current, userNo: 'USR-AAAAAAAAAA' }
  assert.equal((await service.authenticateToken('token'))?.user.isSystemAdmin, undefined)
  assert.equal((await service.selectWorkspace('s', user.id, 'w')).isSystemAdmin, undefined)
  const auth = { method: 'session', user: { ...user, isSystemAdmin: true } } as AuthContext
  await assert.rejects(async () => new AuthService({ async findUserById() { return user } } as unknown as AuthSessionStore, { env: {} }).authorizeSystemAdministrator(auth), { code: 'SYSTEM_ADMIN_REQUIRED' })
})
