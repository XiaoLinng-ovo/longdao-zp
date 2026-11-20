import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

export function attachApiRequestDiagnostics(server, { maxEntries = 5000, evidence = {} } = {}) {
  assert.ok(Number.isInteger(maxEntries) && maxEntries > 0 && maxEntries <= 10000)
  evidence.requests ??= []
  evidence.socketErrors ??= []
  evidence.droppedRequests ??= 0
  evidence.droppedSocketErrors ??= 0
  const sockets = new WeakSet()
  const listener = (request, response) => {
    if (!sockets.has(request.socket)) {
      sockets.add(request.socket)
      request.socket.on('error', error => {
        if (evidence.socketErrors.length >= maxEntries) { evidence.droppedSocketErrors++; return }
        evidence.socketErrors.push({ at: new Date().toISOString(), code: error.code ?? 'SOCKET_ERROR' })
      })
    }
    if (evidence.requests.length >= maxEntries) { evidence.droppedRequests++; return }
    const started = performance.now()
    let path
    try { path = new URL(request.url, 'http://127.0.0.1').pathname }
    catch { path = '[invalid-path]' }
    const record = { method: request.method, path, startedAt: new Date().toISOString(), finished: false, closed: false, aborted: false }
    evidence.requests.push(record)
    response.once('finish', () => {
      record.finished = true
      record.status = response.statusCode
      record.elapsedMs = Math.round(performance.now() - started)
    })
    response.once('close', () => {
      record.closed = true
      record.closedBeforeFinish = !response.writableFinished
      record.elapsedMs = Math.round(performance.now() - started)
    })
    request.once('aborted', () => { record.aborted = true })
  }
  server.prependListener('request', listener)
  return { evidence, detach() { server.removeListener('request', listener) } }
}
