import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { test } from 'node:test'
import { readBody, readJson } from './body.js'
import type { RequestContext } from './http.js'
import { HttpError } from './http.js'

function context(path: string, method: string, raw: string): RequestContext {
  const req = Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage
  req.method = method
  return { req, url: new URL(path, 'http://localhost') } as RequestContext
}

test('resume POST accepts a base64 encoded 10 MiB file and caches the consumed body', async () => {
  const raw = JSON.stringify({ originalFilename: 'resume.pdf', content: Buffer.alloc(10 * 1024 * 1024).toString('base64') })
  const ctx = context('/api/v1/resumes', 'POST', raw)
  assert.equal((await readJson(ctx)).content, JSON.parse(raw).content)
  assert.equal((await readBody(ctx)).raw, raw)
})
test('resume POST still rejects unbounded request bodies', async () => {
  await assert.rejects(readBody(context('/api/v1/resumes', 'POST', JSON.stringify({ content: 'x'.repeat(15 * 1024 * 1024) }))), (error: unknown) => error instanceof HttpError && error.status === 413)
})
test('other routes and methods retain the 1 MiB request limit', async () => {
  for (const [path, method] of [['/api/v1/candidates', 'POST'], ['/api/v1/resumes', 'PATCH'], ['/api/v1/resumes/other', 'POST']]) {
    await assert.rejects(readBody(context(path!, method!, JSON.stringify({ content: 'x'.repeat(1024 * 1024) }))), (error: unknown) => error instanceof HttpError && error.status === 413)
  }
})
test('empty and malformed upload bodies retain normal JSON validation', async () => {
  assert.deepEqual(await readJson(context('/api/v1/resumes', 'POST', '')), {})
  await assert.rejects(readJson(context('/api/v1/resumes', 'POST', '[1]')), (error: unknown) => error instanceof HttpError && error.status === 400)
})
