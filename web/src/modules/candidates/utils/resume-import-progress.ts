import type { ApiResumeImportItem } from '../api'

export type ResumeUploadStatus = 'pending' | 'uploading' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'removed'

export function resumeImportItemStatus(item: ApiResumeImportItem): ResumeUploadStatus {
  if (item.status === 'pending_upload') return 'pending'
  if (item.status === 'uploading' && Date.now() - Date.parse(item.updatedAt) >= 2 * 60 * 1000) return 'failed'
  if (item.status !== 'queued') return item.status
  if (['queued', 'processing', 'completed', 'failed', 'cancelled', 'removed'].includes(item.analysisStatus || '')) {
    return item.analysisStatus as ResumeUploadStatus
  }
  // Older API versions omit analysisStatus when the referenced task has been deleted.
  return item.analysisTaskId ? 'queued' : 'removed'
}

export function isActiveResumeImportStatus(status: ResumeUploadStatus): boolean {
  return ['pending', 'uploading', 'queued', 'processing'].includes(status)
}
