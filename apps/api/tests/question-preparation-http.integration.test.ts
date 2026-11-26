import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('invitation returns before model work and preparation endpoints enforce scope, role and CSRF', async () => {
  const keys = ['NODE_ENV','AUTH_STORE_PATH','REQUIRE_CSRF','ALLOWED_ORIGINS','ALLOW_DEV_BOOTSTRAP_AUTH','PGPASSWORD','DATABASE_URL']
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  const directory = await mkdtemp(join(tmpdir(), 'question-preparation-http-'))
  const origin = 'https://preparation.example.test'
  Object.assign(process.env, { NODE_ENV: 'test', AUTH_STORE_PATH: join(directory, 'auth.json'), REQUIRE_CSRF: 'true', ALLOWED_ORIGINS: origin, ALLOW_DEV_BOOTSTRAP_AUTH: 'false' })
  delete process.env.PGPASSWORD; delete process.env.DATABASE_URL
  let server: ReturnType<typeof import('../src/server.js').createHttpServer> | undefined
  try {
    const { createHttpServer } = await import('../src/server.js'), { loadConfig } = await import('../src/config.js')
    server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const base = 'http://127.0.0.1:' + address.port + '/api/v1'
    const login = async (name: string) => {
      const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: name + '@smartrecruit.local', password: name + '123' }) })
      assert.equal(r.status, 200)
      const cookie = (key: string) => decodeURIComponent(r.headers.getSetCookie().find(c => c.startsWith(key + '='))!.split(';')[0]!.slice(key.length + 1))
      return { session: cookie('smartrecruit_session'), csrf: cookie('smartrecruit_csrf') }
    }
    const recruiter = await login('recruiter'), approver = await login('approver')
    const send = async (method: string, path: string, body: unknown = {}, auth = recruiter, csrf = true) => {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin, authorization: 'Bearer ' + auth.session,
        ...(csrf ? { cookie: 'smartrecruit_csrf=' + auth.csrf, 'x-csrf-token': auth.csrf } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json() as any }
    }
    const created = await send('POST', '/interviews', { applicationId: 'application-8821', round: 1, title: '提前准备初试', participants: [] })
    assert.equal(created.status, 201, JSON.stringify(created.body)); const id = created.body.data.id
    const endpoint = '/interviews/' + id + '/question-preparation'
    assert.equal((await send('GET', endpoint)).body.data.status, 'queued')
    assert.equal((await send('POST', endpoint)).status, 202)
    assert.equal((await send('POST', endpoint)).body.data.status, 'queued')
    assert.equal((await send('POST', endpoint, {}, recruiter, false)).status, 403)
    assert.equal((await send('POST', endpoint, {}, approver)).status, 403)
    assert.equal((await send('GET', '/interviews/non-existent/question-preparation')).status, 404)
    const list = await send('GET', '/interviews')
    assert.equal(list.body.data.find((row: any) => row.id === id).questionPreparation.status, 'queued')
  } finally {
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(directory, { recursive: true, force: true })
  }
})
