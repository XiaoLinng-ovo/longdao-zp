import assert from 'node:assert/strict'
import test from 'node:test'
import { createHttpOcrClient } from './ocr-client.js'

const input = { content: Buffer.from('image'), filename: 'scan.png', mimeType: 'image/png' }

test('OCR client sends the original file with a bounded request', async () => {
  assert.equal(createHttpOcrClient('  '), undefined)
  const client = createHttpOcrClient('http://ocr.local/', { fetch: async (url, init) => {
    assert.equal(url, 'http://ocr.local/ocr')
    assert.ok(init?.signal)
    const file = (init?.body as FormData).get('file') as File
    assert.equal(file.name, 'scan.png')
    assert.equal(await file.text(), 'image')
    return Response.json({ text: '张三 熟悉 Python 数据处理', engine: 'test' })
  } })!
  assert.equal((await client.recognize(input)).engine, 'test')
})

test('OCR client rejects missing body, watermark-only results and offline services', async () => {
  for (const payload of [null, {}, { text: ' ' }, { text: 'b43175958f5b36471H1_09-7GFdYy4i3WfOXWOCkn_bUPhBh' }]) {
    const client = createHttpOcrClient('http://ocr.local', { fetch: async () => Response.json(payload) })!
    await assert.rejects(client.recognize(input), /有效简历正文/u)
  }
  for (const fetcher of [
    async () => { throw new TypeError('private connection details') },
    async () => new Response('private OCR traceback', { status: 503 }),
    async () => new Response('invalid JSON'),
  ]) {
    const client = createHttpOcrClient('http://ocr.local', { fetch: fetcher })!
    await assert.rejects(client.recognize(input), (error: Error) => /OCR.*尚未生成评分/u.test(error.message) && !/private/u.test(error.message))
  }
})

test('OCR request timeout also bounds response-body reads', async () => {
  const client = createHttpOcrClient('http://ocr.local', { timeoutMs: 10, fetch: async (_url, init) => {
    return new Response(new ReadableStream({ start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true })
    } }))
  } })!
  const keepAlive = setTimeout(() => {}, 1000)
  try { await assert.rejects(client.recognize(input), /OCR.*尚未生成评分/u) }
  finally { clearTimeout(keepAlive) }
})

test('OCR client rejects long results with broken glyph decoding rather than scoring them', async () => {
  const client = createHttpOcrClient('http://ocr.local', { fetch: async () => Response.json({ text: 'Python FastAPI ' + '\uE001'.repeat(50) }) })!
  await assert.rejects(client.recognize(input), /乱码.*尚未生成评分/u)
})
