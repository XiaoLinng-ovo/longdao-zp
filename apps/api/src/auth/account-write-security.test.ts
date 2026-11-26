import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RequestContext } from '../http.js'
import { createAccountWriteSecurityMiddleware } from './account-write-security.js'

const paths = ['/workspaces', '/workspaces/id/select', '/workspaces/id/reset', '/workspaces/id/archive',
  '/workspaces/id/invitations', '/workspaces/id/members/id', '/workspace-invitations/accept',
  '/workspace-invitations/preview', '/me', '/auth/logout', '/auth/mfa/setup/start',
  '/auth/account/email/code', '/auth/account/email', '/auth/account/password',
  '/auth/account/password/code', '/auth/account/password/verify']
const env = { NODE_ENV: 'production', REQUIRE_CSRF: 'true', ALLOWED_ORIGINS: 'https://recruit.example.invalid' }

function context(path: string, method = 'POST', headers: Record<string, string> = {}): RequestContext {
  return { url: new URL('/api/v1' + path, 'https://api.example.invalid'), req: { method, headers } } as RequestContext
}

test('account and workspace mutations reject missing tokens and untrusted origins before downstream effects', async () => {
  const middleware = createAccountWriteSecurityMiddleware(env)
  for (const path of paths) {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const ctx = context(path, method)
      const next = async () => assert.fail('forged write reached downstream')
      await assert.rejects(async () => middleware(ctx, next), { code: 'CSRF_ORIGIN_MISMATCH' })
      ctx.req.headers.origin = 'https://attacker.invalid'
      await assert.rejects(async () => middleware(ctx, next), { code: 'CSRF_ORIGIN_MISMATCH' })
      ctx.req.headers.origin = env.ALLOWED_ORIGINS
      await assert.rejects(async () => middleware(ctx, next), { code: 'CSRF_TOKEN_INVALID' })
      ctx.req.headers.cookie = '__Host-smartrecruit_csrf=right'
      ctx.req.headers['x-csrf-token'] = 'wrong'
      await assert.rejects(async () => middleware(ctx, next), { code: 'CSRF_TOKEN_INVALID' })
      ctx.req.headers.cookie = 'smartrecruit_csrf=right'
      ctx.req.headers['x-csrf-token'] = 'right'
      await assert.rejects(async () => middleware(ctx, next), { code: 'CSRF_TOKEN_INVALID' })
      ctx.req.headers.cookie = '__Host-smartrecruit_csrf=right'
      let reached = 0
      await middleware(ctx, async () => { reached++ })
      assert.equal(reached, 1)
    }
  }
})

test('read paths and public challenge-based authentication are not blocked by account CSRF', async () => {
  const middleware = createAccountWriteSecurityMiddleware(env)
  const cases = paths.map(path => context(path, 'GET'))
  for (const path of ['/auth/login', '/auth/register', '/auth/password-reset/confirm', '/auth/mfa/verify', '/workspaces-other']) cases.push(context(path))
  for (const ctx of cases) {
    let reached = false
    await middleware(ctx, async () => { reached = true })
    assert.equal(reached, true)
  }
})

test('account writes preserve explicit legacy development settings without weakening strict mode', async () => {
  let reached = 0
  await createAccountWriteSecurityMiddleware({ NODE_ENV: 'test', REQUIRE_CSRF: 'false' })(context('/me', 'PATCH'), async () => { reached++ })
  const headers = { cookie: 'smartrecruit_csrf=token', 'x-csrf-token': 'token' }
  await createAccountWriteSecurityMiddleware({ NODE_ENV: 'test' })(context('/me', 'PATCH', headers), async () => { reached++ })
  assert.equal(reached, 2)
  await assert.rejects(async () => createAccountWriteSecurityMiddleware({ ...env, NODE_ENV: 'test' })(context('/me', 'PATCH', headers), async () => assert.fail()), { code: 'CSRF_ORIGIN_MISMATCH' })
})

test('all account and workspace mutations accept the current website without a whitelist, but still require CSRF', async () => {
  for (const allowed of ['', 'https://old-address.trycloudflare.com']) {
    const middleware = createAccountWriteSecurityMiddleware({ ...env, ALLOWED_ORIGINS: allowed })
    for (const path of paths) {
      const ctx = context(path, 'POST', { origin: 'https://new-address.trycloudflare.com',
        host: 'new-address.trycloudflare.com', 'x-forwarded-proto': 'https',
        cookie: '__Host-smartrecruit_csrf=token', 'x-csrf-token': 'token' })
      Object.assign(ctx.req, { socket: { remoteAddress: '127.0.0.1' } })
      let reached = false
      await middleware(ctx, async () => { reached = true })
      assert.equal(reached, true, path)
      ctx.req.headers['x-csrf-token'] = ''
      await assert.rejects(async () => middleware(ctx, async () => assert.fail()), { code: 'CSRF_TOKEN_INVALID' })
      ctx.req.headers.origin = 'https://attacker.invalid'
      await assert.rejects(async () => middleware(ctx, async () => assert.fail()), { code: 'CSRF_ORIGIN_MISMATCH' })
    }
  }
})
