import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RequestContext } from '../http.js'
import { createResumeUploadAdmission, loadResumeUploadLimits } from './upload-admission.js'

function context(workspace = 'company-a', path = '/api/v1/resume-import-batches/b/items/i/content', method = 'POST') {
  const headers = new Map<string, unknown>()
  return Object.assign({
    req: { method }, res: { setHeader(key: string, value: unknown) { headers.set(key, value) } },
    url: new URL(path, 'http://localhost'),
    auth: { user: { id: 'user-1', workspaceId: workspace } },
  } as RequestContext, { headers })
}

test('upload limits default to 6 global / 3 per workspace and reject invalid configuration', () => {
  assert.deepEqual(loadResumeUploadLimits({}), { concurrency: 6, workspaceConcurrency: 3, queueLimit: 2000, workspaceQueueLimit: 500 })
  for (const value of ['0', '-1', '1.5', 'NaN', '101']) assert.throws(() => loadResumeUploadLimits({ RESUME_UPLOAD_CONCURRENCY: value }), /RESUME_UPLOAD_CONCURRENCY/)
  assert.equal(loadResumeUploadLimits({ RESUME_UPLOAD_CONCURRENCY: '20' }).concurrency, 20)
})

test('admission caps workspace and global uploads before body reading without blocking normal requests', async () => {
  const gate = createResumeUploadAdmission({ limits: { concurrency: 3, workspaceConcurrency: 2, queueLimit: 2000, workspaceQueueLimit: 500 } })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const running = [gate(context(), () => held), gate(context(), () => held)]
  let reads = 0
  const blocked = context()
  await assert.rejects(async () => gate(blocked, async () => { reads++ }), { status: 429, code: 'RESUME_UPLOAD_BUSY' })
  assert.equal(blocked.headers.get('retry-after'), '2')
  assert.equal(reads, 0)
  running.push(gate(context('company-b'), () => held))
  await assert.rejects(async () => gate(context('company-c', '/api/v1/resumes'), async () => { reads++ }), { status: 429 })
  await gate(context('company-a', '/api/v1/jobs', 'GET'), async () => { reads++ })
  assert.equal(reads, 1)
  release(); await Promise.all(running)
  await gate(context(), async () => { reads++ })
  assert.equal(reads, 2)
})

test('full analysis backlog returns a retry hint and releases reserved slots', async () => {
  let depth = { total: 500, workspace: 500 }
  const gate = createResumeUploadAdmission({ queueDepth: async () => depth })
  for (let i = 0; i < 10; i++) {
    const request = context()
    await assert.rejects(async () => gate(request, async () => { assert.fail('must not read body') }), { code: 'RESUME_ANALYSIS_QUEUE_FULL' })
    assert.equal(request.headers.get('retry-after'), '10')
  }
  depth = { total: 2000, workspace: 0 }
  await assert.rejects(async () => gate(context(), async () => {}), { code: 'RESUME_ANALYSIS_QUEUE_FULL' })
  depth = { total: 0, workspace: 0 }
  await gate(context(), async () => {})
})

test('database and downstream failures release admission slots', async () => {
  let fail = true
  const gate = createResumeUploadAdmission({
    limits: { concurrency: 1, workspaceConcurrency: 1, queueLimit: 2000, workspaceQueueLimit: 500 },
    queueDepth: async () => { if (fail) throw new Error('database unavailable'); return { total: 0, workspace: 0 } },
  })
  await assert.rejects(async () => gate(context(), async () => {}), /database unavailable/)
  fail = false
  await assert.rejects(async () => gate(context(), async () => { throw new Error('storage unavailable') }), /storage unavailable/)
  await gate(context(), async () => {})
})
