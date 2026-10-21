import { assertPlatformWriteSecurity } from './access.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import type { RequestContext } from '../http.js'
import { PlatformService, validateLifecyclePatch } from './service.js'
import { createPlatformAccessMiddleware, isPlatformManagementPath } from './access.js'
const input = { serviceStatus: 'enabled', reason: '客户确认开通', expectedVersion: 1 }
test('platform lifecycle validates reason, optimistic version and future zoned deadline', () => {
  assert.deepEqual(validateLifecyclePatch(input), { status: 'enabled', deadline: null, reason: '客户确认开通', version: 1 })
  for (const patch of [{...input, reason: ' '}, {...input, expectedVersion: 0}, {...input, owner: 'attacker'}, {...input, serviceStatus: 'archived'}, {...input, trialEndsAt: new Date().toISOString()}, {...input,serviceStatus:'trial',trialEndsAt:'2020-01-01T00:00:00Z'}, {...input,serviceStatus:'trial',trialEndsAt:'2099-01-01T00:00:00'}]) assert.throws(()=>validateLifecyclePatch(patch), { code:'VALIDATION_ERROR' })
  assert.equal(validateLifecyclePatch({...input,serviceStatus:'trial',trialEndsAt:'2099-01-01T08:00:00+08:00'}).deadline,'2099-01-01T00:00:00.000Z')
})
test('explicit platform domain separates tenant AI and tasks from global settings', () => {
  for (const path of ['/api/v1/platform/customers','/api/v1/platform/audit-logs','/api/v1/admin/users','/api/v1/admin/settings','/api/v1/admin/security','/api/v1/admin/unknown']) assert.equal(isPlatformManagementPath(path),true,path)
  for (const path of ['/api/v1/jobs','/api/v1/admin/ai-settings','/api/v1/admin/ai-connection-test','/api/v1/admin/ai-skills/a','/api/v1/admin/analysis-tasks','/api/v1/admin/recruitment-approval-settings']) assert.equal(isPlatformManagementPath(path),false,path)
})
test('non-database demo user is denied without a database query', async () => {
  const service = new PlatformService({query(){throw new Error('must not query')}} as unknown as Pool)
  await assert.rejects(service.requireAccess('user-admin'),{status:403,code:'PLATFORM_PERMISSION_REQUIRED'})
})
test('platform checks current grant on every request, before downstream cached replay', async () => {
  let role: 'admin'|'viewer'|undefined='admin', downstream=0, checks=0
  const middleware = createPlatformAccessMiddleware({async requireAccess(_id,write){checks++;if(!role || (write && role!=='admin')) throw Object.assign(new Error('denied'),{status:403});return role}})
  const context = {url:new URL('http://test/api/v1/platform/customers'),req:{method:'GET'},res:{setHeader(){}},auth:{method:'session',user:{id:'user',role:'admin',platformRole:'admin'}}} as unknown as RequestContext
  await middleware(context,async()=>{downstream++});role=undefined
  await assert.rejects(async()=>{await middleware(context,async()=>{downstream++})},{status:403});assert.equal(downstream,1);assert.equal(checks,2)
  role='viewer';context.req.method='PATCH';await assert.rejects(async()=>{await middleware(context,async()=>{downstream++})},{status:403})
  context.auth!.method='development-bootstrap';await assert.rejects(async()=>{await middleware(context,async()=>{downstream++})},{status:401});assert.equal(checks,3)
})

test('platform writes deny untrusted/missing origins, require CSRF and fail closed without production allowlist', () => {
  const ctx = (origin: string | undefined, token = 'same-token') => ({req:{headers:{origin,'x-csrf-token':token,cookie:'smartrecruit_csrf=same-token; __Host-smartrecruit_csrf=same-token'}}}) as unknown as RequestContext
  assert.doesNotThrow(() => assertPlatformWriteSecurity(ctx('http://127.0.0.1:5174'), {}))
  assert.doesNotThrow(() => assertPlatformWriteSecurity(ctx('http://localhost:61942'), {NODE_ENV:'development',ALLOWED_ORIGINS:'http://127.0.0.1:5174'}))
  assert.doesNotThrow(() => assertPlatformWriteSecurity(ctx('https://new-random-address.trycloudflare.com'), {NODE_ENV:'development',ALLOWED_ORIGINS:'https://old-random-address.trycloudflare.com'}))
  assert.throws(() => assertPlatformWriteSecurity(ctx('http://evil.example.invalid'), {}), {code:'CSRF_ORIGIN_MISMATCH'})
  assert.throws(() => assertPlatformWriteSecurity(ctx(undefined), {}), {code:'CSRF_ORIGIN_MISMATCH'})
  assert.throws(() => assertPlatformWriteSecurity(ctx('http://127.0.0.1:5174', ''), {REQUIRE_CSRF:'false'}), {code:'CSRF_TOKEN_INVALID'})
  assert.throws(() => assertPlatformWriteSecurity(ctx('http://127.0.0.1:5174'), {NODE_ENV:'production'}), {code:'PLATFORM_ORIGINS_REQUIRED'})
  assert.doesNotThrow(() => assertPlatformWriteSecurity(ctx('https://recruit.example.invalid'), {NODE_ENV:'production',ALLOWED_ORIGINS:'https://recruit.example.invalid'}))
  assert.throws(() => assertPlatformWriteSecurity(ctx('https://new-random-address.trycloudflare.com'), {NODE_ENV:'production',ALLOWED_ORIGINS:'https://old-random-address.trycloudflare.com'}), {code:'CSRF_ORIGIN_MISMATCH'})
})

test('platform write security runs before downstream idempotent replay', async () => {
  let downstream = 0
  const middleware = createPlatformAccessMiddleware({async requireAccess(){return 'admin' as const}})
  const context = {url:new URL('http://test/api/v1/platform/customers/test/lifecycle'),req:{method:'PATCH',headers:{}},res:{setHeader(){}},auth:{method:'session',user:{id:'u',role:'admin'}}} as unknown as RequestContext
  await assert.rejects(async () => { await middleware(context,async()=>{downstream++}) }, {code:'CSRF_ORIGIN_MISMATCH'})
  assert.equal(downstream,0)
})
