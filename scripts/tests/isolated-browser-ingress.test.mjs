import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { ephemeralLoopbackPort, isolatedBrowserIngress } from '../isolated-browser-ingress.mjs'

test('临时前端入站校验先于业务执行，不接收其他本机页面请求', async () => {
  const ingress = isolatedBrowserIngress()
  let reached = 0
  const server = createServer((req, res) => ingress.middleware(req, res, () => { reached++; res.end('actual handler') }))
  server.prependListener('upgrade', ingress.upgrade)
  server.listen(await ephemeralLoopbackPort(), '127.0.0.1'); await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  try {
    for (const headers of [{}, { 'x-closure-browser-ingress': 'wrong' }, { cookie: 'closure_browser_ingress=wrong' }]) {
      const response = await fetch(origin + '/api/v1/workspaces', { headers }); assert.equal(response.status, 403); await response.text()
    }
    const cookie = ingress.cookie(origin)
    for (const headers of [ingress.requestHeaders, { cookie: cookie.name + '=' + cookie.value }]) {
      const response = await fetch(origin, { headers }); assert.equal(response.status, 200); assert.equal(await response.text(), 'actual handler')
    }
    await new Promise((resolve, reject) => {
      const req = request(origin, { headers: { connection: 'Upgrade', upgrade: 'websocket' } }, res => { assert.equal(res.statusCode, 403); res.resume(); res.once('end', resolve) })
      req.once('error', reject); req.end()
    })
    assert.equal(reached, 2); assert.deepEqual(ingress.evidence, { rejectedHttp: 3, rejectedUpgrades: 1 })
    let denied = false
    ingress.middleware({ headers: { 'x-closure-browser-ingress': '汉'.repeat(64) } }, { writeHead() {}, end() { denied = true } }, () => assert.fail('非法值不能进入业务'))
    assert.equal(denied, true)
    assert.doesNotMatch(JSON.stringify(ingress.evidence), /[a-f0-9]{64}/)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
