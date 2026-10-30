import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import type { NormalizedRecruitingRepository } from './repositories/postgres-repository.js'
import { RecruitingService } from './service.js'

const timestamp = '2026-10-19T00:00:00.000Z'
const upload = {
  candidateId: 'candidate-1',
  originalFilename: 'resume.txt',
  mimeType: 'text/plain',
  content: 'John Smith\nEmail: john@example.test\nSkills: Java, PostgreSQL\nExperience: 5 years',
}

test('PostgreSQL uploads store and enqueue without synchronous extraction or identity updates', async () => {
  const calls: string[] = []
  const storage: ObjectStorage = {
    kind: 'local',
    async put(_key, body) { calls.push('put'); assert.equal(Buffer.from(body).toString(), upload.content) },
    async get() { throw new Error('upload must not read or extract the stored resume') },
    async delete() { calls.push('delete') },
    async health() { return true },
  }
  const repository = {
    async getCandidate() {
      calls.push('candidate')
      return { id: 'candidate-1', businessId: 'C-1', name: 'resume', createdAt: timestamp, updatedAt: timestamp }
    },
    async updateCandidate() { calls.push('update-candidate') },
    async createResume(input: Record<string, unknown>) {
      calls.push('resume')
      return { ...input, createdAt: timestamp }
    },
    async createAnalysisTask(input: Record<string, unknown>) {
      calls.push('task')
      return { ...input, id: 'task-1', status: 'queued', attempts: 0, availableAt: timestamp, createdAt: timestamp }
    },
  } as unknown as NormalizedRecruitingRepository
  const service = new RecruitingService(undefined, undefined, storage, repository)

  const result = await service.createResume(upload)

  assert.deepEqual(calls, ['candidate', 'put', 'resume', 'task'])
  assert.equal(result.task.status, 'queued')
  assert.equal(result.task.attempts, 0)
  assert.equal(result.task.resumeId, result.resume.id)
  assert.equal(result.resume.candidateId, 'candidate-1')
  assert.match(result.task.idempotencyKey, /^resume-analysis:/)
})

for (const status of ['queued', 'processing'] as const) {
  test(`PostgreSQL reanalysis reuses a ${status} task without rereading the resume`, async () => {
    let created = 0
    const task = {
      id: 'task-1', resumeId: 'resume-1', applicationId: null, status, attempts: 1,
      idempotencyKey: 'fixture', availableAt: timestamp, createdAt: timestamp,
    }
    const repository = {
      async getResume() { return { id: 'resume-1', candidateId: 'candidate-1', applicationId: null, scanStatus: 'clean' } },
      async listAnalysisTasks() { return [task] },
      async createAnalysisTask() { created++; throw new Error('must reuse the active task') },
    } as unknown as NormalizedRecruitingRepository
    const storage = { async get() { throw new Error('must not extract in the API') } } as unknown as ObjectStorage
    const service = new RecruitingService(undefined, undefined, storage, repository)

    const result = await service.reanalyzeResume('candidate-1', 'resume-1')

    assert.equal(result.id, task.id)
    assert.equal(result.status, status)
    assert.equal(created, 0)
  })
}
