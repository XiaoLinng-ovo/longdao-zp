import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { attachApiRequestDiagnostics } from '../api-request-diagnostics.mjs'

test('请求诊断记录真实完成和中断，不记录正文、请求头或查询凭据，并限制条目', async () => {
  let received
  const pending = new Promise(resolve => { received = resolve })
  const server = createServer((req, res) => {
    if (req.url.startsWith('/slow')) { received(); return }
    req.resume(); req.on('end', () => { res.statusCode = 201; res.end('ok') })
  })
  const diagnostics = attachApiRequestDiagnostics(server, { maxEntries: 2 })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = 'http://127.0.0.1:' + server.address().port
  try {
    const response = await fetch(origin + '/api/v1/save?token=synthetic-query-secret', { method: 'POST', headers: { authorization: 'synthetic-header-secret' }, body: 'synthetic-body-secret' })
    assert.equal(response.status, 201); await response.text()
    const client = request(origin + '/slow'); client.on('error', () => {}); client.end()
    await pending
    client.destroy()
    for (let i = 0; i < 100 && !diagnostics.evidence.requests[1].closed; i++) await delay(5)
    assert.equal(diagnostics.evidence.requests[0].finished, true)
    assert.equal(diagnostics.evidence.requests[0].path, '/api/v1/save')
    assert.equal(diagnostics.evidence.requests[0].status, 201)
    assert.equal(diagnostics.evidence.requests[1].aborted, true)
    assert.equal(diagnostics.evidence.requests[1].closedBeforeFinish, true)
    await (await fetch(origin + '/overflow')).text()
    assert.equal(diagnostics.evidence.requests.length, 2)
    assert.equal(diagnostics.evidence.droppedRequests, 1)
    assert.doesNotMatch(JSON.stringify(diagnostics.evidence), /synthetic-(?:query|header|body)-secret/)
    diagnostics.detach()
    await (await fetch(origin + '/detached')).text()
    assert.equal(diagnostics.evidence.droppedRequests, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('请求诊断拒绝无界或无效的容量设置', () => {
  for (const maxEntries of [0, -1, 10001, Infinity, '2']) assert.throws(() => attachApiRequestDiagnostics(createServer(), { maxEntries }))
})
