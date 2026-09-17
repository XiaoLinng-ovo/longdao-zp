import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import test from 'node:test'
import { ClamdClient } from '../src/security/clamd-client.js'

async function withClamd(response: string, run: (port: number) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => {
      chunks.push(chunk)
      const data = Buffer.concat(chunks)
      if (data.subarray(-4).equals(Buffer.alloc(4))) socket.end(`${response}\0`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await run(address.port)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('streams a file to clamd and returns clean', async () => {
  await withClamd('stream: OK', async (port) => {
    const result = await new ClamdClient({ host: '127.0.0.1', port, timeoutMs: 1_000 }).scan(Buffer.from('resume'))
    assert.deepEqual(result, { status: 'clean' })
  })
})

test('returns the detected signature for an infected file', async () => {
  await withClamd('stream: Eicar-Signature FOUND', async (port) => {
    const result = await new ClamdClient({ host: '127.0.0.1', port, timeoutMs: 1_000 }).scan(Buffer.from('virus'))
    assert.deepEqual(result, { status: 'infected', signature: 'Eicar-Signature' })
  })
})

test('rejects malformed clamd responses', async () => {
  await withClamd('unexpected', async (port) => {
    await assert.rejects(
      new ClamdClient({ host: '127.0.0.1', port, timeoutMs: 1_000 }).scan(Buffer.from('resume')),
      /Unexpected clamd response/,
    )
  })
})
