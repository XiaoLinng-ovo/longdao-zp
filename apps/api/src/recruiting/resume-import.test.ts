import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryResumeImportStore, ResumeImportService, type ResumeImportRecruiting } from './resume-import.js'

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
