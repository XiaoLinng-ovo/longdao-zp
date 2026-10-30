import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('HTTP completion enforces role, CSRF and stage while returning independently persisted outcomes', async () => {
  const keys = ['NODE_ENV', 'AUTH_STORE_PATH', 'REQUIRE_CSRF', 'ALLOWED_ORIGINS', 'ALLOW_DEV_BOOTSTRAP_AUTH', 'PGPASSWORD', 'DATABASE_URL']
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  const dir = await mkdtemp(join(tmpdir(), 'interview-completion-http-'))
  const origin = 'https://completion.example.test'
  process.env.NODE_ENV = 'test'; process.env.AUTH_STORE_PATH = join(dir, 'auth.json')
  process.env.REQUIRE_CSRF = 'true'; process.env.ALLOWED_ORIGINS = origin; process.env.ALLOW_DEV_BOOTSTRAP_AUTH = 'false'
  delete process.env.PGPASSWORD; delete process.env.DATABASE_URL
  let server: ReturnType<typeof import('../src/server.js').createHttpServer> | undefined
  try {
    const { createHttpServer } = await import('../src/server.js')
    const { loadConfig } = await import('../src/config.js')
    server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const base = 'http://127.0.0.1:' + address.port + '/api/v1'
    const login = async (name: string) => {
      const r = await fetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: name + '@smartrecruit.local', password: name + '123' }) })
      assert.equal(r.status, 200)
      const cookies = r.headers.getSetCookie()
      const cookie = (key: string) => decodeURIComponent(cookies.find(c => c.startsWith(key + '='))!.split(';')[0]!.slice(key.length + 1))
      return { session: cookie('smartrecruit_session'), csrf: cookie('smartrecruit_csrf') }
    }
    const recruiter = await login('recruiter'), approver = await login('approver')
    const send = async (method: string, path: string, body: unknown = {}, auth = recruiter, csrf = true) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin, authorization: 'Bearer ' + auth.session,
        ...(csrf ? { cookie: 'smartrecruit_csrf=' + auth.csrf, 'x-csrf-token': auth.csrf } : {}) }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
      return { status: r.status, body: await r.json() as any }
    }
    const created = await send('POST', '/interviews', { applicationId: 'application-8821', round: 1, title: '初试', participants: [] })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const id = created.body.data.id
    assert.equal((await send('POST', '/interviews/' + id + '/complete', { outcome: 'continue' }, approver)).status, 403)
    assert.equal((await send('POST', '/interviews/' + id + '/complete', { outcome: 'continue' }, recruiter, false)).status, 403)
    assert.equal((await send('POST', '/interviews/' + id + '/complete', { outcome: 'offer' })).status, 400)
    const completed = await send('POST', '/interviews/' + id + '/complete', { outcome: 'continue' })
    assert.equal(completed.status, 200, JSON.stringify(completed.body))
    assert.equal((await send('POST', '/interviews/' + id + '/complete', { outcome: 'continue' })).status, 200)
    let list = await send('GET', '/interviews?applicationId=application-8821')
    const final = list.body.data.find((i: any) => i.round === 2)
    assert.ok(final)
    assert.equal(list.body.data.find((i: any) => i.id === id).outcome, 'continue')
    assert.equal((await send('POST', '/interviews/' + final.id + '/complete', { outcome: 'offer' })).status, 200)
    list = await send('GET', '/interviews?applicationId=application-8821')
    assert.equal(list.body.data.find((i: any) => i.id === id).outcome, 'continue')
    assert.equal(list.body.data.find((i: any) => i.id === final.id).outcome, 'offer')
    assert.equal(list.body.data.find((i: any) => i.id === final.id).application.status, 'offer_approval')
    assert.equal(list.body.data.find((i: any) => i.id === final.id).aiScore, null)
    assert.equal((await send('POST', '/interviews/' + final.id + '/complete', { outcome: 'reject' })).status, 409)
  } finally {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()))
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await rm(dir, { recursive: true, force: true })
  }
})
