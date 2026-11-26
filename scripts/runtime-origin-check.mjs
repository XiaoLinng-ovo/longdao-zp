import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const releaseProbeOrigins = Object.freeze([
  'https://first-address.trycloudflare.com',
  'https://second-address.trycloudflare.com',
  'https://zhaopin.longdaoec.com',
])

export function verifyReleaseOriginPolicy(root, { spawnProcess = spawn, env = process.env } = {}) {
  const isolated = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|USERPROFILE|HOME|PATHEXT|SYSTEMDRIVE)$/iu.test(key)))
  return new Promise((yes, no) => {
    const child = spawnProcess(process.execPath, [resolve(import.meta.dirname, 'runtime-origin-check.mjs'), '--probe', resolve(root)], {
      env: isolated, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000,
    })
    let output = ''
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192) })
    child.stderr.on('data', () => {})
    child.once('error', error => no(new Error('RELEASE_ORIGIN_POLICY: Isolated check could not run', { cause: error })))
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal) return no(new Error('RELEASE_ORIGIN_POLICY: Candidate must accept rotated same-origin domains and reject cross-site requests; active services were not changed'))
      try {
        const result = JSON.parse(output.trim())
        assert.equal(result.ready, true)
        assert.equal(result.originPolicy, 'same-origin')
        assert.ok(result.checkedRequests >= releaseProbeOrigins.length * 7 * 3)
        assert.deepEqual(result.checkedOrigins, releaseProbeOrigins)
        yes(result)
      } catch (error) { no(new Error('RELEASE_ORIGIN_POLICY: Invalid isolated check result', { cause: error })) }
    })
  })
}

function sendProbe(port, origin, path, source, token) {
  return new Promise((yes, no) => {
    const probe = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
      host: new URL(origin).host, origin: source, 'content-type': 'application/json',
      'x-forwarded-proto': 'https', 'x-forwarded-host': 'untrusted-origin.invalid',
      'sec-fetch-site': 'same-origin', cookie: '__Host-smartrecruit_csrf=token', 'x-csrf-token': token,
    } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', no)
      response.once('end', () => {
        try { yes({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) }
        catch (error) { no(error) }
      })
    })
    probe.once('error', no)
    probe.setTimeout(5000, () => probe.destroy(new Error('Origin probe timed out')))
    probe.end('{}')
  })
}

export async function probeReleaseOriginPolicy(root) {
  const directory = await mkdtemp(join(tmpdir(), 'recruit-release-origin-'))
  let app, api, gateway
  try {
    Object.assign(process.env, { NODE_ENV: 'test', AUTH_STORE_PATH: join(directory, 'auth.json'),
      RECRUITING_QUARANTINE_ROOT: join(directory, 'resumes'), INTERVIEW_STORAGE_ROOT: join(directory, 'interviews'),
      REQUIRE_CSRF: 'true', ALLOWED_ORIGINS: 'https://old-address.trycloudflare.com', RESUME_UPLOAD_RELAX_ORIGIN: 'false',
      ALLOW_DEV_BOOTSTRAP_AUTH: 'false', RESUME_VIRUS_SCAN_ENABLED: 'false' })
    const load = name => import(pathToFileURL(join(root, name)).href)
    const { createApp } = await load('apps/api/dist/src/server.js')
    const { loadConfig } = await load('apps/api/dist/src/config.js')
    const { createProductionGateway } = await load('scripts/serve-web-production.mjs')
    app = createApp(loadConfig({ NODE_ENV: 'test', PORT: '0' }))
    api = createServer(app)
    await new Promise((yes, no) => { api.once('error', no); api.listen(0, '127.0.0.1', yes) })
    gateway = createProductionGateway({ apiTarget: 'http://127.0.0.1:' + api.address().port })
    await new Promise((yes, no) => { gateway.once('error', no); gateway.listen(0, '127.0.0.1', yes) })
    const port = gateway.address().port
    process.env.NODE_ENV = 'production'
    const health = await fetch('http://127.0.0.1:' + port + '/api/v1/health', { signal: AbortSignal.timeout(5000) })
    assert.equal((await health.json()).data.originPolicy, 'same-origin')
    const paths = ['/api/v1/workspaces', '/api/v1/candidates', '/api/v1/applications', '/api/v1/resumes',
      '/api/v1/resume-import-batches', '/api/v1/resume-import-batches/probe/items/probe/content',
      '/api/v1/resume-import-batches/probe/cancel']
    let checkedRequests = 0
    for (const origin of releaseProbeOrigins) {
      for (const path of paths) {
        for (const [source, token, status, code] of [
          [origin, 'token', 401, 'AUTHENTICATION_REQUIRED'],
          [origin, '', 403, 'CSRF_TOKEN_INVALID'],
          ['https://untrusted-origin.invalid', 'token', 403, 'CSRF_ORIGIN_MISMATCH'],
        ]) {
          const result = await sendProbe(port, origin, path, source, token)
          assert.equal(result.status, status, path)
          assert.equal(result.body.error?.code, code, path)
          checkedRequests++
        }
      }
    }
    return { ready: true, originPolicy: 'same-origin', checkedRequests, checkedOrigins: [...releaseProbeOrigins] }
  } finally {
    if (gateway) await new Promise(yes => { gateway.close(yes); gateway.closeIdleConnections() })
    if (api) await new Promise(yes => { api.close(yes); api.closeIdleConnections() })
    if (app) await app.close()
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv[2], '--probe')
    assert.ok(process.argv[3])
    console.log(JSON.stringify(await probeReleaseOriginPolicy(resolve(process.argv[3]))))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
