import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

export async function startLocalOcrBoundary() {
  const registered = new Map(), requests = [], failures = []
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/ocr')
      const chunks = []; let size = 0
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 1024 * 1024); chunks.push(chunk) }
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers['content-type'] } }).formData()
      assert.deepEqual([...form.keys()].sort(), ['file', 'pages'])
      const file = form.get('file'), fixture = registered.get(file?.name)
      assert.ok(fixture, 'OCR 只接受事先登记的本轮合成文件')
      assert.equal(file.type, 'application/pdf')
      const hash = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex')
      assert.equal(hash, fixture.hash); assert.deepEqual(JSON.parse(form.get('pages')), fixture.pages)
      requests.push({ filename: file.name, hash, pages: fixture.pages })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: fixture.text, engine: 'isolated-synthetic-ocr', pages: fixture.pages.map(page => ({ page, text: fixture.text })) }))
    } catch (error) {
      failures.push(error.message); response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '拒绝非登记合成OCR请求' }))
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { port: server.address().port, requests, failures,
    register(filename, content, pages, text) { assert.ok(!registered.has(filename)); registered.set(filename, { hash: createHash('sha256').update(content).digest('hex'), pages, text }) },
    async close() { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
