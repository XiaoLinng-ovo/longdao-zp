import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, it } from 'node:test'

let server: ReturnType<typeof import('../src/server.js').createHttpServer>
let baseUrl: string
let directory: string
const cookies = new Map<string, string>()
const envKeys = ['NODE_ENV', 'AUTH_STORE_PATH', 'DATABASE_URL', 'PGPASSWORD', 'REQUIRE_CSRF', 'ALLOWED_ORIGINS'] as const
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))

before(async () => {
  process.env.NODE_ENV = 'test'
  process.env.REQUIRE_CSRF = 'true'
  delete process.env.ALLOWED_ORIGINS
  delete process.env.DATABASE_URL
  delete process.env.PGPASSWORD
  directory = await mkdtemp(join(tmpdir(), 'saved-accounts-'))
  process.env.AUTH_STORE_PATH = join(directory, 'auth.json')
  const { createHttpServer } = await import('../src/server.js')
  const { loadConfig } = await import('../src/config.js')
  server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
  if (directory) await rm(directory, { force: true, recursive: true })
})

async function call(path: string, body?: unknown, csrf = true) {
  const headers: Record<string, string> = { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (csrf && cookies.has('smartrecruit_csrf')) headers['x-csrf-token'] = decodeURIComponent(cookies.get('smartrecruit_csrf')!)
  const response = await fetch(`${baseUrl}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';')
    const split = pair!.indexOf('=')
    const name = pair!.slice(0, split)
    if (/Max-Age=0(?:;|$)/.test(cookie)) cookies.delete(name)
    else cookies.set(name, pair!.slice(split + 1))
  }
  return { response, payload: await response.json() as any }
}

it('saves real sessions, switches server-side identity, rejects unauthorized switches, and removes logged-out accounts', async () => {
  cookies.set('smartrecruit_accounts', '%ZZ')
  let result = await call('/auth/login', { email: 'admin@smartrecruit.local', password: 'admin123' })
  assert.equal(result.response.status, 200)
  const adminId = result.payload.data.user.id
  const adminToken = cookies.get('smartrecruit_session')
  assert.ok(result.response.headers.getSetCookie().some(cookie => cookie.startsWith('smartrecruit_accounts=') && cookie.includes('HttpOnly')))
  result = await call('/auth/login', { email: 'recruiter@smartrecruit.local', password: 'recruiter123' })
  assert.equal(result.response.status, 200)
  const recruiterId = result.payload.data.user.id
  const recruiterToken = cookies.get('smartrecruit_session')
  result = await call('/auth/accounts')
  assert.equal(result.response.status, 200)
  assert.equal(result.response.headers.get('cache-control'), 'no-store')
  assert.equal(result.payload.data.length, 2)
  assert.equal(result.payload.data.find((item: any) => item.user.id === recruiterId).current, true)
  assert.ok(!JSON.stringify(result.payload).includes(decodeURIComponent(adminToken!)))
  assert.ok(!JSON.stringify(result.payload).includes('tokenHash'))

  result = await call('/auth/accounts/switch', { userId: adminId }, false)
  assert.equal(result.response.status, 403)
  assert.equal(result.payload.error.code, 'CSRF_TOKEN_INVALID')
  assert.equal(cookies.get('smartrecruit_session'), recruiterToken)
  result = await call('/auth/accounts/switch', { userId: 'someone-else' })
  assert.equal(result.response.status, 401)
  assert.equal(cookies.get('smartrecruit_session'), recruiterToken)
  result = await call('/auth/accounts/switch', { userId: adminId })
  assert.equal(result.response.status, 200)
  assert.equal(result.payload.data.user.role, 'admin')
  assert.equal(cookies.get('smartrecruit_session'), adminToken)
  result = await call('/me')
  assert.equal(result.payload.data.user.id, adminId)

  // Failed account additions leave both the current identity and saved sessions intact.
  result = await call('/auth/login', { email: 'admin@smartrecruit.local', password: 'wrong' })
  assert.equal(result.response.status, 401)
  assert.equal(cookies.get('smartrecruit_session'), adminToken)
  result = await call('/auth/logout', {})
  assert.equal(result.response.status, 200)
  assert.ok(!cookies.has('smartrecruit_session'))
  await call('/auth/csrf')
  result = await call('/auth/accounts/switch', { userId: adminId })
  assert.equal(result.response.status, 401)
  result = await call('/auth/accounts/switch', { userId: recruiterId })
  assert.equal(result.response.status, 200)
  result = await call('/auth/accounts')
  assert.deepEqual(result.payload.data.map((item: any) => item.user.id), [recruiterId])
})
