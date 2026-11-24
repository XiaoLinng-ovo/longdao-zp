import { lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, parse, sep } from 'node:path'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { combinedRuntimeSignal } from '@smartrecruit-pro/runtime-lifecycle'

export interface ObjectStorage {
  readonly kind: 'local' | 's3'
  readonly locationId?: string
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  openRead?(key: string, options?: ObjectStreamOptions): Promise<ObjectRead>
  putStream?(key: string, body: Readable, byteLength: number, contentType: string, options?: ObjectStreamOptions): Promise<void>
  delete(key: string, options?: { signal?: AbortSignal | undefined }): Promise<void>
  health(): Promise<boolean>
  /** Release only owned clients, after the caller has drained its operations. */
  close?(): Promise<void>
}
export interface ObjectStreamOptions { signal?: AbortSignal | undefined; sha256?: string | undefined }
export interface ObjectRead { body: Readable; byteLength: number }

export function exactByteLength(byteLength: number, sha256?: string): Transform {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error('Invalid object stream length')
  const hash = sha256 ? createHash('sha256') : undefined
  let received = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      hash?.update(chunk)
      callback(received > byteLength ? new Error('Object stream exceeds declared length') : null, chunk)
    },
    flush(callback) { callback(received !== byteLength ? new Error('Object stream is incomplete') : hash && hash.digest('hex') !== sha256 ? new Error('Object stream checksum mismatch') : null) },
  })
}

export interface S3ObjectStorageConfig {
  endpoint: string; region: string; accessKeyId: string; secretAccessKey: string
  bucket: string; forcePathStyle: boolean
}
interface CommandClient { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any>; destroy?(): void }

function safePath(root: string, key: string): string {
  if (isAbsolute(key) || /[\0:]/.test(key) || key.split(/[/\\]/).some(part => !part || part === '.' || part === '..')) throw new Error('Invalid local object key')
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, key)
  const child = relative(absoluteRoot, target)
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Object key escapes storage root')
  return target
}

async function safeDirectory(directory: string, create: boolean): Promise<void> {
  const absolute = resolve(directory), volume = parse(absolute).root
  let current = volume
  for (const part of relative(volume, absolute).split(sep).filter(Boolean)) {
    current = resolve(current, part)
    const inspect = () => lstat(current)
    let metadata
    try { metadata = await inspect() }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await mkdir(current) } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure }
      metadata = await inspect()
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('Unsafe local storage directory')
  }
}

/** Reject existing symlinks/junctions. Storage directories must also be writable only by this application. */
export async function checkedLocalObjectPath(root: string, key: string, createDirectories = false): Promise<string> {
  const path = safePath(root, key)
  await safeDirectory(resolve(path, '..'), createDirectories)
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('Unsafe local storage object')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return path
}

export function createLocalObjectStorage(root: string): ObjectStorage {
  return {
    kind: 'local',
    locationId: createHash('sha256').update(JSON.stringify(['local', process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root)])).digest('hex'),
    async put(key, body) { const signal = combinedRuntimeSignal(); signal?.throwIfAborted(); await writeFile(await checkedLocalObjectPath(root, key, true), body, { signal }) },
    async get(key) { const signal = combinedRuntimeSignal(); signal?.throwIfAborted(); return readFile(await checkedLocalObjectPath(root, key), { signal }) },
    async openRead(key, options = {}) {
      const signal = combinedRuntimeSignal(options.signal)
      signal?.throwIfAborted()
      const file = await open(await checkedLocalObjectPath(root, key), 'r')
      try {
        const metadata = await file.stat()
        if (!metadata.isFile()) throw new Error('Unsafe local storage object')
        return { body: file.createReadStream({ signal }), byteLength: metadata.size }
      } catch (error) { await file.close(); throw error }
    },
    async putStream(key, body, byteLength, _contentType, options = {}) {
      const signal = combinedRuntimeSignal(options.signal)
      try {
        signal?.throwIfAborted()
        await pipeline(body, exactByteLength(byteLength), createWriteStream(await checkedLocalObjectPath(root, key, true)), { signal })
      } finally { body.destroy() }
    },
    async delete(key, options = {}) {
      const signal = combinedRuntimeSignal(options.signal)
      signal?.throwIfAborted()
      try {
        const path = await checkedLocalObjectPath(root, key)
        signal?.throwIfAborted()
        await rm(path, { force: true })
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    },
    async health() { try { await safeDirectory(root, true); return true } catch { return false } },
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required for S3 object storage`); return value
}
export function loadS3ObjectStorageConfig(env: NodeJS.ProcessEnv = process.env): S3ObjectStorageConfig {
  return {
    endpoint: required(env, 'S3_ENDPOINT').replace(/\/$/, ''), region: env.S3_REGION?.trim() || 'us-east-1',
    accessKeyId: required(env, 'S3_ACCESS_KEY_ID'), secretAccessKey: required(env, 'S3_SECRET_ACCESS_KEY'),
    bucket: env.S3_QUARANTINE_BUCKET?.trim() || 'resume-quarantine', forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
  }
}
function missing(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined
  return value?.name === 'NotFound' || value?.name === 'NoSuchBucket' || value?.$metadata?.httpStatusCode === 404
}
export function createS3ObjectStorage(options: { bucket: string; client: CommandClient; endpoint?: string; region?: string; deleteTimeoutMs?: number; requestTimeoutMs?: number; ownsClient?: boolean }): ObjectStorage {
  const deleteTimeoutMs = options.deleteTimeoutMs ?? 30000
  const requestTimeoutMs = options.requestTimeoutMs ?? 300000
  if (!Number.isSafeInteger(deleteTimeoutMs) || deleteTimeoutMs < 1 || deleteTimeoutMs > 300000) throw new Error('Invalid object deletion timeout')
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 600000) throw new Error('Invalid object request timeout')
  const requestSignal = (signal?: AbortSignal) => {
    const lifetime = combinedRuntimeSignal(signal)
    return lifetime ? AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), lifetime]) : AbortSignal.timeout(requestTimeoutMs)
  }
  let ready = false
  let closing: Promise<void> | undefined
  const assertOpen = () => { if (closing) throw new Error('Object storage is closed') }
  let initializing: { work: Promise<void>; controller: AbortController; users: number; settled: boolean } | undefined
  const ensure = async (signal?: AbortSignal) => {
    assertOpen()
    signal?.throwIfAborted()
    if (ready) return
    if (!initializing || initializing.controller.signal.aborted) {
      const controller = new AbortController()
      const entry = { work: Promise.resolve(), controller, users: 0, settled: false }
      entry.work = (async () => {
        try { await options.client.send(new HeadBucketCommand({ Bucket: options.bucket }), { abortSignal: controller.signal }) }
        catch (error) {
          controller.signal.throwIfAborted()
          if (!missing(error)) throw error
          await options.client.send(new CreateBucketCommand({ Bucket: options.bucket }), { abortSignal: controller.signal })
        }
        ready = true
      })().finally(() => { entry.settled = true; if (initializing === entry) initializing = undefined })
      initializing = entry
    }
    const entry = initializing
    entry.users++
    let abort: (() => void) | undefined
    try {
      await Promise.race([entry.work, new Promise<never>((_resolve, reject) => {
        if (!signal) return
        abort = () => reject(signal.reason ?? new Error('Object request cancelled'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })])
    } finally {
      if (abort) signal?.removeEventListener('abort', abort)
      if (--entry.users === 0 && !entry.settled) entry.controller.abort()
    }
  }
  return {
    kind: 's3',
    ...(options.ownsClient ? { close: () => closing ??= Promise.resolve().then(() => { options.client.destroy?.() }) } : {}),
    ...(options.endpoint ? { locationId: createHash('sha256').update(JSON.stringify(['s3', new URL(options.endpoint).origin, new URL(options.endpoint).pathname.replace(/\/$/, ''), options.region ?? '', options.bucket])).digest('hex') } : {}),
    async put(key, body, contentType) {
      const signal = requestSignal()
      await ensure(signal)
      signal.throwIfAborted()
      await options.client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.byteLength }), { abortSignal: signal })
    },
    async get(key) {
      assertOpen()
      const signal = requestSignal()
      const result = await options.client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }), { abortSignal: signal })
      if (!result.Body) throw new Error(`S3 object ${key} has no body`)
      let abort: (() => void) | undefined
      try {
        return Buffer.from(await Promise.race([result.Body.transformToByteArray(), new Promise<never>((_resolve, reject) => {
          abort = () => { result.Body.destroy?.(); reject(signal.reason) }
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })]))
      } finally { if (abort) signal.removeEventListener('abort', abort) }
    },
    async openRead(key, streamOptions = {}) {
      assertOpen()
      const signal = requestSignal(streamOptions.signal)
      signal.throwIfAborted()
      const result = await options.client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }), { abortSignal: signal })
      if (!(result.Body instanceof Readable) || !Number.isSafeInteger(result.ContentLength) || result.ContentLength < 0) {
        result.Body?.destroy?.()
        throw new Error('S3 object stream has no valid body or length')
      }
      const input = result.Body as Readable, byteLength = Number(result.ContentLength)
      const body = Readable.from((async function* () {
        let received = 0
        for await (const chunk of input) {
          signal.throwIfAborted()
          received += chunk.length
          if (received > byteLength) throw new Error('Object stream exceeds declared length')
          yield chunk
        }
        if (received !== byteLength) throw new Error('Object stream is incomplete')
      })(), { objectMode: false, signal })
      body.once('close', () => input.destroy())
      return { body, byteLength }
    },
    async putStream(key, body, byteLength, contentType, streamOptions = {}) {
      const controller = new AbortController()
      const signal = requestSignal(streamOptions.signal ? AbortSignal.any([controller.signal, streamOptions.signal]) : controller.signal)
      let work: Promise<unknown>[] = []
      let checked: Transform | undefined
      try {
        signal.throwIfAborted()
        // Precomputed checksums avoid an SDK-owned trailer stream outliving a failed request.
        if (!/^[a-f0-9]{64}$/.test(streamOptions.sha256 ?? '')) throw new Error('S3_STREAM_SHA256_REQUIRED')
        checked = exactByteLength(byteLength, streamOptions.sha256)
        await ensure(signal)
        const sending = options.client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: checked, ContentType: contentType, ContentLength: byteLength, ChecksumSHA256: Buffer.from(streamOptions.sha256!, 'hex').toString('base64') }), { abortSignal: signal })
        work = [sending, pipeline(body, checked, { signal })]
        await Promise.all(work)
      } catch (error) {
        controller.abort()
        await Promise.allSettled(work)
        throw error
      } finally { body.destroy(); checked?.destroy() }
    },
    async delete(key, requestOptions = {}) {
      assertOpen()
      const deadline = AbortSignal.timeout(deleteTimeoutMs)
      const signal = combinedRuntimeSignal(requestOptions.signal ? AbortSignal.any([deadline, requestOptions.signal]) : deadline)!
      signal.throwIfAborted()
      await options.client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }), { abortSignal: signal })
    },
    async health() { try { await ensure(requestSignal()); return true } catch { return false } },
  }
}
export function createInterviewObjectStorageFromEnv(env: NodeJS.ProcessEnv = process.env, defaultRoot = resolve(process.cwd(), '../../data/interviews')): ObjectStorage {
  // Preserve the historical shared root only when no explicit interview location was approved.
  return createObjectStorageFromEnv({ ...env, RECRUITING_QUARANTINE_ROOT: env.INTERVIEW_STORAGE_ROOT?.trim() || env.RECRUITING_QUARANTINE_ROOT }, defaultRoot)
}

export function createObjectStorageFromEnv(env: NodeJS.ProcessEnv = process.env, defaultRoot = resolve(process.cwd(), '../../data/resumes/quarantine')): ObjectStorage {
  if (!env.S3_ENDPOINT?.trim()) return createLocalObjectStorage(env.RECRUITING_QUARANTINE_ROOT?.trim() || defaultRoot)
  const config = loadS3ObjectStorageConfig(env)
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })
  return createS3ObjectStorage({ bucket: config.bucket, client, endpoint: config.endpoint, region: config.region, ownsClient: true })
}
