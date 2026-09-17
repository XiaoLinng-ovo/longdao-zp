import assert from 'node:assert/strict'
import { request } from 'node:http'
import { after, before, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

let server: ReturnType<typeof import('../src/server.js').createHttpServer>
let baseUrl = ''
let cookie = ''
let temporaryRoot = ''
const previousNodeEnv = process.env.NODE_ENV
const previousAuthPath = process.env.AUTH_STORE_PATH

function jsonRequest(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const req = request(url, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string | string[] | undefined>, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

async function login(email: string, password: string): Promise<void> {
  const response = await jsonRequest('POST', '/api/v1/auth/login', { email, password })
  assert.equal(response.status, 200)
  const setCookie = (response as any).headers?.['set-cookie']
  // The test server exposes cookies through a dedicated request helper below.
  assert.ok(response.body?.data?.user)
}

before(async () => {
  process.env.NODE_ENV = 'test'
  temporaryRoot = await mkdtemp(join(tmpdir(), 'smartrecruit-admin-api-'))
  process.env.AUTH_STORE_PATH = join(temporaryRoot, 'auth-sessions.json')
  const { createHttpServer } = await import('../src/server.js')
  server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv
  if (previousAuthPath === undefined) delete process.env.AUTH_STORE_PATH; else process.env.AUTH_STORE_PATH = previousAuthPath
  await rm(temporaryRoot, { recursive: true, force: true })
})

describe('admin API role matrix', { concurrency: false }, () => {
  it('allows admin and hr_admin to read all administration resources', async (context) => {
    if (!process.env.DATABASE_URL && !process.env.PGPASSWORD) { context.skip('requires PostgreSQL credentials for AdminService'); return }
    for (const credentials of [
      { email: 'admin@smartrecruit.local', password: 'admin123' },
      { email: 'hr@smartrecruit.local', password: 'hr123' },
    ]) {
      const loginResponse = await jsonRequest('POST', '/api/v1/auth/login', credentials)
      assert.equal(loginResponse.status, 200)
      cookie = (loginResponse.headers['set-cookie'] as string[] | undefined)?.map((item) => item.split(';', 1)[0]).join('; ') ?? ''
      const endpoints = ['/api/v1/admin/users', '/api/v1/admin/roles', '/api/v1/admin/settings', '/api/v1/admin/analysis-tasks', '/api/v1/admin/audit-logs']
      for (const endpoint of endpoints) {
        const response = await jsonRequest('GET', endpoint)
        assert.equal(response.status, 200, `${credentials.email} should read ${endpoint}`)
      }
    }
  })

  it('returns 403 for a recruiter on every administration resource', async () => {
    const loginResponse = await jsonRequest('POST', '/api/v1/auth/login', { email: 'recruiter@smartrecruit.local', password: 'recruiter123' })
    assert.equal(loginResponse.status, 200)
    cookie = (loginResponse.headers['set-cookie'] as string[] | undefined)?.map((item) => item.split(';', 1)[0]).join('; ') ?? ''
    for (const endpoint of ['/api/v1/admin/users', '/api/v1/admin/roles', '/api/v1/admin/settings', '/api/v1/admin/analysis-tasks', '/api/v1/admin/audit-logs']) {
      const response = await jsonRequest('GET', endpoint)
      assert.equal(response.status, 403, `${endpoint} must reject recruiter`)
      assert.equal(response.body.error.code, 'FORBIDDEN')
    }
  })

  it('never returns raw secret values from settings', async (context) => {
    if (!process.env.DATABASE_URL && !process.env.PGPASSWORD) { context.skip('requires PostgreSQL credentials for AdminService'); return }
    const loginResponse = await jsonRequest('POST', '/api/v1/auth/login', { email: 'admin@smartrecruit.local', password: 'admin123' })
    assert.equal(loginResponse.status, 200)
    cookie = (loginResponse.headers['set-cookie'] as string[] | undefined)?.map((item) => item.split(';', 1)[0]).join('; ') ?? ''
    const response = await jsonRequest('GET', '/api/v1/admin/settings')
    assert.equal(response.status, 200)
    const serialized = JSON.stringify(response.body.data)
    assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]{8,}/)
    assert.doesNotMatch(serialized, /OPENAI_API_KEY|DATABASE_URL|PGPASSWORD/i)
  })
})
