import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { readRuntimeConfig, validateManagedConfig } from '../runtime-config.mjs'
import { createRuntimeLog } from '../runtime-log.mjs'
import { requireFreePorts, probeRuntime } from '../runtime-probes.mjs'
import { processSpec, processStatus, control } from '../runtime-control.mjs'
import { releaseFiles, verifyRelease, prepareRelease, assertReleaseCapacity, retainPreviousWebAssets } from '../runtime-release.mjs'

const fixture = async run => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-management-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}
const valid = root => ({ TENANT_SCHEMA_ROUTING: 'on', WORKER_DB_POLL: 'true', PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'fixture', PGUSER: 'fixture', RECRUITING_QUARANTINE_ROOT: join(root, 'resumes'), INTERVIEW_STORAGE_ROOT: join(root, 'interviews'), AUTH_OTP_HMAC_SECRET: 'x'.repeat(32), AUTH_MFA_ENCRYPTION_KEY: 'y'.repeat(32) })

test('release carries only verified public assets for two generations, never old HTML or server files', () => fixture(async root => {
  const previous = join(root, 'previous'), candidate = join(root, 'candidate')
  for (const folder of ['assets', 'previous-assets/1/assets', 'previous-assets/2/assets']) await mkdir(join(previous, 'web/dist', folder), { recursive: true })
  await writeFile(join(previous, 'web/dist/assets/room-abc123.js'), 'previous')
  await writeFile(join(previous, 'web/dist/previous-assets/1/assets/room-def456.js'), 'older')
  await writeFile(join(previous, 'web/dist/previous-assets/2/assets/room-ghi789.js'), 'expired')
  await writeFile(join(previous, 'web/dist/index.html'), 'old index')
  await writeFile(join(previous, 'secret.env'), 'private fixture')
  const files = await releaseFiles(previous)
  await writeFile(join(previous, 'release-manifest.json'), JSON.stringify({ format: 1, id: 'previous', sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }))
  await retainPreviousWebAssets(candidate, previous)
  assert.deepEqual((await releaseFiles(candidate)).map(file => file.path).sort(), ['web/dist/previous-assets/1/assets/room-abc123.js', 'web/dist/previous-assets/2/assets/room-def456.js'])
  assert.equal(await readFile(join(candidate, 'web/dist/previous-assets/1/assets/room-abc123.js'), 'utf8'), 'previous')
  await writeFile(join(previous, 'web/dist/assets/room-abc123.js'), 'tampered')
  await assert.rejects(retainPreviousWebAssets(join(root, 'refused'), previous), /RELEASE_CHANGED/)
}))

test('capacity check refuses before creating candidate directories and follows nearest existing parent',()=>fixture(async root=>{
  const destination=join(root,'not-created','candidate')
  await assert.rejects(assertReleaseCapacity(destination,2n**100n),/RELEASE_DISK_SPACE/)
  assert.deepEqual(await readdir(root),[])
  await assertReleaseCapacity(destination,0n)
  assert.deepEqual(await readdir(root),[])
  await assert.rejects(prepareRelease(root,destination,{pnpmStore:'relative'}),/BUILD_TOOL/)
}))

test('selected profile is authoritative and reads do not change configuration', () => fixture(async root => {
  const file = join(root, 'selected.env'), content = 'PORT=3210\nWORKER_CONCURRENCY=2\nPORT=9999\n'
  await writeFile(file, content)
  const config = readRuntimeConfig(root, { ENV_FILE_PATH: file, WORKER_CONCURRENCY: '4' })
  assert.equal(config.ports.api, 3210)
  assert.equal(config.env.WORKER_CONCURRENCY, '4')
  assert.equal(config.env.SMARTRECRUIT_MANAGED_ENV, '1')
  assert.equal(config.env.NODE_ENV, 'production')
  assert.equal(await readFile(file, 'utf8'), content)
}))
test('missing explicit profile never falls back to a business profile', () => fixture(async root => {
  await writeFile(join(root, '.env'), 'PORT=3999\n')
  assert.throws(() => readRuntimeConfig(root, { ENV_FILE_PATH: join(root, 'typo.env') }), /CONFIG_FILE/)
}))
test('full runtime refuses implicit routing, database, worker polling, storage and regenerated secrets', () => fixture(async root => {
  assert.doesNotThrow(() => validateManagedConfig(valid(root)))
  for (const key of ['TENANT_SCHEMA_ROUTING', 'WORKER_DB_POLL', 'PGHOST', 'RECRUITING_QUARANTINE_ROOT', 'INTERVIEW_STORAGE_ROOT', 'AUTH_MFA_ENCRYPTION_KEY']) {
    const env = valid(root); delete env[key]
    assert.throws(() => validateManagedConfig(env), undefined, key)
  }
  assert.throws(() => readRuntimeConfig(root, { PORT: '3100', WEB_PORT: '3100' }), /distinct/)
  assert.throws(() => readRuntimeConfig(root, { WEB_HOST: '0.0.0.0' }), /CONFIG_BIND/)
}))
test('port conflicts fail closed without killing or switching the listener', async () => {
  const server = createServer((_req, res) => res.end('sentinel'))
  await new Promise(yes => server.listen(0, '127.0.0.1', yes))
  try {
    const port = server.address().port
    await assert.rejects(requireFreePorts({ api: port }), /PORT_CONFLICT/)
    assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'sentinel')
  } finally { await new Promise(yes => server.close(yes)) }
})
test('probe distinguishes liveness, worker readiness, release identity and same-origin degraded state', async () => {
  let degraded = false, version = 'fixture-v1'
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/') {
      if (!req.headers.accept?.includes('text/html')) { res.writeHead(404); return res.end('Not found') }
      return res.end('<html><div id="app"></div></html>')
    }
    if (req.url === '/ready') return res.end(JSON.stringify({ service: 'smartrecruit-pro-worker', version, status: 'ready', externalDependencies: { postgres: 'ok' } }))
    if (req.url === '/api/v1/ready') return res.end(JSON.stringify({ data: { status: degraded ? 'degraded' : 'ready' } }))
    res.end(JSON.stringify({ data: { service: 'smartrecruit-pro-api', version } }))
  })
  await new Promise(yes => server.listen(0, '127.0.0.1', yes))
  try {
    const port = server.address().port, ports = { api: port, worker: port, web: port }
    assert.equal((await probeRuntime(ports, version)).ready, true)
    degraded = true
    const result = await probeRuntime(ports, version)
    assert.equal(result.ready, false)
    assert.equal(result.checks.api.ok, true)
    assert.equal(result.checks.sameOriginReady.ok, false)
    degraded = false; version = 'wrong-release'
    assert.equal((await probeRuntime(ports, 'fixture-v1')).ready, false)
  } finally { await new Promise(yes => server.close(yes)) }
})
test('process specification only runs sealed artifacts with bounded restarts and message shutdown', () => {
  const spec = processSpec('api', { root: resolve('fixture'), state: resolve('state'), id: 'fixture', env: {}, version: 'v1' })
  assert.equal(spec.watch, false)
  assert.equal(spec.filter_env, true)
  assert.equal(spec.shutdown_with_message, true)
  assert.equal(spec.max_restarts, 3)
  assert.deepEqual(spec.stop_exit_codes, [0, 78])
  assert.equal(spec.wait_ready, true)
  assert.match(spec.script, /runtime-role\.mjs$/)
  assert.doesNotMatch(JSON.stringify(spec), /start:dev|migrate-postgres|seed-dev|npm run/)
})
test('PM2 overlimit waiting state is explained as a circuit, not an upcoming restart', () => {
  const item = { pid: 0, pm2_env: { status: 'waiting restart', created_at: null, exit_code: 1 } }
  assert.equal(processStatus(item).status, 'circuit-open')
  assert.equal(processStatus(item).managerStatus, 'waiting restart')
  item.pm2_env.created_at = Date.now()
  assert.equal(processStatus(item).status, 'waiting restart')
  item.pid = 123
  item.pm2_env.created_at = null
  assert.equal(processStatus(item).status, 'waiting restart')
})
test('dependency circuit and clean exit are distinguished without masking live processes', () => {
  const item = { pid: 0, pm2_env: { status: 'waiting restart', created_at: Date.now(), exit_code: 78 } }
  assert.equal(processStatus(item).status, 'circuit-open')
  item.pm2_env.exit_code = 0
  assert.equal(processStatus(item).status, 'stopped')
  item.pid = 123; item.pm2_env.status = 'online'; item.pm2_env.exit_code = 78
  assert.equal(processStatus(item).status, 'online')
})
test('persistent start budget refuses a fourth launch independently of manager counters', () => fixture(async root => {
  const starts = [Date.now() - 3000, Date.now() - 2000, Date.now() - 1000]
  const file = join(root, 'api-starts.json')
  await writeFile(file, JSON.stringify(starts))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|USERPROFILE|HOME)$/iu.test(key)))
  Object.assign(env, { NODE_ENV: 'production', SMARTRECRUIT_MANAGED_ENV: '1', RUNTIME_ROLE: 'api', RUNTIME_STATE_DIR: root,
    PGHOST: '127.0.0.1', PGPORT: '1', PGDATABASE: 'isolated_budget_only', PGUSER: 'isolated_budget_only' })
  const child = spawnSync(process.execPath, [resolve(import.meta.dirname, '../runtime-role.mjs')], { env, timeout: 5000, windowsHide: true, encoding: 'utf8' })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 78, child.stderr)
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(starts))
  assert.match(await readFile(join(root, 'logs/api.jsonl'), 'utf8'), /RESTART_CIRCUIT_OPEN/)
}))
test('central logs rotate with a fixed bound and redact credentials', () => fixture(async root => {
  const file = join(root, 'api.jsonl'), secret = 'fixture-secret-value'
  const log = createRuntimeLog(file, { PGPASSWORD: secret }, { maxBytes: 256, copies: 2 })
  for (let n = 0; n < 25; n++) log('error', 'postgresql://u:pass@localhost/db ' + secret + ' Bearer token-value ' + n)
  const files = await readdir(root)
  assert.equal(files.length, 3)
  for (const name of files) {
    const content = await readFile(join(root, name), 'utf8')
    assert.doesNotMatch(content, /fixture-secret-value|u:pass|token-value/)
    assert.match(content, /REDACTED/)
  }
}))
test('release validation detects tampering and candidates never overwrite an existing directory', () => fixture(async root => {
  await writeFile(join(root, 'artifact.js'), 'export const ready = true\n')
  const files = await releaseFiles(root)
  const sha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  await writeFile(join(root, 'release-manifest.json'), JSON.stringify({ format: 1, id: 'fixture', files, sha256 }))
  assert.equal((await verifyRelease(root)).id, 'fixture')
  await writeFile(join(root, 'artifact.js'), 'changed')
  await assert.rejects(verifyRelease(root), /RELEASE_CHANGED/)
  await assert.rejects(prepareRelease(root, root), { code: 'EEXIST' })
}))
test('start without an approved release cannot create a daemon or change the environment', () => fixture(async root => {
  const profile = join(root, '.env'), content = 'PGDATABASE=fixture\n'
  await writeFile(profile, content)
  await assert.rejects(control('start', { root, env: { ENV_FILE_PATH: profile, RUNTIME_HOME: join(root, 'state') } }), /RELEASE_REQUIRED/)
  assert.equal(await readFile(profile, 'utf8'), content)
  assert.equal((await readdir(join(root, 'state'))).includes('operation.lock'), false)
}))

test('status never reports an unmanaged set of healthy endpoints as a ready managed instance', () => fixture(async root => {
  const servers = [], ports = []
  try {
    for (let n = 0; n < 3; n++) {
      const server = createServer((req, res) => {
        if (req.url === '/') return res.end('<div id="app"></div>')
        res.setHeader('content-type', 'application/json')
        if (req.url === '/ready') return res.end(JSON.stringify({ service: 'smartrecruit-pro-worker', status: 'ready', externalDependencies: { postgres: 'ok' } }))
        if (req.url === '/api/v1/ready') return res.end(JSON.stringify({ data: { status: 'ready' } }))
        res.end(JSON.stringify({ data: { service: 'smartrecruit-pro-api' } }))
      })
      await new Promise(yes => server.listen(0, '127.0.0.1', yes)); servers.push(server); ports.push(server.address().port)
    }
    const result = await control('status', { root, env: { LOCALAPPDATA: root, PORT: String(ports[0]), WORKER_HEALTH_PORT: String(ports[1]), WEB_PORT: String(ports[2]) } })
    assert.equal(result.endpointsReady, true)
    assert.equal(result.managed, false)
    assert.equal(result.ready, false)
  } finally { for (const server of servers) await new Promise(yes => server.close(yes)) }
}))

test('stop remains available with a missing configuration profile', () => fixture(async root => {
  const result = await control('stop', { root, env: { LOCALAPPDATA: root, ENV_FILE_PATH: join(root, 'missing.env') } })
  assert.equal(result.managed, false)
}))
