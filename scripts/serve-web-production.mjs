import { createReadStream, existsSync, promises as fs } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { extname, join, normalize, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompress, createGzip } from 'node:zlib'
import { promisify } from 'node:util'

const brotliCompressAsync = promisify(brotliCompress)
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const staticRoot = resolve(process.env.WEB_STATIC_DIR || join(root, 'web', 'dist'))
const host = process.env.WEB_HOST || '127.0.0.1'
const port = Number(process.env.WEB_PORT || 5180)
const apiTarget = new URL(process.env.WEB_API_TARGET || 'http://127.0.0.1:3100')

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const compressibleTypes = new Set([
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'image/svg+xml',
  'text/css',
  'text/html',
  'text/javascript',
  'text/plain',
])

function forwardedHeaders(req, target, { websocket = false } = {}) {
  const headers = { ...req.headers }
  const remoteAddress = req.socket.remoteAddress?.trim()
  if (remoteAddress) {
    const incoming = Array.isArray(headers['x-forwarded-for'])
      ? headers['x-forwarded-for'].join(', ')
      : headers['x-forwarded-for']?.trim()
    headers['x-forwarded-for'] = incoming ? `${incoming}, ${remoteAddress}` : remoteAddress
  }
  headers.host = target.host
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'http'
  if (websocket) {
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
  }
  return headers
}

function proxyHttp(req, res, target = apiTarget) {
  const targetUrl = new URL(req.url || '/', target)
  const targetPath = targetUrl.pathname + targetUrl.search
  const proxy = httpRequest({
    hostname: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: targetPath,
    headers: forwardedHeaders(req, target),
  }, (upstream) => {
    // API list responses can contain large reports; compress them for remote clients.
    const acceptsGzip = String(req.headers['accept-encoding'] || '').split(',').some((item) => {
      const [encoding, ...params] = item.trim().split(';')
      const quality = params.find((param) => param.trim().startsWith('q='))
      return encoding === 'gzip' && (!quality || Number(quality.trim().slice(2)) > 0)
    })
    if (req.method !== 'HEAD' && acceptsGzip && !upstream.headers['content-encoding'] &&
        String(upstream.headers['content-type'] || '').includes('application/json') &&
        !upstream.headers['content-range'] && ![204, 304].includes(upstream.statusCode)) {
      const { 'content-length': _length, ...headers } = upstream.headers
      headers['content-encoding'] = 'gzip'
      headers.vary = headers.vary ? `${headers.vary}, Accept-Encoding` : 'Accept-Encoding'
      res.writeHead(upstream.statusCode || 502, headers)
      const gzip = createGzip()
      upstream.on('error', (error) => res.destroy(error))
      gzip.on('error', (error) => res.destroy(error))
      upstream.pipe(gzip).pipe(res)
      return
    }
    res.writeHead(upstream.statusCode || 502, upstream.headers)
    upstream.pipe(res)
  })
  proxy.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: 'API_PROXY_ERROR', message: error.message }))
  })
  req.pipe(proxy)
}

function proxyWebSocket(req, socket, head, targetBase = apiTarget) {
  let incoming
  try { incoming = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`) }
  catch { socket.destroy(); return }
  const targetPath = `/funasr-stream${incoming.search}`
  const target = netConnect({ host: targetBase.hostname, port: Number(targetBase.port || 80) }, () => {
    const requestLines = [`GET ${targetPath} HTTP/1.1`]
    const headers = forwardedHeaders(req, targetBase, { websocket: true })
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) requestLines.push(`${name}: ${value.join(', ')}`)
      else if (value !== undefined) requestLines.push(`${name}: ${value}`)
    }
    target.write(`${requestLines.join('\r\n')}\r\n\r\n`)
    if (head.length) target.write(head)
    target.pipe(socket)
    socket.pipe(target)
  })
  target.on('error', () => socket.destroy())
  socket.on('error', () => target.destroy())
}

function safeStaticPath(requestPath, rootDir = staticRoot) {
  let pathname
  try {
    pathname = decodeURIComponent(requestPath.split('?')[0] || '/')
  } catch {
    return null
  }
  const candidate = resolve(rootDir, `.${normalize(pathname)}`)
  const relativePath = relative(rootDir, candidate)
  if (relativePath.startsWith('..') || relativePath.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null
  return candidate
}

function acceptsHtml(req) {
  return req.headers.accept?.includes('text/html') && !extname((req.url || '').split('?')[0])
}

function cacheHeaders(filePath, rootDir = staticRoot) {
  const relativePath = relative(rootDir, filePath).replaceAll('\\', '/')
  if (relativePath === 'index.html') return { 'cache-control': 'no-cache' }
  if (relativePath.startsWith('assets/') && /-[A-Za-z0-9_-]{6,}\.(?:css|js)$/u.test(relativePath)) {
    return { 'cache-control': 'public, max-age=31536000, immutable' }
  }
  return { 'cache-control': 'no-cache' }
}

async function sendStatic(req, res, rootDir = staticRoot) {
  const requested = safeStaticPath(req.url || '/', rootDir)
  if (!requested) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Bad request')
    return
  }
  let filePath = requested
  let assetRoot = rootDir
  try {
    const info = await fs.stat(filePath)
    if (!info.isFile()) throw new Error('not a file')
  } catch {
    // Open tabs may still lazy-load hashed chunks from the last two releases.
    const assetRequest = (req.url || '').split('?')[0]
    if (/^\/assets\/[A-Za-z0-9_./-]+-[A-Za-z0-9_-]{6,}\.(?:js|css|png|jpg|jpeg|gif|svg|webp|woff2?|ico|mp3|wav)$/u.test(assetRequest)) {
      for (const generation of [1, 2]) {
        const previousRoot = join(rootDir, 'previous-assets', String(generation))
        const previousPath = safeStaticPath(assetRequest, previousRoot)
        if (!previousPath) continue
        try {
          if (!(await fs.stat(previousPath)).isFile()) continue
          filePath = previousPath
          assetRoot = previousRoot
          break
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error }
      }
    }
    if (filePath === requested) {
      if (!acceptsHtml(req)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' })
        res.end('Not found')
        return
      }
      filePath = join(rootDir, 'index.html')
    }
  }
  const info = await fs.stat(filePath)
  const contentType = mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream'
  const headers = { ...cacheHeaders(filePath, assetRoot), 'content-type': contentType, 'content-length': info.size }
  if (req.method === 'HEAD') {
    res.writeHead(200, headers)
    res.end()
    return
  }
  const accepts = req.headers['accept-encoding'] || ''
  const compressible = compressibleTypes.has(contentType.split(';')[0]) && info.size > 256
  if (compressible && /br/u.test(accepts)) {
    const body = await fs.readFile(filePath)
    const encoded = await brotliCompressAsync(body)
    res.writeHead(200, { ...headers, 'content-encoding': 'br', 'content-length': encoded.length, vary: 'Accept-Encoding' })
    res.end(encoded)
    return
  }
  if (compressible && /gzip/u.test(accepts)) {
    const { 'content-length': _contentLength, ...streamHeaders } = headers
    res.writeHead(200, { ...streamHeaders, 'content-encoding': 'gzip', vary: 'Accept-Encoding', 'transfer-encoding': 'chunked' })
    createReadStream(filePath).pipe(createGzip()).pipe(res)
    return
  }
  res.writeHead(200, headers)
  createReadStream(filePath).pipe(res)
}

export function createProductionGateway(options = {}) {
  const staticDir = options.staticDir || staticRoot
  const apiProxyTarget = options.apiTarget ? new URL(options.apiTarget) : apiTarget
  const server = createServer((req, res) => {
    if ((req.url || '') === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' })
      res.end('ok\n')
      return
    }
    if ((req.url || '').startsWith('/api/')) {
      try { return proxyHttp(req, res, apiProxyTarget) }
      catch { res.writeHead(400, { connection: 'close' }); res.end('Bad request'); return }
    }
    return sendStatic(req, res, staticDir).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      if (!res.writableEnded) res.end('Static server error')
      options.onError?.(error)
    })
  })
  server.on('upgrade', (req, socket, head) => {
    if ((req.url || '').startsWith('/funasr-stream')) return proxyWebSocket(req, socket, head, apiProxyTarget)
    socket.destroy()
  })
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!existsSync(join(staticRoot, 'index.html'))) {
    console.error(`Missing production build: ${join(staticRoot, 'index.html')}`)
    process.exit(1)
  }
  const server = createProductionGateway()
  server.listen(port, host, () => console.log(`Production web gateway listening at http://${host}:${port}`))
}
