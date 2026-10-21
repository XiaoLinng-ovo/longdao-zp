import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { loadConfig } from '../src/config.js'

const envKeys = ['NODE_ENV', 'AUTH_STORE_PATH', 'RECRUITING_QUARANTINE_ROOT', 'REQUIRE_CSRF', 'ALLOWED_ORIGINS', 'RESUME_UPLOAD_RELAX_ORIGIN', 'ALLOW_DEV_BOOTSTRAP_AUTH', 'RESUME_VIRUS_SCAN_ENABLED'] as const
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
const origin = 'https://new-upload-tunnel.example.test'
let server: ReturnType<typeof import('../src/server.js').createHttpServer> | undefined
let directory: string | undefined
let baseUrl: string
let sessionToken: string
let csrfToken: string

async function send(method: string, path: string, payload: unknown = {}, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json', origin,
      authorization: `Bearer ${sessionToken}`,
      cookie: `smartrecruit_csrf=${csrfToken}`,
      'x-csrf-token': csrfToken,
      ...headers
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(payload) })
  })
  return { status: response.status, body: await response.json() as any }
}

async function login(email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie()
  const session = cookies.find((value) => value.startsWith('smartrecruit_session='))?.split(';')[0]
  const csrf = cookies.find((value) => value.startsWith('smartrecruit_csrf='))?.split(';')[0]
  assert.ok(session)
  assert.ok(csrf)
  return {
    session: decodeURIComponent(session.slice('smartrecruit_session='.length)),
    csrf: decodeURIComponent(csrf.slice('smartrecruit_csrf='.length))
  }
}

before(async () => {
  process.env.NODE_ENV = 'test'
  process.env.REQUIRE_CSRF = 'true'
  process.env.ALLOWED_ORIGINS = 'https://trusted.example.test'
  process.env.RESUME_UPLOAD_RELAX_ORIGIN = 'true'
  process.env.ALLOW_DEV_BOOTSTRAP_AUTH = 'false'
  process.env.RESUME_VIRUS_SCAN_ENABLED = 'false'
  directory = await mkdtemp(join(tmpdir(), 'resume-upload-origin-test-'))
  process.env.AUTH_STORE_PATH = join(directory, 'auth.json')
  process.env.RECRUITING_QUARANTINE_ROOT = join(directory, 'resumes')
  const { createHttpServer } = await import('../src/server.js')
  server = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  baseUrl = `http://127.0.0.1:${address.port}`
  const credentials = await login('recruiter@smartrecruit.local', 'recruiter123')
  sessionToken = credentials.session
  csrfToken = credentials.csrf
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('resume upload origin is strict by default and can be switched back to strict', async () => {
  for (const flag of [undefined, 'false']) {
    if (flag === undefined) delete process.env.RESUME_UPLOAD_RELAX_ORIGIN
    else process.env.RESUME_UPLOAD_RELAX_ORIGIN = flag
    try {
      for (const path of ['/api/v1/candidates', '/api/v1/applications', '/api/v1/resumes']) {
        const result = await send('POST', path)
        assert.equal(result.status, 403)
        assert.equal(result.body.error.code, 'CSRF_ORIGIN_MISMATCH', path)
      }
    } finally {
      process.env.RESUME_UPLOAD_RELAX_ORIGIN = 'true'
    }
  }
})

test('relaxed resume upload completes candidate, application and file creation from a new origin', async () => {
  const candidate = await send('POST', '/api/v1/candidates', { fullName: 'Origin upload test', source: 'test' })
  assert.equal(candidate.status, 201, JSON.stringify(candidate.body))
  const application = await send('POST', '/api/v1/applications', { candidateId: candidate.body.data.id, jobId: 'job-108' })
  assert.equal(application.status, 201, JSON.stringify(application.body))
  const resume = await send('POST', '/api/v1/resumes', {
    candidateId: candidate.body.data.id, applicationId: application.body.data.id,
    originalFilename: 'origin-test.txt', mimeType: 'text/plain',
    content: Buffer.from('Synthetic resume. Software engineer with Java experience.').toString('base64'), encoding: 'base64'
  })
  assert.equal(resume.status, 201, JSON.stringify(resume.body))
  assert.equal(resume.body.data.resume.candidateId, candidate.body.data.id)
  assert.equal(resume.body.data.resume.applicationId, application.body.data.id)
  assert.ok(resume.body.data.task.id)
})

test('relaxed resume upload still rejects missing and mismatched CSRF tokens and invalid origins', async () => {
  for (const path of ['/api/v1/candidates', '/api/v1/applications', '/api/v1/resumes']) {
    for (const headers of [{ 'x-csrf-token': '' }, { cookie: '' }, { 'x-csrf-token': 'wrong-token' }]) {
      const result = await send('POST', path, {}, headers)
      assert.equal(result.status, 403)
      assert.equal(result.body.error.code, 'CSRF_TOKEN_INVALID', path)
    }
    for (const invalidOrigin of ['', 'null', 'https://example.test/path']) {
      const result = await send('POST', path, {}, { origin: invalidOrigin })
      assert.equal(result.status, 403)
      assert.equal(result.body.error.code, 'CSRF_ORIGIN_MISMATCH', path)
    }
  }
})

test('relaxed resume upload still requires authentication and candidate write permissions', async () => {
  const manager = await login('manager@smartrecruit.local', 'manager123')
  for (const path of ['/api/v1/candidates', '/api/v1/applications', '/api/v1/resumes']) {
    const anonymous = await send('POST', path, {}, { authorization: '' })
    assert.equal(anonymous.status, 401)
    assert.equal(anonymous.body.error.code, 'AUTHENTICATION_REQUIRED', path)
    const denied = await send('POST', path, {}, { authorization: `Bearer ${manager.session}` })
    assert.equal(denied.status, 403, path)
    assert.equal(denied.body.error.code, 'FORBIDDEN', path)
  }
})

test('relaxed resume upload does not relax origins for deletion, job writes, resume reparse or admin writes', async () => {
  for (const [method, path] of [
    ['DELETE', '/api/v1/candidates/candidate-8821'],
    ['DELETE', '/api/v1/applications/application-8821'],
    ['PATCH', '/api/v1/candidates/candidate-8821'],
    ['POST', '/api/v1/jobs'],
    ['POST', '/api/v1/resumes/any-id/reparse'],
    ['POST', '/api/v1/admin/ai-settings']
  ]) {
    const result = await send(method!, path!)
    assert.equal(result.status, 403)
    assert.equal(result.body.error.code, 'CSRF_ORIGIN_MISMATCH', `${method} ${path}`)
  }
})

test('registering the new exact tunnel origin restores screening approval and initial interview scheduling', async () => {
  const previousOrigins = process.env.ALLOWED_ORIGINS
  const reviewPath = '/api/v1/analysis-results/origin-test/scoring'
  for (const [method, path] of [['PATCH', reviewPath], ['POST', '/api/v1/interviews']]) {
    const blocked = await send(method!, path!)
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.error.code, 'CSRF_ORIGIN_MISMATCH')
  }

  process.env.ALLOWED_ORIGINS = `${previousOrigins},${origin}`
  try {
    const candidate = await send('POST', '/api/v1/candidates', { fullName: 'Initial interview origin test', source: 'test' })
    assert.equal(candidate.status, 201, JSON.stringify(candidate.body))
    const application = await send('POST', '/api/v1/applications', { candidateId: candidate.body.data.id, jobId: 'job-108' })
    assert.equal(application.status, 201, JSON.stringify(application.body))
    const applicationId = application.body.data.id
    const resume = await send('POST', '/api/v1/resumes', {
      candidateId: candidate.body.data.id, applicationId,
      originalFilename: 'initial-interview.txt', mimeType: 'text/plain', encoding: 'base64',
      content: Buffer.from('姓名：来源校验测试\n学历：本科，计算机科学与技术专业。\n本科及以上学历：计算机相关专业优先\n工作经验：负责核心服务设计与研发，使用 Java、Spring Boot、PostgreSQL 开发核心业务服务，推动工程质量建设。').toString('base64')
    })
    assert.equal(resume.status, 201, JSON.stringify(resume.body))
    const processed = await send('POST', `/api/v1/analysis-tasks/${resume.body.data.task.id}`)
    assert.equal(processed.status, 200, JSON.stringify(processed.body))
    assert.equal(processed.body.data.status, 'completed', JSON.stringify(processed.body))
    const results = await send('GET', `/api/v1/analysis-results?applicationId=${applicationId}`)
    assert.equal(results.status, 200)
    const resultId = results.body.data[0].id
    const scoringPath = `/api/v1/analysis-results/${resultId}/scoring`
    const passed = await send('PATCH', scoringPath, { decision: 'passed' })
    assert.equal(passed.status, 200, JSON.stringify(passed.body))
    const applications = await send('GET', '/api/v1/applications')
    assert.equal(applications.body.data.find((item: any) => item.id === applicationId).status, 'interviewing')
    const interview = await send('POST', '/api/v1/interviews', {
      applicationId, title: '初试', round: 1,
      participants: [{ userId: 'user-interviewer', role: 'interviewer' }]
    })
    assert.equal(interview.status, 201, JSON.stringify(interview.body))
    assert.equal(interview.body.data.applicationId, applicationId)
    assert.equal(interview.body.data.status, 'scheduled')

    for (const [method, path] of [['PATCH', scoringPath], ['POST', '/api/v1/interviews']]) {
      const noToken = await send(method!, path!, {}, { 'x-csrf-token': '' })
      assert.equal(noToken.status, 403)
      assert.equal(noToken.body.error.code, 'CSRF_TOKEN_INVALID')
      const unknownOrigin = await send(method!, path!, {}, { origin: 'https://unregistered.example.test' })
      assert.equal(unknownOrigin.status, 403)
      assert.equal(unknownOrigin.body.error.code, 'CSRF_ORIGIN_MISMATCH')
    }
  } finally {
    if (previousOrigins === undefined) delete process.env.ALLOWED_ORIGINS
    else process.env.ALLOWED_ORIGINS = previousOrigins
  }
})
