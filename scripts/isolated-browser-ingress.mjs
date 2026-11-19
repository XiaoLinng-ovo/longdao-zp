import assert from 'node:assert/strict'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:net'

export async function ephemeralLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

export function isolatedBrowserIngress() {
  const secret = randomBytes(32).toString('hex'), cookieName = 'closure_browser_ingress'
  const requestHeaders = { 'x-closure-browser-ingress': secret }
  const evidence = { rejectedHttp: 0, rejectedUpgrades: 0 }
  const authorized = request => {
    const cookie = String(request.headers.cookie ?? '').split(';').map(part => part.trim())
      .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    const candidate = request.headers['x-closure-browser-ingress'] ?? cookie
    return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate)
      && timingSafeEqual(Buffer.from(candidate), Buffer.from(secret))
  }
  const middleware = (request, response, next) => {
    if (authorized(request)) { next(); return }
    evidence.rejectedHttp++
    response.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    response.end('Isolated acceptance requests only')
  }
  const upgrade = (request, socket) => {
    if (authorized(request)) return
    evidence.rejectedUpgrades++
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  }
  return { evidence, requestHeaders, middleware, upgrade,
    cookie(origin) { assert.equal(new URL(origin).hostname, '127.0.0.1'); return { name: cookieName, value: secret, url: origin, httpOnly: true, sameSite: 'Strict' } },
    plugin: { name: 'isolated-browser-ingress', configureServer(server) {
      server.middlewares.use(middleware)
      server.httpServer.prependListener('upgrade', upgrade)
    } },
  }
}
