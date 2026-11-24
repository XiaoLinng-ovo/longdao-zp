import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isolatedEnvironment, projectRoot } from './isolated-environment.mjs'
import { testCodeFingerprint } from './test-code-fingerprint.mjs'

const arg = process.argv.indexOf('--docker')
assert.ok(arg >= 0 && process.argv[arg + 1], '须显式指定 Docker 可执行文件')
const docker = resolve(process.argv[arg + 1])
const suffix = randomUUID().replaceAll('-', ''), prefix = 'closure_' + suffix
const directory = join(projectRoot, 'tmp', 'closure_verify_' + suffix)
await mkdir(directory, { recursive: false })
const fingerprint = await testCodeFingerprint(projectRoot)
const label = 'smartrecruit.acceptance=' + suffix, image = 'closure-acceptance:' + suffix
const containers = new Set(), volumes = new Set()
const report = { startedAt: new Date().toISOString(), boundary: '白名单构建输入；独立internal网络和临时卷；合成凭据；不挂载业务配置',
  codeFingerprint: fingerprint.sha256, checks: [], failures: [], cleanup: {} }
const password = randomBytes(32).toString('hex'), authSecret = randomBytes(32).toString('hex')
let network = false, imageBuilt = false
const redact = text => String(text).replaceAll(password, '[synthetic-secret]').replaceAll(authSecret, '[synthetic-secret]')
async function command(args, { timeout = 120000, log, includeStderr = false } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(docker, args, { cwd: projectRoot, env: isolatedEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => { stderr += value })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      void (async () => {
        if (log) await writeFile(join(directory, log), redact(stdout + '\n' + stderr))
        if (timedOut || code !== 0 || signal) throw new Error('Docker命令失败：' + args[0] + '；' + redact(stderr).slice(-5000))
        resolveCommand((includeStderr ? stdout + '\n' + stderr : stdout).trim())
      })().catch(reject)
    })
  })
}
const containerLogs = name => command(['logs', name], { includeStderr: true })
async function check(name, action) {
  console.log('验证：' + name)
  const item = { name, startedAt: new Date().toISOString() }; report.checks.push(item)
  try { item.result = await action(); item.passed = true }
  catch (error) { item.passed = false; throw error }
  finally { item.finishedAt = new Date().toISOString() }
}
async function owns(type, name) {
  const args = type === 'container' ? ['inspect', '--format', '{{json .Config.Labels}}', name] : [type, 'inspect', '--format', '{{json .Labels}}', name]
  assert.equal(JSON.parse(await command(args))['smartrecruit.acceptance'], suffix, '禁止操作非本轮资源')
}
async function state(name) { return JSON.parse(await command(['inspect', '--format', '{{json .State}}', name])) }
async function waitFor(action, milliseconds, message) {
  const deadline = Date.now() + milliseconds
  while (true) {
    if (await action()) return
    assert.ok(Date.now() < deadline, message)
    await delay(250)
  }
}
const envFile = join(directory, 'synthetic-runtime.env')
const mount = (source, target) => ['--mount', 'type=bind,source=' + source + ',target=' + target + ',readonly']
const common = () => ['--network', prefix, '--label', label, '--env-file', envFile,
  ...mount(join(projectRoot, 'db/migrations'), '/app/db/migrations'),
  ...mount(join(directory, 'acceptance'), '/acceptance'), '--mount', 'type=volume,source=' + prefix + '_objects,target=/data',
  '--memory', '1g', '--cpus', '2', '--pids-limit', '256']
async function runHelper(mode) {
  const name = prefix + '_helper_' + randomUUID().slice(0, 8); containers.add(name)
  await command(['run', '--name', name, ...common(), image, 'node', '/acceptance/child.mjs', mode], { log: 'helper-' + mode + '.log' })
  const output = await containerLogs(name)
  return JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1))
}
async function startRuntime(mode, expectedHealthy) {
  const name = prefix + '_' + mode + '_' + randomUUID().slice(0, 8); containers.add(name)
  const args = ['run', '-d', '--name', name, ...common(), '-e', 'PGAPPNAME=' + prefix + '_' + mode, image]
  if (mode === 'worker') args.push('node', 'apps/worker/dist/src/index.js')
  await command(args)
  if (!expectedHealthy) {
    await waitFor(async () => !(await state(name)).Running, 45000, '损坏结构下服务未及时拒绝启动')
    const status = await state(name), output = await containerLogs(name)
    await writeFile(join(directory, basename(name) + '.log'), redact(output))
    assert.equal(status.ExitCode, 1); assert.equal(status.OOMKilled, false)
    assert.match(output, /结构契约/)
    return { name, rejected: true, exitCode: status.ExitCode }
  }
  const path = mode === 'worker' ? '/ready' : '/api/v1/ready', port = mode === 'worker' ? 4001 : 3100
  let health
  await waitFor(async () => {
    assert.equal((await state(name)).Running, true, '容器提前退出：' + await containerLogs(name))
    try {
      const output = await command(['exec', name, 'node', '-e',
        `fetch('http://127.0.0.1:${port}${path}').then(async r=>{if(!r.ok)process.exitCode=1;console.log(JSON.stringify({status:r.status,body:await r.json()}))}).catch(()=>{process.exitCode=1})`])
      health = JSON.parse(output); return true
    } catch { return false }
  }, 45000, '正式容器入口未就绪')
  if (mode === 'worker') assert.equal(health.body.externalDependencies.postgres, 'ok')
  return { name, health }
}
async function stopRuntime(runtime) {
  await owns('container', runtime.name)
  const started = Date.now()
  await command(['stop', '--time', '15', runtime.name])
  const stopped = await state(runtime.name)
  const output = await containerLogs(runtime.name)
  await writeFile(join(directory, runtime.name + '.log'), redact(output))
  assert.equal(stopped.ExitCode, 0); assert.equal(stopped.OOMKilled, false)
  assert.equal(stopped.Running, false)
  assert.doesNotMatch(output, /Failed to|关闭失败|回收失败|Error:/)
  return { exitCode: stopped.ExitCode, elapsedMs: Date.now() - started, oomKilled: stopped.OOMKilled }
}
try {
  await check('Docker引擎可用且白名单上下文不包含业务配置', async () => {
    const engine = await command(['info', '--format', '{{json .ServerVersion}}'])
    const context = join(directory, 'build-context'); await mkdir(context)
    const source = await readFile(join(projectRoot, 'deploy/Dockerfile.api'), 'utf8')
    const inputs = new Set(source.split(/\r?\n/).filter(line => line.startsWith('COPY ')).flatMap(line => line.trim().split(/\s+/).slice(1, -1)))
    const copied = []
    for (const input of inputs) {
      assert.ok(/^(?:package\.json|pnpm-(?:lock\.yaml|workspace\.yaml)|apps\/(?:api|worker)\/|packages\/|web\/package\.json)/.test(input))
      const parent = dirname(input), name = basename(input)
      const candidates = name.includes('*') ? (await readdir(join(projectRoot, parent))).filter(item => new RegExp('^' + name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(item)).map(item => join(parent, item)) : [input]
      for (const path of candidates) {
        const from = resolve(projectRoot, path), to = resolve(context, path)
        assert.ok(from.startsWith(projectRoot + sep) && to.startsWith(context + sep))
        await mkdir(dirname(to), { recursive: true })
        await cp(from, to, { recursive: true, filter: file => {
          assert.ok(!file.split(/[\\/]/).some(part => ['node_modules', '.git', 'dist', 'data', 'storage'].includes(part)))
          assert.ok(!basename(file).startsWith('.') && !/\.(?:env|pem|key|dump|backup|sqlite|db)$/.test(file))
          return true
        } })
        copied.push(relative(context, to))
      }
    }
    await copyFile(join(projectRoot, 'deploy/Dockerfile.api'), join(context, 'Dockerfile'))
    await command(['build', '--force-rm', '--label', label, '-t', image, '-f', join(context, 'Dockerfile'), context], { timeout: 1200000, log: 'image-build.log' })
    imageBuilt = true
    return { engine: JSON.parse(engine), inputs: copied, imageId: await command(['image', 'inspect', '--format', '{{.Id}}', image]) }
  })
  await check('专用internal网络和临时卷隔绝业务及公网', async () => {
    await command(['network', 'create', '--internal', '--label', label, prefix]); network = true
    for (const purpose of ['postgres', 'objects']) {
      const name = prefix + '_' + purpose
      await command(['volume', 'create', '--label', label, name]); volumes.add(name)
    }
    assert.equal(await command(['network', 'inspect', '--format', '{{.Internal}}', prefix]), 'true')
    const acceptance = join(directory, 'acceptance'); await mkdir(acceptance)
    await copyFile(join(projectRoot, 'scripts/container-acceptance-child.mjs'), join(acceptance, 'child.mjs'))
    const partial = join(acceptance, 'migrations-through-74'); await mkdir(partial)
    for (const name of (await readdir(join(projectRoot, 'db/migrations'))).filter(name => name.endsWith('.sql') && name < '0075_')) await copyFile(join(projectRoot, 'db/migrations', name), join(partial, name))
    await writeFile(envFile, Object.entries({ NODE_ENV: 'production', CONTAINER_ACCEPTANCE: 'isolated-synthetic',
      PGHOST: prefix + '_postgres', PGPORT: '5432', PGUSER: 'closure_owner', PGDATABASE: prefix, PGPASSWORD: password,
      POSTGRES_USER: 'closure_owner', POSTGRES_DB: prefix, POSTGRES_PASSWORD: password,
      DB_POOL_MAX: '2', TENANT_SCHEMA_ROUTING: 'on', WORKER_DB_POLL: 'true', WORKER_USE_LLM_ANALYSIS: 'false',
      WORKER_HEALTH_HOST: '0.0.0.0', HOST: '0.0.0.0', RECRUITING_QUARANTINE_ROOT: '/data/resumes',
      AUTH_OTP_HMAC_SECRET: authSecret, SYSTEM_ADMIN_USER_NO: '70000001',
      QUESTION_SHEET_POLL: 'off', INTERVIEW_AUDIO_POLL: 'off', INTERVIEW_QUESTION_PREPARATION_POLL: 'off',
      INTERVIEW_TRANSCRIPT_POSTPROCESS_POLL: 'off', INTERVIEW_SUMMARY_POLL: 'off', OBJECT_CLEANUP_POLL: 'off',
      RESUME_VIRUS_SCAN_ENABLED: 'false', RESUME_LOCAL_OCR_ENABLED: 'false',
      API_SHUTDOWN_TIMEOUT_MS: '10000', WORKER_SHUTDOWN_TIMEOUT_MS: '10000',
    }).map(([key, value]) => key + '=' + value).join('\n') + '\n', { flag: 'wx', mode: 0o600 })
    const name = prefix + '_postgres'; containers.add(name)
    await command(['run', '-d', '--name', name, '--network', prefix, '--label', label, '--env-file', envFile,
      '--mount', 'type=volume,source=' + name + ',target=/var/lib/postgresql/data', '--memory', '1g', '--cpus', '2',
      'postgres:16-alpine', '-c', 'cluster_name=' + prefix])
    await waitFor(async () => {
      try { await command(['exec', name, 'pg_isready', '-U', 'closure_owner', '-d', prefix]); return true } catch { return false }
    }, 60000, '专用PG16未就绪')
    return { internal: true, noPublishedPorts: true, noBusinessEnvironmentMounted: true }
  })
  await check('PG16真实迁移历史公司升级与固定结构契约兼容', () => runHelper('prepare'))
  let api, worker
  await check('正式生产入口API和Worker就绪', async () => {
    api = await startRuntime('api', true); worker = await startRuntime('worker', true)
    return { api, worker }
  })
  await check('SIGTERM自然退出且无残留连接', async () => {
    const workerExit = await stopRuntime(worker), apiExit = await stopRuntime(api)
    return { workerExit, apiExit, database: await runHelper('connections') }
  })
  await check('结构损坏时两个正式入口拒绝启动且完整回收', async () => {
    await runHelper('damage')
    try {
      const rejectedApi = await startRuntime('api', false), rejectedWorker = await startRuntime('worker', false)
      return { api: rejectedApi, worker: rejectedWorker, database: await runHelper('connections') }
    } finally { await runHelper('restore') }
  })
  await check('结构恢复后可以再次启动和关闭', async () => {
    const restoredApi = await startRuntime('api', true), restoredWorker = await startRuntime('worker', true)
    return { workerExit: await stopRuntime(restoredWorker), apiExit: await stopRuntime(restoredApi), database: await runHelper('connections') }
  })
  report.passed = true
} catch (error) {
  report.passed = false; process.exitCode = 1
  report.failures.push({ name: error.name, message: redact(error.message), stack: redact(error.stack) })
  console.error('容器验收失败：' + redact(error.message))
} finally {
  const cleanup = async (name, action) => {
    try { await action(); report.cleanup[name] = true }
    catch (error) { report.passed = false; process.exitCode = 1; report.cleanup[name] = false; report.failures.push({ cleanup: name, message: redact(error.message) }) }
  }
  for (const name of [...containers].reverse()) await cleanup(name, async () => {
    await owns('container', name)
    await writeFile(join(directory, name + '.log'), redact(await containerLogs(name)))
    await command(['rm', '-f', name])
  })
  for (const name of volumes) await cleanup(name, async () => { await owns('volume', name); await command(['volume', 'rm', name]) })
  if (network) await cleanup('networkRemoved', async () => { await owns('network', prefix); await command(['network', 'rm', prefix]) })
  if (imageBuilt) await cleanup('imageRemoved', async () => {
    assert.equal(JSON.parse(await command(['image', 'inspect', '--format', '{{json .Config.Labels}}', image]))['smartrecruit.acceptance'], suffix)
    await command(['image', 'rm', image])
  })
  await cleanup('syntheticEnvRemoved', () => rm(envFile, { force: true }))
  await cleanup('codeUnchanged', async () => assert.equal((await testCodeFingerprint(projectRoot)).sha256, fingerprint.sha256))
  report.finishedAt = new Date().toISOString()
  const output = join(directory, 'container-runtime-report.json')
  await writeFile(output, JSON.stringify(report, null, 2)); console.log('报告：' + output)
}
