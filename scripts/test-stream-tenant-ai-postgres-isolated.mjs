import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { EnterpriseAiStore, PlatformAiStore } from '../packages/enterprise-ai/index.js'

assert.ok(process.argv[2], 'Explicit isolated PostgreSQL bin directory required; no business fallback')
const instance = await startIsolatedPostgres(process.argv[2])
const expectRegression = process.argv.includes('--expect-regression')
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env, {
  NODE_ENV: 'production', TENANT_SCHEMA_ROUTING: 'on',
  AI_CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  AI_ALLOWED_BASE_URL_ORIGINS: 'https://synthetic.example.invalid',
})
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const guard = require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
const { Pool } = require('pg')
const { WebSocket, WebSocketServer } = require('ws')
const load = name => import(pathToFileURL(join(projectRoot, 'apps/api/dist/src', name + '.js')).href)
const { runMigrations } = await load('db/migrations')
const { bindTenantSearchPath } = await load('db/connection')
const { runWithTenantContext, organizationSchemaName, currentTenantContext } = await load('db/tenant-context')
const { attachBilledStreamGateway } = await load('interviews/billed-stream-gateway')
const { loadConfig } = await load('config')
const admin = new Pool(instance.connection)
const fixtures = []
const clients = new Set()
const report = { passed: false, regressionMode: expectRegression, checks: [], externalCalls: false, businessDatabaseTouched: false }
let pool, server, upstream, stop, upstreamConnections = 0
const inside = (f, action) => runWithTenantContext({ organizationId: f.org, schemaName: f.schema }, action)
const store = () => new EnterpriseAiStore(pool)
const waitFor = async (check, message) => {
  const until = Date.now() + 5000
  while (!await check()) {
    assert.ok(Date.now() < until, message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
try {
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"')
  pool = bindTenantSearchPath(new Pool({ ...instance.connection, database: instance.database, max: 8 }))
  await runMigrations(pool, join(projectRoot, 'db/migrations'))
  for (const source of ['enterprise', 'enterprise', 'platform']) {
    const f = Object.fromEntries(['org', 'user', 'authSession', 'candidate', 'job', 'application', 'interview', 'session'].map(key => [key, randomUUID()]))
    f.schema = organizationSchemaName(f.org)
    f.model = source === 'platform' ? 'synthetic-platform-model' : 'synthetic-model-' + f.org
    f.source = source
    fixtures.push(f)
    await pool.query("INSERT INTO public.users(id,email,display_name) VALUES($1,$2,'synthetic-stream-user')", [f.user, f.user + '@example.invalid'])
    await pool.query("INSERT INTO public.organizations(id,name,kind,service_status,use_platform_ai,ai_model_source) VALUES($1,$2,'test','enabled',$3,$4)", [f.org, 'synthetic-stream-' + f.org, source === 'platform', source])
    await pool.query("INSERT INTO public.organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')", [f.org, f.user])
    await pool.query("INSERT INTO public.sessions(id,user_id,token_hash,csrf_token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')", [f.authSession, f.user, randomUUID(), randomUUID()])
    await pool.query('SELECT public.initialize_organization_schema($1)', [f.org])
    await inside(f, async () => {
      await pool.query("INSERT INTO candidates(id,organization_id,candidate_no,name) VALUES($1,$2,$3,'synthetic')", [f.candidate, f.org, f.candidate])
      await pool.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount) VALUES($1,$2,$3,'synthetic',1)", [f.job, f.org, f.job])
      await pool.query("INSERT INTO applications(id,organization_id,application_no,candidate_id,job_id,status) VALUES($1,$2,$3,$4,$5,'interviewing')", [f.application, f.org, f.application, f.candidate, f.job])
      await pool.query("INSERT INTO interviews(id,organization_id,application_id,interview_no,round,stage,type,title) VALUES($1,$2,$3,$4,1,'initial','technical','synthetic')", [f.interview, f.org, f.application, f.interview])
      await pool.query("INSERT INTO interview_live_sessions(id,organization_id,interview_id,created_by) VALUES($1,$2,$3,$4)", [f.session, f.org, f.interview, f.user])
      if (source === 'enterprise') await store().saveSelfService(f.org, { OPENAI_API_KEY: 'synthetic-secret-' + f.org, OPENAI_MODEL: f.model }, f.user)
    })
  }
  await new PlatformAiStore(pool).save({ OPENAI_BASE_URL: 'https://synthetic.example.invalid/v1', OPENAI_API_KEY: 'synthetic-platform-secret', OPENAI_MODEL: fixtures[2].model }, fixtures[2].user)
  for (const f of fixtures) {
    await inside(f, async () => {
      assert.equal((await store().runtimeEnv(f.org)).OPENAI_MODEL, f.model)
      const view = await store().getSelfService(f.org)
      assert.equal(view.modelSource, f.source)
      if (f.source === 'enterprise') assert.equal(view.apiKeyConfigured, true)
      else assert.equal(view.platformAuthorized, true)
    })
  }
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.enterprise_ai_settings')).rows[0].n, 0)
  report.checks.push('real enterprise settings resolve correctly in each company schema; no legacy public credentials exist')
  console.log('PASS saved enterprise and platform configurations resolve in the normal tenant context')

  upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(upstream, 'listening')
  guard.allowLoopbackPort(upstream.address().port)
  upstream.on('connection', remote => {
    upstreamConnections++
    remote.send(JSON.stringify({ type: 'status', status: 'ready', heartbeat: true }))
    remote.on('message', (data, binary) => {
      if (binary) remote.send(JSON.stringify({ type: 'partial', text: 'synthetic transcription' }))
    })
  })
  server = createServer()
  stop = attachBilledStreamGateway(server, loadConfig(), {
    pool, upstreamUrl: 'ws://127.0.0.1:' + upstream.address().port,
    // Synthetic authentication only; the gateway still checks real memberships, sessions and interviews.
    authenticate: async context => {
      const f = fixtures.find(f => f.org === context.req.headers['x-test-organization'])
      assert.ok(f)
      context.auth = { method: 'session', sessionId: f.authSession, user: { id: f.user, name: 'synthetic', email: 'synthetic@example.invalid', role: 'recruiter', workspaceId: f.org } }
    },
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  guard.allowLoopbackPort(server.address().port)
  const connect = async (f, source, { session = f.session, https = false } = {}) => {
    const client = new WebSocket('ws://127.0.0.1:' + server.address().port + '/funasr-stream?sessionId=' + session + '&source=' + source, {
      origin: https ? 'https://stream.example.invalid' : 'http://127.0.0.1:' + server.address().port,
      headers: { 'x-test-organization': f.org, ...(https ? { host: 'stream.example.invalid', 'x-forwarded-proto': 'https' } : {}) },
    })
    clients.add(client); client.on('error', () => undefined); client.once('close', () => clients.delete(client))
    const [raw] = await once(client, 'message')
    return { client, message: JSON.parse(String(raw)) }
  }
  if (expectRegression) {
    for (const source of ['microphone', 'meeting']) {
      const { client, message } = await connect(fixtures[0], source)
      assert.equal(message.code, 'ENTERPRISE_AI_NOT_CONFIGURED')
      assert.equal(message.message, '请联系企业管理员配置 AI 模型，或选择已获平台授权的模型')
      assert.equal(message.retryable, false)
      client.terminate()
    }
    assert.equal(upstreamConnections, 0)
    report.checks.push('old gateway reproduces the exact screenshot error for both sources before reaching ASR')
    console.log('PASS reproduced ENTERPRISE_AI_NOT_CONFIGURED for both audio sources against real PostgreSQL')
  } else {
    for (const f of fixtures) {
      await Promise.all(['microphone', 'meeting'].map(async source => {
        const { client, message } = await connect(f, source, { https: true })
        assert.equal(message.status, 'ready', JSON.stringify(message))
        const response = once(client, 'message')
        client.send(Buffer.alloc(32000))
        const [partial] = await response
        assert.equal(JSON.parse(String(partial)).text, 'synthetic transcription')
        client.terminate()
      }))
    }
    await waitFor(async () => (await pool.query("SELECT count(*)::int AS n FROM public.billing_tasks WHERE state='settled'")).rows[0].n === 6, 'audio accounting did not settle')
    await waitFor(async () => (await pool.query('SELECT count(*)::int AS n FROM public.billing_stream_sources WHERE lease_until>now()')).rows[0].n === 0, 'track leases were not released')
    report.checks.push('two distinct enterprise keys and a platform-authorized enterprise both forward microphone and meeting PCM through HTTPS-proxy-origin handshakes; six audio tasks settle')
    const reconnected = await connect(fixtures[0], 'microphone')
    assert.equal(reconnected.message.status, 'ready')
    reconnected.client.terminate()
    report.checks.push('manual reconnection succeeds after release')

    const publicKeyBefore = (await pool.query('SELECT count(*)::int AS n FROM public.enterprise_ai_settings')).rows[0].n
    await inside(fixtures[0], () => store().saveSelfService(fixtures[0].org, { OPENAI_API_KEY: '' }, fixtures[0].user))
    const before = upstreamConnections
    for (const source of ['microphone', 'meeting']) {
      const missing = await connect(fixtures[0], source)
      assert.equal(missing.message.code, 'ENTERPRISE_AI_NOT_CONFIGURED')
      missing.client.terminate()
    }
    await pool.query('UPDATE public.organizations SET use_platform_ai=false WHERE id=$1', [fixtures[2].org])
    const denied = await connect(fixtures[2], 'microphone')
    assert.equal(denied.message.code, 'ENTERPRISE_AI_NOT_CONFIGURED')
    denied.client.terminate()
    assert.equal(upstreamConnections, before)
    assert.equal(publicKeyBefore, 0)
    assert.equal(currentTenantContext(), undefined)
    report.checks.push('missing credentials and revoked platform authorization still fail closed; no global fallback or context leakage')
    console.log('PASS tenant configuration, both audio sources, HTTPS proxy origin, PCM forwarding, accounting, reconnection and authorization checks')
  }
  report.passed = true
} finally {
  try {
    for (const client of clients) client.terminate()
    await stop?.()
    if (server) await new Promise(resolve => server.close(resolve))
    if (upstream) await new Promise(resolve => upstream.close(resolve))
    await pool?.end()
    await admin.end()
  } finally {
    await instance.stop()
    report.postgresStopped = true
    await writeFile(join(instance.directory, 'stream-tenant-ai-report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ ...report, reportPath: join(instance.directory, 'stream-tenant-ai-report.json') }, null, 2))
  }
}
