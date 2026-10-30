import { describe, expect, it } from 'vitest'
import type { ApiResumeImportItem } from '../api'
import { isActiveResumeImportStatus, resumeImportItemStatus, type ResumeUploadStatus } from './resume-import-progress'

function item(patch: Partial<ApiResumeImportItem> = {}): ApiResumeImportItem {
  return {
    id: 'item-1', batchId: 'batch-1', ordinal: 1, clientFileId: 'file-1',
    originalFilename: 'resume.txt', mimeType: 'text/plain', sizeBytes: 6,
    status: 'queued', attempts: 1, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
    ...patch,
  }
}

describe('resume import progress states', () => {
  it('treats historical queued items without a task as removed, not waiting', () => {
    expect(resumeImportItemStatus(item())).toBe('removed')
  })

  it('supports older API responses while retaining genuine queued tasks', () => {
    expect(resumeImportItemStatus(item({ analysisTaskId: 'task-1' }))).toBe('queued')
  })

  it.each(['queued', 'processing', 'completed', 'failed', 'cancelled', 'removed'] as const)(
    'uses the actual analysis state: %s', (analysisStatus) => {
      expect(resumeImportItemStatus(item({ analysisStatus }))).toBe(analysisStatus)
    },
  )

  it.each([
    ['pending_upload', 'pending'], ['uploading', 'uploading'], ['failed', 'failed'], ['cancelled', 'cancelled'],
  ] as const)('retains the upload state %s', (status, expected) => {
    expect(resumeImportItemStatus(item({ status, updatedAt: new Date().toISOString() }))).toBe(expected)
  })

  it('allows interrupted uploads older than the server lease to be reselected and retried', () => {
    expect(resumeImportItemStatus(item({ status: 'uploading', updatedAt: new Date(Date.now() - 120001).toISOString() }))).toBe('failed')
  })

  it.each(['pending', 'uploading', 'queued', 'processing'] as ResumeUploadStatus[])('keeps polling for %s', (status) => {
    expect(isActiveResumeImportStatus(status)).toBe(true)
  })

  it.each(['completed', 'failed', 'cancelled', 'removed'] as ResumeUploadStatus[])('stops polling for %s', (status) => {
    expect(isActiveResumeImportStatus(status)).toBe(false)
  })
})
