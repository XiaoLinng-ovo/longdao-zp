import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RecruitingService } from './service.js'
import { LocalRecruitingStore } from './store.js'
import type { NormalizedRecruitingRepository } from './repositories/postgres-repository.js'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'

function fixture() {
  const store = new LocalRecruitingStore()
  const files = new Map<string, Buffer>()
  let reads = 0
  const storage: ObjectStorage = { kind: 'local', async put(key, bytes) { files.set(key, Buffer.from(bytes)) }, async get(key) { reads++; const file = files.get(key); if (!file) throw new Error('missing'); return file }, async delete(key) { files.delete(key) }, async health() { return true } }
  const service = new RecruitingService(store, undefined, storage)
  return { store, files, storage, service, reads: () => reads }
}
async function upload(service: RecruitingService) { return service.createResume({ candidateId: 'candidate-8821', originalFilename: '原始简历.txt', mimeType: 'text/plain', content: '原始简历\n完整经历与技能' }) }

describe('original resume document access', () => {
  it('returns the exact uploaded bytes without reading analysis output', async () => {
    const { service } = fixture(); const { resume } = await upload(service)
    const document = await service.getResumeDocument(resume.candidateId, resume.id)
    assert.equal(Buffer.from(document.content, 'base64').toString('utf8'), '原始简历\n完整经历与技能')
    assert.equal(document.originalFilename, '原始简历.txt')
    assert.equal(document.mimeType, 'text/plain')
    assert.equal(document.previewHtml, undefined)
  })
  it('does not read storage for another candidate or a missing resume', async () => {
    const { service, reads } = fixture(); const { resume } = await upload(service)
    await assert.rejects(service.getResumeDocument('candidate-8814', resume.id), (error: any) => error.code === 'RESUME_CANDIDATE_MISMATCH')
    await assert.rejects(service.getResumeDocument(resume.candidateId, 'missing'), (error: any) => error.status === 404)
    assert.equal(reads(), 0)
  })
  it('blocks infected documents before accessing storage and preserves the existing scan policy', async () => {
    const { store, service, reads } = fixture(); const { resume } = await upload(service)
    await store.transaction(state => { state.resumes.find(item => item.id === resume.id)!.scanStatus = 'infected' })
    await assert.rejects(service.getResumeDocument(resume.candidateId, resume.id), (error: any) => error.code === 'RESUME_SCAN_NOT_CLEAN')
    assert.equal(reads(), 0)
    await store.transaction(state => { state.resumes.find(item => item.id === resume.id)!.scanStatus = 'quarantined' })
    assert.ok((await service.getResumeDocument(resume.candidateId, resume.id)).content)
  })
  it('preserves the original download when DOCX conversion fails', async () => {
    const { store, service, files } = fixture(); const { resume } = await upload(service)
    await store.transaction(state => { const item = state.resumes.find(item => item.id === resume.id)!; item.originalFilename = 'broken.docx'; item.mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    const original = Buffer.from([80, 75, 0, 255]); files.set(resume.storageKey, original)
    const document = await service.getResumeDocument(resume.candidateId, resume.id)
    assert.deepEqual(Buffer.from(document.content, 'base64'), original)
    assert.equal(document.previewHtml, undefined)
  })
  it('converts the real Word document while preserving its original bytes', async () => {
    const { service } = fixture()
    const content = await readFile(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../测试简历-张伟.docx'))
    const { resume } = await service.createResume({ candidateId: 'candidate-8821', originalFilename: '原始.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: content.toString('base64'), encoding: 'base64' })
    const document = await service.getResumeDocument(resume.candidateId, resume.id)
    assert.match(document.previewHtml!, /张伟/)
    assert.deepEqual(Buffer.from(document.content, 'base64'), content)
  })
  it('returns an actionable error when original storage is unavailable', async () => {
    const { service, files } = fixture(); const { resume } = await upload(service); files.clear()
    await assert.rejects(service.getResumeDocument(resume.candidateId, resume.id), (error: any) => error.code === 'OBJECT_STORAGE_UNAVAILABLE' && error.status === 503)
  })
  it('uses the organization-scoped repository and never falls back to another tenant', async () => {
    const { storage, reads } = fixture()
    let requested = ''
    const repository = { withOrganization(id: string) { requested = id; return this }, async getResume() { throw Object.assign(new Error('not found in tenant'), { status: 404 }) } } as unknown as NormalizedRecruitingRepository
    const service = new RecruitingService(undefined, undefined, storage, repository).forOrganization('enterprise-a')
    await assert.rejects(service.getResumeDocument('candidate', 'foreign-resume'), /not found in tenant/)
    assert.equal(requested, 'enterprise-a'); assert.equal(reads(), 0)
  })
})

