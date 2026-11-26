import assert from 'node:assert/strict'
import { request } from 'node:http'
import { test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { HealthStateStore, createHealthServer } from '../src/health.js'

test('畸形 Host 返回 400，后续健康检查仍可用', async () => {
  const state = new HealthStateStore(loadConfig({}, 'test-host'))
  state.setState('ready')
  const server = createHealthServer(state)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    for (let i = 0; i < 3; i++) {
      const code = await new Promise(resolve => {
        const req = request({ host: '127.0.0.1', port: address.port, path: '/health', headers: { Host: '[' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
        req.on('error', resolve); req.end()
      })
      assert.equal(code, 400)
    }
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/ready`)).status, 200)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
