import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, type ServerResponse } from 'node:http'
import { Readable, Writable } from 'node:stream'
import { sendInterviewAudioStream } from './audio-response.js'

test('流式音频下载完整内容及跨块、前缀、后缀 Range', async () => {
  let source: Readable | undefined
  const server = createServer((request, response) => {
    source = Readable.from([Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghij')])
    void sendInterviewAudioStream(response, { body: source, byteLength: 10 }, 'audio/mp4', request.headers.range).catch(() => response.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    for (const [range, expected, contentRange] of [[undefined, 'abcdefghij', null], ['bytes=2-7', 'cdefgh', 'bytes 2-7/10'], ['bytes=0-2', 'abc', 'bytes 0-2/10'], ['bytes=-4', 'ghij', 'bytes 6-9/10'], ['bytes=7-', 'hij', 'bytes 7-9/10']] as const) {
      const response = await fetch('http://127.0.0.1:' + port, { headers: range ? { range } : {}, signal: AbortSignal.timeout(3000) })
      assert.equal(response.status, range ? 206 : 200)
      assert.equal(response.headers.get('content-range'), contentRange)
      assert.equal(response.headers.get('content-length'), String(expected.length))
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(await response.text(), expected)
    }
    for (const range of ['bytes=10-', 'bytes=-0', 'bytes=1-0', 'bytes=0-1,3-4']) {
      const response = await fetch('http://127.0.0.1:' + port, { headers: { range }, signal: AbortSignal.timeout(3000) })
      assert.equal(response.status, 416)
      assert.equal(response.headers.get('content-range'), 'bytes */10')
      await response.text()
      assert.equal(source?.destroyed, true)
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

function responseSink() {
  const chunks: Buffer[] = []
  const sink = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
  Object.assign(sink, { setHeader() {} })
  return { response: sink as unknown as ServerResponse, chunks }
}

test('流式下载拒绝实际短读和超量，取消能打断无响应输入', async () => {
  for (const [length, expected] of [[5, /读取不完整/], [2, /超过声明值/]] as const) {
    const body = Readable.from([Buffer.from('abc')])
    await assert.rejects(sendInterviewAudioStream(responseSink().response, { body, byteLength: length }, 'audio/mp4'), expected)
    assert.equal(body.destroyed, true)
  }
  const controller = new AbortController(), body = new Readable({ read() {} })
  const sending = sendInterviewAudioStream(responseSink().response, { body, byteLength: 4 }, 'audio/mp4', undefined, controller.signal)
  const rejected = assert.rejects(sending, { name: 'AbortError' })
  controller.abort()
  await rejected
  assert.equal(body.destroyed, true)
})
