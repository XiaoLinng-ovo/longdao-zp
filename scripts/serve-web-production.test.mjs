import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer, get as httpGet, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, afterEach } from 'node:test'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createProductionGateway } from './serve-web-production.mjs'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

function listen(server) {
  servers.push(server)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function getText(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpGet({ hostname: '127.0.0.1', port, path, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.on('error', reject)
  })
}

test('serves SPA routes and protects static paths', async () => {
  const staticDir = await mkdtemp(join(tmpdir(), 'smartrecruit-web-'))
  await mkdir(join(staticDir, 'assets'))
  await writeFile(join(staticDir, 'index.html'), '<!doctype html><div id="app">ready</div>')
  await writeFile(join(staticDir, 'assets', 'app-abc123.js'), 'console.log("ready")\n'.repeat(64))
  const gateway = createProductionGateway({ staticDir })
  const port = await listen(gateway)

  const health = await getText(port, '/health')
  assert.equal(health.status, 200)
  assert.equal(health.body.toString(), 'ok\n')
  assert.match(health.headers['content-type'], /text\/plain/)

  const route = await getText(port, '/candidates', { accept: 'text/html' })
  assert.equal(route.status, 200)
  assert.match(route.headers['content-type'], /text\/html/)
  assert.match(route.headers['cache-control'], /no-cache/)
  assert.match(route.body.toString(), /id="app"/)

  const asset = await getText(port, '/assets/app-abc123.js', { 'accept-encoding': 'br' })
  assert.equal(asset.status, 200)
  assert.equal(asset.headers['content-encoding'], 'br')
  assert.match(asset.headers['cache-control'], /immutable/)

  const missing = await getText(port, '/assets/missing.js', { accept: 'text/html' })
  assert.equal(missing.status, 404)
  assert.doesNotMatch(missing.headers['content-type'], /text\/html/)

  const traversal = await getText(port, '/%2e%2e/%2e%2e/package.json', { accept: 'text/html' })
  assert.equal(traversal.status, 404)
})

test('proxies API requests without changing the request path', async () => {
  const api = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      method: req.method,
      url: req.url,
      origin: req.headers.origin || null,
      forwardedFor: req.headers['x-forwarded-for'] || null,
    }))
  })
  const apiPort = await listen(api)
  const gateway = createProductionGateway({ apiTarget: `http://127.0.0.1:${apiPort}` })
  const gatewayPort = await listen(gateway)

  const response = await getText(gatewayPort, '/api/v1/health?check=1', { origin: 'https://example.test' })
  assert.equal(response.status, 200)
  assert.deepEqual(JSON.parse(response.body.toString()), {
    method: 'GET',
    url: '/api/v1/health?check=1',
    origin: 'https://example.test',
    forwardedFor: '127.0.0.1',
  })

  const chained = await getText(gatewayPort, '/api/v1/health?check=2', {
    'x-forwarded-for': '198.51.100.7',
  })
  assert.equal(JSON.parse(chained.body.toString()).forwardedFor, '198.51.100.7, 127.0.0.1')
})

test('compresses API JSON for slow remote clients without changing cookies or payload', async () => {
  const body = JSON.stringify({ ok: true, data: 'report'.repeat(10000) })
  const api = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'set-cookie': 'session=test; HttpOnly', vary: 'Origin' })
    res.end(body)
  })
  const apiPort = await listen(api)
  const port = await listen(createProductionGateway({ apiTarget: `http://127.0.0.1:${apiPort}` }))
  const compressed = await getText(port, '/api/v1/interviews', { 'accept-encoding': 'gzip, br' })
  assert.equal(compressed.status, 200)
  assert.equal(compressed.headers['content-encoding'], 'gzip')
  assert.equal(compressed.headers['content-length'], undefined)
  assert.match(compressed.headers.vary, /Origin, Accept-Encoding/)
  assert.deepEqual(compressed.headers['set-cookie'], ['session=test; HttpOnly'])
  assert.equal(gunzipSync(compressed.body).toString(), body)
  assert.ok(compressed.body.length < Buffer.byteLength(body) / 10)
  for (const headers of [{}, { 'accept-encoding': 'gzip;q=0, br' }]) {
    const plain = await getText(port, '/api/v1/interviews', headers)
    assert.equal(plain.headers['content-encoding'], undefined)
    assert.equal(plain.body.toString(), body)
  }
})

test('does not compress an already encoded API response twice', async () => {
  const body = gzipSync(JSON.stringify({ ok: true }))
  const api = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    res.end(body)
  })
  const apiPort = await listen(api)
  const port = await listen(createProductionGateway({ apiTarget: `http://127.0.0.1:${apiPort}` }))
  const response = await getText(port, '/api/test', { 'accept-encoding': 'gzip' })
  assert.deepEqual(response.body, body)
})

test('forwards request bodies through the API proxy', async () => {
  const api = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.concat(chunks))
    })
  })
  const apiPort = await listen(api)
  const gateway = createProductionGateway({ apiTarget: `http://127.0.0.1:${apiPort}` })
  const gatewayPort = await listen(gateway)
  const payload = Buffer.from('proxy-body')

  const response = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: gatewayPort, path: '/api/upload', method: 'POST', headers: { 'content-length': payload.length } }, (upstream) => {
      const chunks = []
      upstream.on('data', (chunk) => chunks.push(chunk))
      upstream.on('end', () => resolve({ status: upstream.statusCode, body: Buffer.concat(chunks) }))
    })
    request.on('error', reject)
    request.end(payload)
  })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, payload)
})
