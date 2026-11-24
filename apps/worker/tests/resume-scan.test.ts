import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { processNextResumeScan, startResumeScanPoll } from '../src/security/resume-scan.js'

test('writes the clean terminal state after clamd accepts a claimed resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resume-scan-'))
  await writeFile(join(root, 'resume.pdf'), 'content')
  const transitions: string[] = []
  try {
    const outcome = await processNextResumeScan({
      store: {
        claimNextResumeForScan: async () => ({ resumeId: 'resume-1', storageKey: 'resume.pdf' }),
        updateResumeScanStatus: async (_id, status) => { transitions.push(status); return status },
      },
      scanner: { scan: async () => ({ status: 'clean' }) },
      quarantineRoot: root,
    })
    assert.equal(outcome?.status, 'clean')
    assert.deepEqual(transitions, ['clean'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('writes infected and never writes clean when clamd detects malware', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resume-scan-'))
  await writeFile(join(root, 'resume.pdf'), 'content')
  const transitions: string[] = []
  try {
    const outcome = await processNextResumeScan({
      store: {
        claimNextResumeForScan: async () => ({ resumeId: 'resume-1', storageKey: 'resume.pdf' }),
        updateResumeScanStatus: async (_id, status) => { transitions.push(status); return status },
      },
      scanner: { scan: async () => ({ status: 'infected', signature: 'Eicar-Signature' }) },
      quarantineRoot: root,
    })
    assert.equal(outcome?.status, 'infected')
    assert.deepEqual(transitions, ['infected'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('writes failed when scanning cannot complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resume-scan-'))
  await writeFile(join(root, 'resume.pdf'), 'content')
  const transitions: string[] = []
  try {
    await assert.rejects(processNextResumeScan({
      store: {
        claimNextResumeForScan: async () => ({ resumeId: 'resume-1', storageKey: 'resume.pdf' }),
        updateResumeScanStatus: async (_id, status) => { transitions.push(status); return status },
      },
      scanner: { scan: async () => { throw new Error('clamd unavailable') } },
      quarantineRoot: root,
    }), /clamd unavailable/)
    assert.deepEqual(transitions, ['failed'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reads resume bytes through injected object storage', async () => {
  const transitions: string[] = []
  const outcome = await processNextResumeScan({
    store: {
      claimNextResumeForScan: async () => ({ resumeId: 'resume-s3', storageKey: 'opaque.pdf' }),
      updateResumeScanStatus: async (_id, status) => { transitions.push(status); return status },
    },
    scanner: { scan: async (content) => { assert.equal(content.toString(), 'from-minio'); return { status: 'clean' } } },
    storage: { kind: 's3', get: async () => Buffer.from('from-minio'), put: async () => {}, delete: async () => {}, health: async () => true },
  })
  assert.equal(outcome?.status, 'clean')
  assert.deepEqual(transitions, ['clean'])
})

test('停止扫描立即阻止新领取并等待在途扫描和状态提交，重复停止返回同一等待', async () => {
  let enter!: () => void, finish!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  let claims = 0, updates = 0, ended = false
  const stop = startResumeScanPoll({
    pollIntervalMs: 5,
    store: {
      claimNextResumeForScan: async () => { claims++; return { resumeId: 'owned', storageKey: 'owned.txt' } },
      updateResumeScanStatus: async (_id, status) => { updates++; return status },
    },
    scanner: { scan: async () => { enter(); await pending; return { status: 'clean' } } },
    storage: { kind: 'local', get: async () => Buffer.from('synthetic'), put: async () => {}, delete: async () => {}, health: async () => true },
    logger: { log() {}, error() {}, warn() {} },
  })
  try {
    await entered
    const closing = stop()
    assert.equal(stop(), closing)
    void closing.then(() => { ended = true })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(claims, 1); assert.equal(updates, 0); assert.equal(ended, false)
    finish(); await closing
    assert.equal(updates, 1)
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(claims, 1)
  } finally { finish(); await stop() }
})
