import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
function control(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) resolve()
      else reject(Object.assign(new Error('专用 PostgreSQL 控制命令失败'), { code, signal }))
    })
  })
}
export const projectRoot = resolve(import.meta.dirname, '..')

export function isolatedEnvironment(extra = {}, source = process.env) {
  const allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'userprofile', 'home', 'localappdata', 'appdata', 'programdata', 'pathext', 'systemdrive'])
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(key.toLowerCase())))
  return Object.assign(env, {
    NODE_ENV: 'development', TENANT_SCHEMA_ROUTING: 'on', REQUIRE_CSRF: 'true',
    ALLOW_DEV_BOOTSTRAP_AUTH: 'false', WORKER_USE_LLM_ANALYSIS: 'false', RESUME_VIRUS_SCAN_ENABLED: 'false',
    QUESTION_SHEET_POLL: 'off', INTERVIEW_AUDIO_POLL: 'off', INTERVIEW_QUESTION_PREPARATION_POLL: 'off',
    INTERVIEW_TRANSCRIPT_POSTPROCESS_POLL: 'off', INTERVIEW_SUMMARY_POLL: 'off', OBJECT_CLEANUP_POLL: 'off',
    RESUME_LOCAL_OCR_ENABLED: 'false', SMTP_HOST: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '',
    S3_ENDPOINT: '', CLAMAV_HOST: '', FUNASR_BASE_URL: '',
  }, extra)
}

export async function startIsolatedPostgres(binDirectory, { openssl, directoryParent = join(projectRoot, 'tmp') } = {}) {
  assert.ok(binDirectory, '必须显式指定 PostgreSQL 工具目录，禁止回退业务连接')
  assert.ok(isAbsolute(directoryParent), 'Isolated cluster parent must be absolute')
  const parent = await realpath(directoryParent)
  const suffix = randomUUID().replaceAll('-', '')
  const directory = join(parent, 'closure_verify_' + suffix)
  const data = join(directory, 'postgres-data')
  const cluster = 'closure_' + suffix
  await mkdir(directory, { recursive: false })
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ cluster, purpose: 'isolated-acceptance', pid: process.pid }))
  const envFile = join(directory, 'isolated.env')
  await writeFile(envFile, '# Isolated acceptance configuration only.\n', { flag: 'wx', mode: 0o600 })
  const binary = name => join(resolve(binDirectory), name + (process.platform === 'win32' ? '.exe' : ''))
  const options = { windowsHide: true, env: isolatedEnvironment(), maxBuffer: 4 * 1024 * 1024, timeout: 60000 }
  const password = randomBytes(32).toString('base64url'), passwordFile = join(directory, 'initial-password')
  try {
    await writeFile(passwordFile, password, { flag: 'wx', mode: 0o600 })
    await execute(binary('initdb'), ['-D', data, '-U', 'closure_owner', '--encoding=UTF8', '--locale=C', '--auth-host=scram-sha-256', '--auth-local=trust', '--pwfile=' + passwordFile], options)
  } finally { await rm(passwordFile, { force: true }) }
  let certificate
  if (openssl) {
    certificate = join(data, 'isolated-server.crt')
    const key = join(data, 'isolated-server.key')
    await execute(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', certificate], options)
    await writeFile(join(data, 'postgresql.auto.conf'), "ssl = on" + String.fromCharCode(10) + "ssl_cert_file = 'isolated-server.crt'" + String.fromCharCode(10) + "ssl_key_file = 'isolated-server.key'" + String.fromCharCode(10))
  }
  const reserver = createServer()
  await new Promise((resolve, reject) => { reserver.once('error', reject); reserver.listen(0, '127.0.0.1', resolve) })
  const port = reserver.address().port
  await new Promise(resolve => reserver.close(resolve))
  const canonicalData = await realpath(data)
  let stopped = false
  const stop = async () => {
    if (stopped) return
    assert.equal(await realpath(data), canonicalData)
    assert.equal(dirname(data), directory)
    assert.equal(dirname(directory), parent)
    assert.match(basename(directory), /^closure_verify_[a-f0-9]{32}$/)
    await control(binary('pg_ctl'), ['-D', data, '-w', '-m', 'fast', 'stop'], options)
    stopped = true
  }
  try {
    await control(binary('pg_ctl'), ['-D', data, '-l', join(directory, 'postgres.log'), '-w', 'start', '-o', '-h 127.0.0.1 -p ' + port + ' -c cluster_name=' + cluster], options)
  } catch (error) {
    let running = false
    try { await control(binary('pg_ctl'), ['-D', data, 'status'], options); running = true }
    catch (statusError) { if (statusError.code !== 3) throw new AggregateError([error, statusError], '专用数据库启动失败，状态需人工核对：' + directory) }
    if (running) {
      try { await stop() } catch (stopError) { throw new AggregateError([error, stopError], '专用数据库启动失败且清理未成功：' + directory) }
    }
    throw error
  }
  return {
    directory, data, cluster, port, certificate, database: 'closure_verify_' + suffix,
    connection: { host: '127.0.0.1', port, user: 'closure_owner', password, database: 'postgres', max: 2 },
    env: isolatedEnvironment({ PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'closure_owner', PGPASSWORD: password,
      PGDATABASE: 'closure_verify_' + suffix, ISOLATED_TEST_CLUSTER: cluster, ISOLATED_TEST_ROOT: directory,
      ENV_FILE_PATH: envFile,
      RECRUITING_QUARANTINE_ROOT: join(directory, 'storage'), INTERVIEW_STORAGE_ROOT: join(directory, 'interviews'),
      DB_POOL_MAX: '2', PGCONNECT_TIMEOUT_MS: '1000',
      ISOLATED_ALLOWED_PORTS: String(port), API_SHUTDOWN_TIMEOUT_MS: '2000', WORKER_SHUTDOWN_TIMEOUT_MS: '2000',
    }),
    stop,
  }
}
