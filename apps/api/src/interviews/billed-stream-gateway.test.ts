import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import type { Pool } from 'pg'
import { loadConfig } from '../config.js'
import { attachBilledStreamGateway } from './billed-stream-gateway.js'

test('流式连接在企业结构缺失时拒绝，不查询历史业务表或认领额度', async () => {
  const previous = process.env.TENANT_SCHEMA_ROUTING
  process.env.TENANT_SCHEMA_ROUTING = 'on'
  const calls: string[] = []
  const server = createServer()
  attachBilledStreamGateway(server, loadConfig(), {
    pool: { query: async (sql: string) => { calls.push(sql); return { rows: [] } } } as unknown as Pool,
    authenticate: async context => { context.auth = { method: 'session', sessionId: 's', user: { id: 'u', name: '测试', email: 'a@example.invalid', departmentId: 'd', role: 'recruiter', workspaceId: '11111111-1111-4111-8111-111111111111' } } },
    resolveEnv: async () => { assert.fail('不得解析收费配置') },
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  try {
    const code = await new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: address.port, path: '/funasr-stream?sessionId=22222222-2222-4222-8222-222222222222&source=microphone', headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'http://localhost:5174' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', resolve); req.end()
    })
    assert.equal(code, 403)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!, /organization_schema_structure_ready/)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous === undefined) delete process.env.TENANT_SCHEMA_ROUTING; else process.env.TENANT_SCHEMA_ROUTING = previous
  }
})

const authenticate: NonNullable<Parameters<typeof attachBilledStreamGateway>[2]>['authenticate'] = async context => {
  context.auth = { method: 'session', sessionId: 's', user: { id: 'u', name: '测试', email: 'a@example.invalid', departmentId: 'd', role: 'recruiter', workspaceId: '11111111-1111-4111-8111-111111111111' } }
}
const streamPath = '/funasr-stream?sessionId=22222222-2222-4222-8222-222222222222&source=microphone'
test('production streaming accepts new same-origin domains but rejects foreign and missing origins', async () => {
  const keys = ['NODE_ENV', 'ALLOWED_ORIGINS'] as const
  const previous = new Map(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { NODE_ENV: 'production', ALLOWED_ORIGINS: '' })
  const server = createServer()
  let authenticated = 0
  const stop = attachBilledStreamGateway(server, loadConfig(), {
    pool: { query: async () => assert.fail('origin probes must not access billing') } as unknown as Pool,
    authenticate: async () => { authenticated++; throw new Error('stop after origin check') },
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    for (const origin of ['https://new-stream.trycloudflare.com', 'https://stream.example.test:8443']) {
      for (const source of [origin, 'https://attacker.invalid', undefined]) {
        const before = authenticated
        await new Promise<void>((resolve, reject) => {
          const req = request({ hostname: '127.0.0.1', port: address.port, path: streamPath, headers: {
            Connection: 'Upgrade', Upgrade: 'websocket', host: new URL(origin).host,
            'x-forwarded-proto': 'https', ...(source ? { origin: source } : {}),
          } }, res => { res.resume(); res.on('end', resolve) })
          req.on('error', reject); req.end()
        })
        assert.equal(authenticated - before, source === origin ? 1 : 0)
      }
    }
  } finally {
    await stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

function streamPool() {
  const calls: string[] = []
  const query = async (sql: string) => {
    calls.push(sql)
    if (sql.includes('billing_policy_versions')) return { rows: [{ id: 1, config: { limits: { maxConcurrent: 2 } } }] }
    if (sql.includes('count(DISTINCT')) return { rows: [{ n: 0 }] }
    if (sql.includes('INSERT INTO public.billing_stream_sources')) return { rows: [{ end_ms: 0 }] }
    return { rows: [{ id: 'synthetic', session_id: 'synthetic' }] }
  }
  return { calls, pool: { query, connect: async () => ({ query, release() {} }), end: async () => { assert.fail('不得关闭调用方持有的池') } } as unknown as Pool }
}
test('关闭等待鉴权完成，立即断开待升级连接，不再认领租约', async () => {
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const server = createServer(), fake = streamPool()
  const stop = attachBilledStreamGateway(server, loadConfig(), { pool: fake.pool, authenticate: async context => { entered(); await waiting; await authenticate!(context) } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const client = new WebSocket('ws://127.0.0.1:' + address.port + streamPath, { origin: 'http://localhost:5174' })
  client.on('error', () => undefined)
  const disconnected = new Promise<void>(resolve => client.once('close', () => resolve()))
  try {
    await started
    let drained = false
    const closing = stop().then(() => { drained = true })
    await disconnected
    assert.equal(drained, false)
    assert.equal(fake.calls.length, 0)
    finish(); await closing
    assert.equal(fake.calls.length, 0)
  } finally { finish(); await stop(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('活动实时连接关闭时断开本地上游并且仅释放一次租约', async () => {
  const previous = process.env.TENANT_SCHEMA_ROUTING
  process.env.TENANT_SCHEMA_ROUTING = 'off'
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(upstream, 'listening')
  const upstreamAddress = upstream.address(); assert.ok(upstreamAddress && typeof upstreamAddress !== 'string')
  const upstreamConnected = once(upstream, 'connection')
  const server = createServer(), fake = streamPool()
  const stop = attachBilledStreamGateway(server, loadConfig(), { pool: fake.pool, authenticate, resolveEnv: async () => ({}), upstreamUrl: 'ws://127.0.0.1:' + upstreamAddress.port })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const client = new WebSocket('ws://127.0.0.1:' + address.port + streamPath, { origin: 'http://localhost:5174' })
  client.on('error', () => undefined)
  try {
    await once(client, 'open')
    const [remote] = await upstreamConnected as [WebSocket]
    const remoteClosed = once(remote, 'close'), clientClosed = once(client, 'close')
    const closing = stop(); assert.equal(stop(), closing)
    await Promise.all([closing, remoteClosed, clientClosed])
    assert.equal(fake.calls.filter(sql => sql.includes('SET lease_until=now() WHERE')).length, 1)
  } finally {
    client.terminate(); await stop()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    if(previous === undefined)delete process.env.TENANT_SCHEMA_ROUTING;else process.env.TENANT_SCHEMA_ROUTING = previous
  }
})
