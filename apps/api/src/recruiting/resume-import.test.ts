import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import type { Pool } from 'pg'
import { MemoryResumeImportStore, PostgresResumeImportStore, ResumeImportService, type ResumeImportRecruiting } from './resume-import.js'

function recruitingFixture(overrides: Partial<ResumeImportRecruiting> = {}): ResumeImportRecruiting {
  let candidateNumber = 0
  let applicationNumber = 0
  let resumeNumber = 0
  return {
    async createCandidate() {
      candidateNumber += 1
      return { id: `candidate-${candidateNumber}` }
    },
    async createApplication() {
      applicationNumber += 1
      return { id: `application-${applicationNumber}` }
    },
    async createResume(input) {
      resumeNumber += 1
      return {
        resume: {
          id: `resume-${resumeNumber}`,
          candidateId: input.candidateId,
          applicationId: input.applicationId ?? null,
          storageKey: `resumes/${resumeNumber}.txt`,
          originalFilename: input.originalFilename,
          mimeType: input.mimeType ?? 'text/plain',
          sizeBytes: 12,
          contentHash: 'hash',
          scanStatus: 'clean',
          createdAt: new Date().toISOString(),
        },
        task: {
          id: `task-${resumeNumber}`,
          resumeId: `resume-${resumeNumber}`,
          applicationId: input.applicationId,
          status: 'queued',
          attempts: 0,
          idempotencyKey: `resume-analysis:${resumeNumber}`,
          availableAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
      }
    },
    ...overrides,
  }
}

function batchInput(count = 2) {
  return {
    jobId: 'job-1',
    files: Array.from({ length: count }, (_, index) => ({
      clientFileId: `client-${index}`,
      originalFilename: `resume-${index}.txt`,
      mimeType: 'text/plain',
      sizeBytes: 12,
    })),
  }
}

test('creates a persistent batch with one item per selected file', async () => {
  const service = new ResumeImportService(new MemoryResumeImportStore(), recruitingFixture())
  const batch = await service.createBatch(batchInput(100), 'user-1')

  assert.equal(batch.jobId, 'job-1')
  assert.equal(batch.items.length, 100)
  assert.equal(batch.items[0]?.status, 'pending_upload')
  assert.equal(batch.items[99]?.clientFileId, 'client-99')
})

test('keeps candidate, application, resume and task IDs after upload', async () => {
  const service = new ResumeImportService(new MemoryResumeImportStore(), recruitingFixture())
  const batch = await service.createBatch(batchInput(1), 'user-1')
  const item = await service.uploadItem(batch.id, batch.items[0]!.id, {
    content: Buffer.from('Synthetic resume').toString('base64'),
    encoding: 'base64',
  })

  assert.equal(item.status, 'queued')
  assert.equal(item.candidateId, 'candidate-1')
  assert.equal(item.applicationId, 'application-1')
  assert.equal(item.resumeId, 'resume-1')
  assert.equal(item.analysisTaskId, 'task-1')
})

test('returns an already queued item without creating a duplicate candidate', async () => {
  let candidates = 0
  const service = new ResumeImportService(new MemoryResumeImportStore(), recruitingFixture({
    async createCandidate() {
      candidates += 1
      return { id: `candidate-${candidates}` }
    },
  }))
  const batch = await service.createBatch(batchInput(1), 'user-1')
  const first = await service.uploadItem(batch.id, batch.items[0]!.id, {
    content: Buffer.from('Synthetic resume').toString('base64'),
    encoding: 'base64',
  })
  const second = await service.uploadItem(batch.id, batch.items[0]!.id, {
    content: Buffer.from('Synthetic resume').toString('base64'),
    encoding: 'base64',
  })

  assert.equal(candidates, 1)
  assert.equal(second.candidateId, first.candidateId)
  assert.equal(second.analysisTaskId, first.analysisTaskId)
})

test('ten simultaneous submissions of one item create only one candidate, application, resume and task', async () => {
  const store = new MemoryResumeImportStore()
  const calls = { candidate: 0, application: 0, resume: 0 }
  const service = new ResumeImportService(store, recruitingFixture({
    async createCandidate() { calls.candidate++; await new Promise(resolve => setTimeout(resolve, 10)); return { id: 'candidate-1' } },
    async createApplication() { calls.application++; return { id: 'application-1' } },
    async createResume() { calls.resume++; return { resume: { id: 'resume-1' }, task: { id: 'task-1' } } },
  }))
  const batch = await service.createBatch(batchInput(1), 'user-1')
  const upload = () => service.uploadItem(batch.id, batch.items[0]!.id, { content: 'resume', encoding: 'utf8' })
  const results = await Promise.allSettled(Array.from({ length: 10 }, upload))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'UPLOAD_IN_PROGRESS')
  assert.deepEqual(calls, { candidate: 1, application: 1, resume: 1 })
  assert.equal((await upload()).analysisTaskId, 'task-1')
  assert.deepEqual(calls, { candidate: 1, application: 1, resume: 1 })
})

test('different files run concurrently and a failed upload releases its lock for retry', async () => {
  let active = 0, peak = 0, fail = true
  const service = new ResumeImportService(new MemoryResumeImportStore(), recruitingFixture({
    async createResume(input) {
      peak = Math.max(peak, ++active)
      try {
        await new Promise(resolve => setTimeout(resolve, 10))
        if (fail && input.originalFilename === 'resume-0.txt') throw new Error('temporary storage failure')
        return { resume: { id: input.originalFilename }, task: { id: input.originalFilename } }
      } finally { active-- }
    },
  }))
  const batch = await service.createBatch(batchInput(3), 'user-1')
  await Promise.allSettled(batch.items.map(item => service.uploadItem(batch.id, item.id, { content: 'resume' })))
  assert.equal(peak, 3)
  const failed = (await service.getBatch(batch.id)).items[0]!
  assert.equal(failed.status, 'failed')
  fail = false
  const retried = await service.uploadItem(batch.id, failed.id, { content: 'resume' })
  assert.equal(retried.status, 'queued')
  assert.equal(retried.candidateId, failed.candidateId)
})

test('a batch-summary failure cannot downgrade a committed upload or duplicate its task on retry', async () => {
  const store = new MemoryResumeImportStore()
  store.completeBatchIfDone = async () => { throw new Error('summary unavailable') }
  const service = new ResumeImportService(store, recruitingFixture())
  const batch = await service.createBatch(batchInput(1), 'user-1')
  const uploaded = await service.uploadItem(batch.id, batch.items[0]!.id, { content: 'resume' })
  assert.equal(uploaded.status, 'queued')
  assert.equal((await service.uploadItem(batch.id, uploaded.id, { content: 'resume' })).analysisTaskId, uploaded.analysisTaskId)
})

test('a cancelled item cannot be claimed from an outdated snapshot', async () => {
  const store = new MemoryResumeImportStore()
  const batch = await store.createBatch({ ...batchInput(1), createdBy: 'user-1' })
  await store.cancelBatch(batch.id)
  await assert.rejects(() => store.updateItem(batch.id, batch.items[0]!.id, { status: 'uploading', incrementAttempts: true }), { code: 'ITEM_CANCELLED' })
})

for (const outcome of ['success', 'operation-failure', 'busy', 'unlock-failure'] as const) {
  test(`PostgreSQL item lock is tenant-scoped and releases its connection on ${outcome}`, async () => {
    const queries: { sql: string; values: unknown[] }[] = []
    let released: boolean | undefined
    const client = Object.assign(new EventEmitter(), {
      async query(sql: string, values: unknown[]) {
        queries.push({ sql, values })
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: outcome !== 'busy' }] }
        if (outcome === 'unlock-failure') throw new Error('connection lost')
        return { rows: [{ unlocked: true }] }
      },
      release(destroy: boolean) { released = destroy },
    })
    const pool = { async connect() { return client } } as unknown as Pool
    const store = new PostgresResumeImportStore(pool, 'organization-1')
    let invoked = false
    const operation = store.withUploadLock('batch-1', 'item-1', async () => {
      invoked = true
      if (outcome === 'operation-failure') throw new Error('upload failed')
      return 'done'
    })
    if (outcome === 'busy') await assert.rejects(operation, { code: 'UPLOAD_IN_PROGRESS' })
    else if (outcome === 'operation-failure') await assert.rejects(operation, /upload failed/)
    else assert.equal(await operation, 'done')
    assert.equal(invoked, outcome !== 'busy')
    assert.equal(released, outcome === 'unlock-failure')
    assert.equal(queries.length, outcome === 'busy' ? 1 : 2)
    assert.deepEqual(queries[0]?.values, ['resume-import:organization-1:batch-1:item-1'])
    assert.equal(client.listenerCount('error'), 0)
  })
}

test('marks only the failed item and keeps other uploads usable', async () => {
  const service = new ResumeImportService(new MemoryResumeImportStore(), recruitingFixture({
    async createCandidate(input) {
      if (input.source === 'resume-import:1') throw new Error('database unavailable')
      return { id: 'candidate-ok' }
    },
  }))
  const batch = await service.createBatch(batchInput(2), 'user-1')

  await assert.rejects(() => service.uploadItem(batch.id, batch.items[0]!.id, {
    content: Buffer.from('Synthetic resume').toString('base64'),
    encoding: 'base64',
  }), /database unavailable/)
  const second = await service.uploadItem(batch.id, batch.items[1]!.id, {
    content: Buffer.from('Synthetic resume').toString('base64'),
    encoding: 'base64',
  })
  const refreshed = await service.getBatch(batch.id)

  assert.equal(refreshed.items[0]?.status, 'failed')
  assert.match(refreshed.items[0]?.error ?? '', /database unavailable/)
  assert.equal(second.status, 'queued')
})

test('cancel stops pending items but retains uploaded work', async () => {
  const service = new ResumeImportService(new MemoryResumeImportStore(), recruitingFixture())
  const batch = await service.createBatch(batchInput(3), 'user-1')
  await service.uploadItem(batch.id, batch.items[0]!.id, {
    content: Buffer.from('Synthetic resume').toString('base64'),
    encoding: 'base64',
  })

  const cancelled = await service.cancelBatch(batch.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.items[0]?.status, 'queued')
  assert.equal(cancelled.items[1]?.status, 'cancelled')
  assert.equal(cancelled.items[2]?.status, 'cancelled')
})

function postgresFixture(patches: Record<string, unknown>[], statement: 'SELECT' | 'UPDATE' = 'SELECT') {
  const timestamp = '2026-10-26T00:00:00Z'
  const queries: { sql: string; parameters: unknown[] }[] = []
  const row = { id: 'batch-1', job_id: 'job-1', status: 'completed', created_at: timestamp, updated_at: timestamp, cancelled_at: null }
  const items = patches.map((patch, index) => ({
    id: `item-${index + 1}`, batch_id: row.id, ordinal: index + 1, client_file_id: `file-${index + 1}`,
    original_filename: 'resume.txt', mime_type: 'text/plain', size_bytes: '6', status: 'queued',
    candidate_id: null, application_id: null, resume_id: null, analysis_task_id: null, analysis_status: null,
    attempts: 1, error: null, created_at: timestamp, updated_at: timestamp, ...patch,
  }))
  const pool = {
    async query(sql: string, parameters: unknown[]) {
      queries.push({ sql, parameters })
      assert.ok(sql.trim().startsWith(`${statement} `))
      return { rows: sql.includes('FROM resume_import_batches b') ? [row] : items }
    },
  } as unknown as Pool
  return { store: new PostgresResumeImportStore(pool, 'organization-1'), queries }
}

test('reports historical uploaded items with deleted tasks as removed without modifying import history', async () => {
  const { store, queries } = postgresFixture([{}, { analysis_task_id: 'dangling-task' }])
  const batch = await store.getBatch('batch-1')
  assert.ok(batch)
  assert.deepEqual(batch.items.map(item => item.status), ['queued', 'queued'])
  assert.deepEqual(batch.items.map(item => item.analysisStatus), ['removed', 'removed'])
  assert.equal(batch.counts.removed, 2)
  assert.equal(batch.counts.analyzing, 0)
  assert.equal(batch.counts.completed, 0)
  assert.equal(queries.length, 2)
  assert.ok(queries.every(query => query.parameters.includes('organization-1')))
})

test('keeps genuine analysis states and pending uploads separate from removed work in batch counts', async () => {
  const { store } = postgresFixture([
    { analysis_task_id: 'task-1', analysis_status: 'processing' },
    { analysis_task_id: 'task-2', analysis_status: 'queued' },
    { analysis_task_id: 'task-3', analysis_status: 'completed' },
    { analysis_task_id: 'task-4', analysis_status: 'failed' },
    { analysis_task_id: 'task-5', analysis_status: 'cancelled' },
    {},
    { status: 'pending_upload' },
    { status: 'uploading' },
  ])
  const batch = await store.getBatch('batch-1')
  assert.ok(batch)
  assert.deepEqual(batch.items.map(item => item.analysisStatus), ['processing', 'queued', 'completed', 'failed', 'cancelled', 'removed', undefined, undefined])
  assert.deepEqual(batch.counts, {
    total: 8, pendingUpload: 1, uploading: 1, uploaded: 6, analyzing: 1, completed: 1, failed: 1, cancelled: 1, removed: 1,
  })
})

test('also reconciles deleted tasks when listing historical batches', async () => {
  const { store, queries } = postgresFixture([{}, { status: 'failed' }, { status: 'cancelled' }])
  const batches = await store.listBatches(20)
  assert.equal(batches[0]?.counts.removed, 1)
  assert.equal(batches[0]?.counts.failed, 1)
  assert.equal(batches[0]?.counts.cancelled, 1)
  assert.equal(batches[0]?.items[1]?.analysisStatus, undefined)
  assert.equal(batches[0]?.items[2]?.analysisStatus, undefined)
  assert.ok(queries.every(query => query.parameters.includes('organization-1')))
})

test('does not mark newly queued uploads as removed before their task status has been queried', async () => {
  const { store, queries } = postgresFixture([
    { candidate_id: 'candidate-1', resume_id: 'resume-1', analysis_task_id: 'task-1' },
  ], 'UPDATE')
  const item = await store.updateItem('batch-1', 'item-1', {
    status: 'queued', resumeId: 'resume-1', analysisTaskId: 'task-1', error: null,
  })

  assert.equal(item.status, 'queued')
  assert.equal(item.analysisTaskId, 'task-1')
  assert.equal(item.analysisStatus, undefined)
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0]?.parameters, ['batch-1', 'item-1', 'organization-1', 'queued', 'resume-1', 'task-1', null])
})
