import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'

assert.ok(process.argv[2], 'An explicit isolated PostgreSQL bin directory is required')
const instance = await startIsolatedPostgres(process.argv[2])
try {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, instance.env, { TENANT_SCHEMA_ROUTING: 'off' })
  const require = createRequire(join(projectRoot, 'apps/api/package.json'))
  const guard = require(join(projectRoot,'scripts/isolated-network-guard.cjs'))
  const { Pool } = require('pg')
  const { WebSocket, WebSocketServer } = require('ws')
  const { attachBilledStreamGateway } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/interviews/billed-stream-gateway.js')))
  const { loadConfig } = await import(pathToFileURL(join(projectRoot, 'apps/api/dist/src/config.js')))
  const admin = new Pool(instance.connection)
  let pool, server, upstream, stop, created = false
  const clients = new Set()
  const org = randomUUID(), user = randomUUID(), session = randomUUID(), interview = randomUUID()
  const waitFor = async (check, description) => {
    const until = Date.now() + 5000
    while (!await check()) {
      assert.ok(Date.now() < until, description)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  try {
    await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
    pool = new Pool({ ...instance.connection, database: instance.database, max: 5 })
    await pool.query(`CREATE TABLE organizations(id uuid PRIMARY KEY);
      CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean NOT NULL);
      CREATE TABLE organization_members(organization_id uuid,user_id uuid,is_active boolean DEFAULT true,ended_at timestamptz);
      CREATE TABLE sessions(id uuid,user_id uuid,revoked_at timestamptz,expires_at timestamptz);
      CREATE FUNCTION organization_service_available(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true';
      CREATE TABLE interviews(id uuid PRIMARY KEY,organization_id uuid);
      CREATE TABLE interview_live_sessions(id uuid PRIMARY KEY,interview_id uuid,status text);
      CREATE TABLE billing_policy_versions(id integer,config jsonb,created_at timestamptz);
      INSERT INTO billing_policy_versions VALUES(1,'{"limits":{"maxConcurrent":2}}',now());`)
    const migration = await readFile(join(projectRoot, 'db/migrations/0082_billing_audio_trial.sql'), 'utf8')
    const table = migration.match(/CREATE TABLE public\.billing_stream_sources \([\s\S]*?\n\);/)
    assert.ok(table, 'Use the actual production lease table definition')
    await pool.query(table[0])
    await pool.query('INSERT INTO organizations VALUES($1)', [org])
    await pool.query('INSERT INTO users VALUES($1,true)', [user])
    await pool.query('INSERT INTO organization_members(organization_id,user_id) VALUES($1,$2)', [org,user])
    const authSession = randomUUID()
    await pool.query("INSERT INTO sessions VALUES($1,$2,NULL,now()+interval '1 hour')", [authSession,user])
    await pool.query('INSERT INTO interviews VALUES($1,$2)', [interview,org])
    await pool.query("INSERT INTO interview_live_sessions VALUES($1,$2,'recording')", [session,interview])
    upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await once(upstream, 'listening')
    guard.allowLoopbackPort(upstream.address().port)
    upstream.on('connection', remote => {
      remote.send(JSON.stringify({ type: 'status', status: 'ready', heartbeat: true }))
      remote.on('message', (data,binary) => {
        if (binary) remote.send(JSON.stringify({ type: 'partial', text: 'synthetic audio received' }))
        else if (JSON.parse(String(data)).type === 'ping') remote.send(JSON.stringify({ type: 'pong' }))
      })
    })
    server = createServer()
    stop = attachBilledStreamGateway(server, loadConfig(), {
      pool, heartbeatIntervalMs: 100,
      authenticate: async context => { context.auth = { method: 'session',sessionId:authSession,user:{ id:user,name:'synthetic',email:'synthetic@example.invalid',role:'recruiter',workspaceId:org } } },
      resolveEnv: async () => ({}), upstreamUrl: 'ws://127.0.0.1:' + upstream.address().port,
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    guard.allowLoopbackPort(server.address().port)
    const url = 'ws://127.0.0.1:' + server.address().port + '/funasr-stream?sessionId=' + session + '&source=microphone'
    const connect = async (autoPong = true) => {
      const client = new WebSocket(url, { origin:'http://localhost:5174',autoPong })
      clients.add(client);client.on('error',()=>{});client.once('close',()=>clients.delete(client))
      const ready = once(client,'message')
      await once(client,'open')
      const [message] = await ready
      return { client, message:JSON.parse(String(message)) }
    }
    const lease = async () => (await pool.query('SELECT *,lease_until<=now() AS expired FROM billing_stream_sources')).rows[0]
    const first = await connect(false)
    assert.equal(first.message.status,'ready')
    const owner = (await lease()).connection_id
    const duplicate = await connect()
    assert.equal(duplicate.message.code,'STREAM_SOURCE_BUSY')
    assert.equal(duplicate.message.retryable,true)
    assert.equal((await lease()).connection_id,owner)
    console.log('PASS duplicate connections report a retryable reason without stealing a track')
    await waitFor(async()=>first.client.readyState === WebSocket.CLOSED && (await lease()).expired,'half-open source was not released')
    assert.notEqual((await lease()).connection_id,owner)
    assert.equal((await pool.query("UPDATE billing_stream_sources SET lease_until=now()+interval '45 seconds' WHERE connection_id=$1 RETURNING session_id",[owner])).rowCount,0)
    console.log('PASS half-open cleanup fences stale lease renewals in real PostgreSQL')
    for (let attempt=0;attempt<3;attempt++) {
      const replacement = await connect()
      assert.equal(replacement.message.status,'ready')
      const partial = once(replacement.client,'message')
      replacement.client.send(Buffer.alloc(32000))
      const [response] = await partial
      assert.equal(JSON.parse(String(response)).type,'partial')
      await waitFor(async()=>Number((await lease()).end_ms) >= (attempt+1)*1000,'the timeline cursor was not persisted')
      const disconnected = once(replacement.client,'close')
      replacement.client.terminate();await disconnected
      await waitFor(async()=>(await lease()).expired,'replacement lease was not released')
    }
    console.log('PASS three reconnect cycles forward PCM and retain the source timeline')
  } finally {
    for (const client of clients) client.terminate()
    await stop?.()
    if(server) await new Promise(resolve => server.close(resolve))
    if(upstream) await new Promise(resolve => upstream.close(resolve))
    await pool?.end()
    if(created) await admin.query('DROP DATABASE "' + instance.database + '"')
    await admin.end()
  }
} finally { await instance.stop() }
