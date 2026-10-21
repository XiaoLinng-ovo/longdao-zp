import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { createLocalObjectStorage, createObjectStorageFromEnv, createS3ObjectStorage, loadS3ObjectStorageConfig } from './index.js'

test('local storage supports put, get, delete and health', async () => {
  const root = await mkdtemp(join(tmpdir(), 'object-storage-'))
  try {
    const storage = createLocalObjectStorage(root)
    await storage.put('resume.pdf', Buffer.from('resume'), 'application/pdf')
    assert.equal((await storage.get('resume.pdf')).toString(), 'resume')
    assert.equal(await storage.health(), true)
    await storage.delete('resume.pdf')
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

test('loads MinIO path-style configuration', () => {
  assert.equal(loadS3ObjectStorageConfig({ S3_ENDPOINT: 'http://minio:9000/', S3_ACCESS_KEY_ID: 'key', S3_SECRET_ACCESS_KEY: 'secret' }).forcePathStyle, true)
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
