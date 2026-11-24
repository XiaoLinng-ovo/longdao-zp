import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const paths = ['/api/v1/workspaces', '/api/v1/candidates', '/api/v1/applications', '/api/v1/resumes',
  '/api/v1/resume-import-batches', '/api/v1/resume-import-batches/probe/items/probe/content',
  '/api/v1/resume-import-batches/probe/cancel', '/api/v1/interviews', '/api/v1/jobs']

function send(port, origin, path, payload = {}, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
      host: new URL(origin).host, origin, 'x-forwarded-proto': 'https', 'content-type': 'application/json',
      cookie: '__Host-smartrecruit_csrf=token', 'x-csrf-token': 'token', ...extra,
    } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
        catch (error) { reject(error) }
      })
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end(JSON.stringify(payload))
  })
}

test('production gateway accepts new website domains without reconfiguration and preserves CSRF, auth and upload behavior', async () => {
  const keys = ['NODE_ENV', 'AUTH_STORE_PATH', 'RECRUITING_QUARANTINE_ROOT', 'INTERVIEW_STORAGE_ROOT',
    'REQUIRE_CSRF', 'ALLOWED_ORIGINS', 'RESUME_UPLOAD_RELAX_ORIGIN', 'ALLOW_DEV_BOOTSTRAP_AUTH', 'RESUME_VIRUS_SCAN_ENABLED']
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  const directory = await mkdtemp(join(tmpdir(), 'deployment-origin-'))
  let api, gateway, app
  try {
    Object.assign(process.env, { NODE_ENV: 'test', AUTH_STORE_PATH: join(directory, 'auth.json'),
      RECRUITING_QUARANTINE_ROOT: join(directory, 'resumes'), INTERVIEW_STORAGE_ROOT: join(directory, 'interviews'),
      REQUIRE_CSRF: 'true', ALLOWED_ORIGINS: '', RESUME_UPLOAD_RELAX_ORIGIN: 'false',
      ALLOW_DEV_BOOTSTRAP_AUTH: 'false', RESUME_VIRUS_SCAN_ENABLED: 'false' })
    const release = resolve(process.env.SMARTRECRUIT_ORIGIN_TEST_RELEASE || resolve(import.meta.dirname, '../..'))
    const { createApp } = await import(pathToFileURL(join(release, 'apps/api/dist/src/server.js')).href)
    const { loadConfig } = await import(pathToFileURL(join(release, 'apps/api/dist/src/config.js')).href)
    const { createProductionGateway: releaseGateway } = await import(pathToFileURL(join(release, 'scripts/serve-web-production.mjs')).href)
    // Isolated in-memory business repositories; only request security runs in production mode.
    app = createApp(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
    api = createServer(app)
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
    const login = await fetch(`http://127.0.0.1:${api.address().port}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'recruiter@smartrecruit.local', password: 'recruiter123' }),
    })
    assert.equal(login.status, 200)
    const session = login.headers.getSetCookie().find(value => value.startsWith('smartrecruit_session='))?.split(';')[0]
    assert.ok(session)
    const authorization = 'Bearer ' + decodeURIComponent(session.slice('smartrecruit_session='.length))
    gateway = releaseGateway({ apiTarget: `http://127.0.0.1:${api.address().port}` })
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
    const port = gateway.address().port
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
    assert.equal((await health.json()).data.originPolicy, 'same-origin')
    process.env.NODE_ENV = 'production'
    for (const allowed of ['', 'https://old-address.trycloudflare.com']) {
      process.env.ALLOWED_ORIGINS = allowed
      for (const origin of ['https://first-address.trycloudflare.com', 'https://second-address.trycloudflare.com',
        'https://recruit.example.test:8443', 'https://zhaopin.longdaoec.com']) {
        for (const path of paths) {
          const accepted = await send(port, origin, path)
          assert.equal(accepted.status, 401, `${origin} ${path}: ${JSON.stringify(accepted.body)}`)
          assert.equal(accepted.body.error.code, 'AUTHENTICATION_REQUIRED')
          const missingToken = await send(port, origin, path, {}, { 'x-csrf-token': '' })
          assert.equal(missingToken.status, 403)
          assert.equal(missingToken.body.error.code, 'CSRF_TOKEN_INVALID', path)
          const foreign = await send(port, origin, path, {}, { origin: 'https://attacker.invalid',
            'x-forwarded-host': 'attacker.invalid', 'sec-fetch-site': 'same-origin' })
          assert.equal(foreign.status, 403)
          assert.equal(foreign.body.error.code, 'CSRF_ORIGIN_MISMATCH', path)
        }
      }
    }
    process.env.ALLOWED_ORIGINS = ''
    const origin = 'https://zhaopin.longdaoec.com'
    const candidate = await send(port, origin, '/api/v1/candidates', { fullName: 'Deployment origin test', source: 'test' }, { authorization })
    assert.equal(candidate.status, 201, JSON.stringify(candidate.body))
    const application = await send(port, origin, '/api/v1/applications', { candidateId: candidate.body.data.id, jobId: 'job-108' }, { authorization })
    assert.equal(application.status, 201, JSON.stringify(application.body))
    const resume = await send(port, origin, '/api/v1/resumes', {
      candidateId: candidate.body.data.id, applicationId: application.body.data.id,
      originalFilename: 'deployment-origin.txt', mimeType: 'text/plain', encoding: 'base64',
      content: Buffer.from('Synthetic resume. Software engineer with Java experience.').toString('base64'),
    }, { authorization })
    assert.equal(resume.status, 201, JSON.stringify(resume.body))
    assert.ok(resume.body.data.resume.id)
  } finally {
    if (gateway) await new Promise(resolve => gateway.close(resolve))
    if (api) await new Promise(resolve => api.close(resolve))
    if (app) await app.close()
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
