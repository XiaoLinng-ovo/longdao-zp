import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { loadConfig } from '../src/config.js'

const envKeys = ['NODE_ENV', 'AUTH_STORE_PATH', 'REQUIRE_CSRF', 'ALLOWED_ORIGINS', 'ALLOW_DEV_BOOTSTRAP_AUTH'] as const
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
const origin = 'https://schedule.example.test'
type Credentials = { session: string; csrf: string }
let server: ReturnType<typeof import('../src/server.js').createHttpServer> | undefined
let directory: string | undefined
let baseUrl: string
let recruiter: Credentials
let manager: Credentials
let approver: Credentials
let interviewId: string
let otherDepartmentId: string

async function send(method: string, path: string, payload: unknown = {}, credentials = recruiter, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/api/v1${path}`, { method,
    headers: { 'content-type': 'application/json', origin, authorization: `Bearer ${credentials.session}`,
      cookie: `smartrecruit_csrf=${credentials.csrf}`, 'x-csrf-token': credentials.csrf, ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }) })
  return { status: response.status, body: await response.json() as any }
}

async function login(name: string): Promise<Credentials> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${name}@smartrecruit.local`, password: `${name}123` }) })
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie()
  const cookie = (name: string) => decodeURIComponent(cookies.find(value => value.startsWith(`${name}=`))!.split(';')[0]!.slice(name.length + 1))
  return { session: cookie('smartrecruit_session'), csrf: cookie('smartrecruit_csrf') }
}

before(async () => {
  process.env.NODE_ENV = 'test'
  process.env.REQUIRE_CSRF = 'true'
  process.env.ALLOWED_ORIGINS = origin
  process.env.ALLOW_DEV_BOOTSTRAP_AUTH = 'false'
  directory = await mkdtemp(join(tmpdir(), 'interview-schedule-test-'))
  process.env.AUTH_STORE_PATH = join(directory, 'auth.json')
  const { createHttpServer } = await import('../src/server.js')
  server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
  recruiter = await login('recruiter')
  manager = await login('manager')
  approver = await login('approver')
  for (const applicationId of ['application-8821', 'application-8814']) {
    const created = await send('POST', '/interviews', { applicationId, title: 'Schedule test',
      scheduledStartAt: '2026-10-20T02:00:00.000Z', scheduledEndAt: '2026-10-20T03:00:00.000Z',
      location: 'Old room', participants: [{ userId: 'user-interviewer', role: 'interviewer' }] })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    if (applicationId === 'application-8821') interviewId = created.body.data.id
    else otherDepartmentId = created.body.data.id
  }
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('PATCH persists the original interview and validates changes', async () => {
  const before = await send('GET', `/interviews/${interviewId}`)
  const changed = await send('PATCH', `/interviews/${interviewId}`, {
    scheduledStartAt: '2026-10-21T14:00:00+08:00', scheduledEndAt: null,
    location: 'New room', meetingUrl: 'https://meeting.example.test/new' })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.equal(changed.body.data.id, interviewId)
  assert.equal(changed.body.data.scheduledStartAt, '2026-10-21T06:00:00.000Z')
  const saved = await send('GET', `/interviews/${interviewId}`)
  assert.equal(saved.body.data.location, 'New room')
  assert.equal(saved.body.data.scheduledEndAt, undefined)
  assert.deepEqual(saved.body.data.application, before.body.data.application)
  assert.deepEqual(saved.body.data.participants, before.body.data.participants)
  const invalid = await send('PATCH', `/interviews/${interviewId}`, { scheduledEndAt: '2026-10-20T00:00:00Z' })
  assert.equal(invalid.status, 400)
  const forbiddenField = await send('PATCH', `/interviews/${interviewId}`, { status: 'completed' })
  assert.equal(forbiddenField.status, 400)
  const cleared = await send('PATCH', `/interviews/${interviewId}`, { meetingUrl: null })
  assert.equal(cleared.status, 200)
  assert.equal((await send('GET', `/interviews/${interviewId}`)).body.data.meetingUrl, undefined)
})

test('PATCH requires authentication, CSRF, role and matching department scope', async () => {
  const path = `/interviews/${interviewId}`
  const payload = { location: 'Unauthorized room' }
  assert.equal((await send('PATCH', path, payload, recruiter, { authorization: '' })).status, 401)
  assert.equal((await send('PATCH', path, payload, recruiter, { 'x-csrf-token': '' })).status, 403)
  assert.equal((await send('PATCH', path, payload, recruiter, { origin: 'https://untrusted.example.test' })).status, 403)
  assert.equal((await send('PATCH', path, payload, approver)).status, 403)
  const denied = await send('PATCH', `/interviews/${otherDepartmentId}`, payload, manager)
  assert.equal(denied.status, 403, JSON.stringify(denied.body))
  assert.equal((await send('GET', `/interviews/${otherDepartmentId}`)).body.data.location, 'Old room')
  const allowed = await send('PATCH', path, { location: 'Manager room' }, manager)
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body))
  assert.equal((await send('GET', path)).body.data.location, 'Manager room')
})
