import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, symlink, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Readable } from 'node:stream'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { createInterviewObjectStorageFromEnv, createLocalObjectStorage, createObjectStorageFromEnv, createS3ObjectStorage, loadS3ObjectStorageConfig } from './index.js'

const digest = (body: string | Buffer) => createHash('sha256').update(body).digest('hex')

test('local storage supports put, get, delete and health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'object-storage-'))
  try {
    const storage = createLocalObjectStorage(root)
    await storage.put('resume.pdf', Buffer.from('resume'), 'application/pdf')
    assert.equal((await storage.get('resume.pdf')).toString(), 'resume')
    assert.equal(await storage.health(), true)
    await storage.delete('resume.pdf')
    await storage.delete('missing-parent/already-deleted.pdf')
    await assert.rejects(storage.get('resume.pdf'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('environment factory uses local storage when S3 is not configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'object-storage-env-'))
  try {
    const storage = createObjectStorageFromEnv({ RECRUITING_QUARANTINE_ROOT: root })
    assert.equal(storage.kind, 'local')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('explicit interview root wins over resume root without changing the resume factory or input configuration', () => {
  const resume = join(tmpdir(), 'resume-root'), interview = join(tmpdir(), 'interview-root')
  const env = { RECRUITING_QUARANTINE_ROOT: resume, INTERVIEW_STORAGE_ROOT: interview }
  const before = { ...env }
  assert.equal(createInterviewObjectStorageFromEnv(env).locationId, createLocalObjectStorage(interview).locationId)
  assert.equal(createObjectStorageFromEnv(env).locationId, createLocalObjectStorage(resume).locationId)
  assert.deepEqual(env, before)
})

test('unconfigured interview root preserves the historical shared location and explicit factory fallback', () => {
  const shared = join(tmpdir(), 'historical-shared'), fallback = join(tmpdir(), 'interview-fallback')
  assert.equal(createInterviewObjectStorageFromEnv({ RECRUITING_QUARANTINE_ROOT: shared }).locationId, createLocalObjectStorage(shared).locationId)
  assert.equal(createInterviewObjectStorageFromEnv({ INTERVIEW_STORAGE_ROOT: ' ' }, fallback).locationId, createLocalObjectStorage(fallback).locationId)
})

test('本地存储拒绝目录穿越、目录联接和符号链接，不能改动根目录之外的文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'object-storage-boundary-'))
  const root = join(directory, 'root'), outside = join(directory, 'outside')
  try {
    await mkdir(root); await mkdir(outside)
    await writeFile(join(outside, 'kept.txt'), 'must remain')
    const storage = createLocalObjectStorage(root)
    for (const key of ['../outside/kept.txt', '..\\outside\\kept.txt', 'data:stream', './file', 'a/../file']) {
      await assert.rejects(storage.put(key, Buffer.from('bad'), 'text/plain'))
      await assert.rejects(storage.get(key))
      await assert.rejects(storage.delete(key))
    }
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(storage.put('linked/new.txt', Buffer.from('bad'), 'text/plain'), /Unsafe/)
    await assert.rejects(storage.get('linked/kept.txt'), /Unsafe/)
    await assert.rejects(storage.delete('linked/kept.txt'), /Unsafe/)
    const linkedRoot = createLocalObjectStorage(join(root, 'linked'))
    assert.equal(await linkedRoot.health(), false)
    await assert.rejects(linkedRoot.put('new.txt', Buffer.from('bad'), 'text/plain'), /Unsafe/)
    assert.equal(await readFile(join(outside, 'kept.txt'), 'utf8'), 'must remain')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('loads MinIO path-style configuration', () => {
  assert.equal(loadS3ObjectStorageConfig({ S3_ENDPOINT: 'http://minio:9000/', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret' }).forcePathStyle, true)
})
test('storage identities follow locations, not credentials, and expose no raw paths', () => {
  const local=createLocalObjectStorage(join(tmpdir(),'identity-a'))
  assert.match(local.locationId!,/^[a-f0-9]{64}$/)
  assert.equal(local.locationId,createLocalObjectStorage(join(tmpdir(),'identity-a','.')).locationId)
  assert.notEqual(local.locationId,createLocalObjectStorage(join(tmpdir(),'identity-b')).locationId)
  const env={S3_ENDPOINT:'http://127.0.0.1:9000',S3_ACCESS_KEY_ID:'test',S3_SECRET_ACCESS_KEY:'first'}
  assert.equal(createObjectStorageFromEnv(env).locationId,createObjectStorageFromEnv({...env,S3_SECRET_ACCESS_KEY:'rotated'}).locationId)
  assert.notEqual(createObjectStorageFromEnv(env).locationId,createObjectStorageFromEnv({...env,S3_QUARANTINE_BUCKET:'other'}).locationId)
})

test('S3 storage initializes bucket and supports object operations', async () => {
  const commands: unknown[] = []
  const client = { async send(command: unknown) {
    commands.push(command)
    if (command instanceof HeadBucketCommand && commands.length === 1) throw Object.assign(new Error('missing'), { name: 'NotFound' })
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => Uint8Array.from([1, 2]) } }
    return {}
  } }
  const storage = createS3ObjectStorage({ bucket: 'resume-quarantine', client })
  await storage.put('resume.pdf', Buffer.from([1, 2]), 'application/pdf')
  assert.deepEqual(await storage.get('resume.pdf'), Buffer.from([1, 2]))
  await storage.delete('resume.pdf')
  assert.equal(await storage.health(), true)
  assert.ok(commands.some((item) => item instanceof CreateBucketCommand))
  assert.ok(commands.some((item) => item instanceof PutObjectCommand))
  assert.ok(commands.some((item) => item instanceof DeleteObjectCommand))
})

test('S3 health initializes a missing quarantine bucket', async () => {
  const commands: unknown[] = []
  const client = { async send(command: unknown) {
    commands.push(command)
    if (command instanceof HeadBucketCommand) throw Object.assign(new Error('missing'), { name: 'NotFound' })
    return {}
  } }
  const storage = createS3ObjectStorage({ bucket: 'resume-quarantine', client })
  assert.equal(await storage.health(), true)
  assert.ok(commands[0] instanceof HeadBucketCommand)
  assert.ok(commands[1] instanceof CreateBucketCommand)
})

test('自有客户端只释放一次，关闭后不再发送请求，共享客户端由外部管理', async () => {
  let sends = 0, destroys = 0
  const client = { async send() { sends++; return {} }, destroy() { destroys++ } }
  const owned = createS3ObjectStorage({ bucket: 'owned', client, ownsClient: true })
  const shared = createS3ObjectStorage({ bucket: 'shared', client })
  assert.equal(shared.close, undefined)
  assert.equal(await owned.health(), true)
  const closing = owned.close!()
  assert.equal(owned.close!(), closing)
  await closing
  assert.equal(destroys, 1)
  const before = sends
  await assert.rejects(owned.get('anything'), /closed/)
  await assert.rejects(owned.put('anything', Buffer.alloc(0), 'text/plain'), /closed/)
  await assert.rejects(owned.delete('anything'), /closed/)
  await assert.rejects(owned.openRead!('anything'), /closed/)
  assert.equal(await owned.health(), false)
  assert.equal(sends, before)
})

test('本地流读写校验实际长度，支持取消并保持目录边界', async () => {
  const root = await mkdtemp(join(tmpdir(), 'object-storage-stream-'))
  try {
    const storage = createLocalObjectStorage(root)
    await storage.putStream!('audio', Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4, 'audio/mp4')
    const file = await storage.openRead!('audio')
    assert.equal(file.byteLength, 4)
    const chunks = []; for await (const part of file.body) chunks.push(part)
    assert.equal(Buffer.concat(chunks).toString(), 'abcd')
    await assert.rejects(storage.putStream!('short', Readable.from([Buffer.from('ab')]), 4, 'audio/mp4'), /incomplete/)
    await assert.rejects(storage.putStream!('long', Readable.from([Buffer.from('abcd')]), 2, 'audio/mp4'), /exceeds/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(storage.openRead!('audio', { signal: controller.signal }), { name: 'AbortError' })
    await assert.rejects(storage.openRead!('../outside'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('S3流输入或输出截断必须失败，取消销毁在途流', async () => {
  let declared = 4, saved = Buffer.alloc(0)
  const client = { async send(command: unknown) {
    if (command instanceof GetObjectCommand) return { ContentLength: declared, Body: Readable.from([Buffer.from('data')]) }
    if (command instanceof PutObjectCommand) {
      const parts = []; for await (const part of command.input.Body as Readable) parts.push(part)
      saved = Buffer.concat(parts)
    }
    return {}
  } }
  const storage = createS3ObjectStorage({ bucket: 'synthetic', client })
  await storage.putStream!('audio', Readable.from([Buffer.from('data')]), 4, 'audio/mp4', { sha256: digest('data') })
  assert.equal(saved.toString(), 'data')
  await assert.rejects(storage.putStream!('short', Readable.from([Buffer.from('x')]), 4, 'audio/mp4', { sha256: digest('x') }), /incomplete/)
  declared = 5
  const short = await storage.openRead!('audio')
  await assert.rejects(async () => { for await (const _part of short.body) {} }, /incomplete/)
  declared = 3
  const long = await storage.openRead!('audio')
  await assert.rejects(async () => { for await (const _part of long.body) {} }, /exceeds/)
  const controller = new AbortController(), waiting = new Readable({ read() {} })
  const writing = storage.putStream!('cancel', waiting, 4, 'audio/mp4', { signal: controller.signal, sha256: digest('data') })
  controller.abort()
  await assert.rejects(writing, { name: 'AbortError' })
  assert.equal(waiting.destroyed, true)
})

test('真实 S3 客户端连接本机协议替身，慢响应可取消且半写入不能成功', async () => {
  let putBytes = 0, getRequests = 0
  const server = createServer((request, response) => {
    const key = new URL(request.url!, 'http://localhost').pathname
    if (request.method === 'HEAD') { response.end(); return }
    if (request.method === 'PUT') {
      request.on('error', () => undefined)
      request.on('data', part => {
        putBytes += part.length
        if (key.endsWith('/half')) request.socket.destroy()
      })
      request.on('end', () => { if (!response.destroyed) response.end() })
      return
    }
    if (request.method === 'GET') {
      getRequests++
      if (key.endsWith('/wait')) return
      response.writeHead(200, { 'content-length': 8, 'content-type': 'audio/mp4' })
      response.write('abcd')
      const timer = setTimeout(() => response.destroy(), 30)
      response.once('close', () => clearTimeout(timer))
      return
    }
    response.statusCode = 405; response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new S3Client({
    endpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    region: 'us-east-1', forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic-not-a-secret' },
  })
  const storage = createS3ObjectStorage({ bucket: 'synthetic', client })
  try {
    await storage.putStream!('ok', Readable.from([Buffer.from('data')]), 4, 'audio/mp4', { sha256: digest('data') })
    assert.equal(putBytes, 4)
    const source = Readable.from((async function* () {
      yield Buffer.alloc(64 * 1024)
      await new Promise(resolve => setTimeout(resolve, 40))
      yield Buffer.alloc(64 * 1024)
    })())
    await assert.rejects(storage.putStream!('half', source, 128 * 1024, 'audio/mp4', { sha256: digest(Buffer.alloc(128 * 1024)) }))
    assert.equal(source.destroyed, true)
    const short = await storage.openRead!('short')
    await assert.rejects(async () => { for await (const _chunk of short.body) {} })
    assert.equal(short.body.destroyed, true)
    const controller = new AbortController()
    const waiting = storage.openRead!('wait', { signal: controller.signal })
    const timer = setTimeout(() => controller.abort(), 80)
    try { await assert.rejects(waiting, { name: 'AbortError' }) } finally { clearTimeout(timer) }
    assert.equal(getRequests, 2)
  } finally {
    client.destroy(); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('共享 S3 初始化时，一个取消不影响另一个；全部取消终止初始化', async () => {
  let release!: () => void, initializationSignal: AbortSignal | undefined
  const ready = new Promise<void>(resolve => { release = resolve })
  const client = { async send(command: unknown, options?: { abortSignal?: AbortSignal }) {
    if (command instanceof HeadBucketCommand) {
      initializationSignal = options?.abortSignal
      await ready
    }
    if (command instanceof PutObjectCommand) for await (const _part of command.input.Body as Readable) {}
    return {}
  } }
  const storage = createS3ObjectStorage({ bucket: 'synthetic', client })
  const controller = new AbortController()
  const first = storage.putStream!('one', Readable.from([Buffer.from('a')]), 1, 'audio/mp4', { signal: controller.signal, sha256: digest('a') })
  const rejected = assert.rejects(first)
  const second = storage.putStream!('two', Readable.from([Buffer.from('b')]), 1, 'audio/mp4', { sha256: digest('b') })
  controller.abort(); await rejected
  assert.equal(initializationSignal?.aborted, false)
  release(); await second
  let aborted = false
  const blocking = createS3ObjectStorage({ bucket: 'synthetic', client: { send: async (_command, options) => new Promise((_resolve, reject) => {
    options?.abortSignal?.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')) }, { once: true })
  }) } })
  const cancel = new AbortController()
  const writing = blocking.putStream!('one', Readable.from([Buffer.from('a')]), 1, 'audio/mp4', { signal: cancel.signal, sha256: digest('a') })
  const stopping = assert.rejects(writing)
  cancel.abort(); await stopping
  assert.equal(aborted, true)
})

test('S3 流写入缺少摘要或摘要不符必须失败并销毁输入', async () => {
  let sends = 0
  const storage = createS3ObjectStorage({ bucket: 'synthetic', client: { async send(command) {
    sends++
    if (command instanceof PutObjectCommand) for await (const _part of command.input.Body as Readable) {}
    return {}
  } } })
  const missing = Readable.from([Buffer.from('data')])
  await assert.rejects(storage.putStream!('missing', missing, 4, 'audio/mp4'), /S3_STREAM_SHA256_REQUIRED/)
  assert.equal(missing.destroyed, true); assert.equal(sends, 0)
  const wrong = Readable.from([Buffer.from('data')])
  await assert.rejects(storage.putStream!('wrong', wrong, 4, 'audio/mp4', { sha256: digest('other') }), /checksum mismatch/)
  assert.equal(wrong.destroyed, true)
})

test('真实 S3 删除慢响应在截止时间或主动取消后断开', async () => {
  let requests = 0
  const server = createServer((request, _response) => { if (request.method === 'DELETE') requests++ })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new S3Client({ endpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    region: 'us-east-1', forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic-not-a-secret' } })
  try {
    const storage = createS3ObjectStorage({ bucket: 'synthetic', client, deleteTimeoutMs: 150 })
    await assert.rejects(storage.delete('timeout'), { name: 'AbortError' })
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 80)
    try { await assert.rejects(storage.delete('cancel', { signal: controller.signal }), { name: 'AbortError' }) }
    finally { clearTimeout(timer) }
    assert.equal(requests, 2)
  } finally { client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('真实 S3 普通读写、流读写和健康检查均有总期限，响应头后停滞也能回收', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.method + ' ' + request.url)
    if (request.method === 'HEAD' && request.url?.startsWith('/synthetic')) { response.writeHead(200); response.end(); return }
    if (request.method === 'GET' && request.url?.includes('/body-stall')) {
      response.writeHead(200, { 'content-length': '32', 'content-type': 'application/octet-stream' })
      response.write('part')
    }
    request.resume()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const client = new S3Client({ endpoint: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    region: 'us-east-1', forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic-not-a-secret' } })
  try {
    const storage = createS3ObjectStorage({ bucket: 'synthetic', client, requestTimeoutMs: 180 })
    await assert.rejects(storage.put('put-stall', Buffer.from('data'), 'text/plain'))
    await assert.rejects(storage.get('headers-stall'))
    await assert.rejects(storage.get('body-stall'))
    const opened = await storage.openRead!('body-stall')
    await assert.rejects(async () => { for await (const _part of opened.body) {} })
    assert.equal(opened.body.destroyed, true)
    const input = Readable.from([Buffer.from('data')])
    await assert.rejects(storage.putStream!('stream-stall', input, 4, 'text/plain', { sha256: digest('data') }))
    assert.equal(input.destroyed, true)
    const unavailable = createS3ObjectStorage({ bucket: 'unavailable', client, requestTimeoutMs: 180 })
    assert.equal(await unavailable.health(), false)
    for (const path of ['put-stall', 'headers-stall', 'body-stall', 'stream-stall', 'unavailable']) {
      assert.ok(requests.some(request => request.includes(path)), path + ' 必须经过真实本机 HTTP')
    }
  } finally { client.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('拒绝非法对象请求期限', () => {
  for (const requestTimeoutMs of [0, -1, 1.5, NaN, 600001]) {
    assert.throws(() => createS3ObjectStorage({ bucket: 'synthetic', client: { async send() { return {} } }, requestTimeoutMs }), /Invalid object request timeout/)
  }
})
