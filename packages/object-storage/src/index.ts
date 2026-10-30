import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

export interface ObjectStorage {
  readonly kind: 'local' | 's3'
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  health(): Promise<boolean>
}

export interface S3ObjectStorageConfig {
  endpoint: string; region: string; accessKeyId: string; secretAccessKey: string
  bucket: string; forcePathStyle: boolean
}
interface CommandClient { send(command: unknown): Promise<any> }

function safePath(root: string, key: string): string {
  const absoluteRoot = resolve(root)
  const target = resolve(absoluteRoot, key)
  const child = relative(absoluteRoot, target)
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Object key escapes storage root')
  return target
}

export function createLocalObjectStorage(root: string): ObjectStorage {
  return {
    kind: 'local',
    async put(key, body) { const path = safePath(root, key); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, body) },
    async get(key) { return readFile(safePath(root, key)) },
    async delete(key) { await rm(safePath(root, key), { force: true }) },
    async health() { try { await mkdir(resolve(root), { recursive: true }); return true } catch { return false } },
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
export function createS3ObjectStorage(options: { bucket: string; client: CommandClient }): ObjectStorage {
  let ready: Promise<void> | undefined
  const ensure = () => ready ??= (async () => { try { await options.client.send(new HeadBucketCommand({ Bucket: options.bucket })) } catch (error) { if (!missing(error)) throw error; await options.client.send(new CreateBucketCommand({ Bucket: options.bucket })) } })().catch(error => { ready = undefined; throw error })
  return {
    kind: 's3',
    async put(key, body, contentType) { await ensure(); await options.client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.byteLength })) },
    async get(key) { const result = await options.client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key })); if (!result.Body) throw new Error(`S3 object ${key} has no body`); return Buffer.from(await result.Body.transformToByteArray()) },
    async delete(key) { await options.client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key })) },
    async health() { try { await ensure(); return true } catch { return false } },
  }
}
export function createObjectStorageFromEnv(env: NodeJS.ProcessEnv = process.env, defaultRoot = resolve(process.cwd(), '../../data/resumes/quarantine')): ObjectStorage {
  if (!env.S3_ENDPOINT?.trim()) return createLocalObjectStorage(env.RECRUITING_QUARANTINE_ROOT?.trim() || defaultRoot)
  const config = loadS3ObjectStorageConfig(env)
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: config.forcePathStyle, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })
  return createS3ObjectStorage({ bucket: config.bucket, client })
}
