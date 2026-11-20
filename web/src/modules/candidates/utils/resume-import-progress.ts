import type { ApiResumeImportBatch, ApiResumeImportBatchPhase, ApiResumeImportItem } from '../api'

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

export function resumeImportBatchPhase(batch: ApiResumeImportBatch): ApiResumeImportBatchPhase {
  if (batch.phase) return batch.phase
  const statuses = batch.items.map(resumeImportItemStatus)
  if (batch.status === 'cancelled') return 'cancelled'
  if (statuses.some(status => status === 'pending' || status === 'uploading')) return 'uploading'
  if (statuses.some(status => status === 'processing')) return 'analyzing'
  if (statuses.some(status => status === 'queued')) return 'waiting_analysis'
  if (statuses.some(status => ['failed', 'removed'].includes(status))) return 'completed_with_issues'
  return 'completed'
}

export function resumeImportBatchProgress(batch: ApiResumeImportBatch) {
  const statuses = batch.items.map(resumeImportItemStatus)
  const uploaded = statuses.filter(status => ['queued', 'processing', 'completed', 'failed', 'removed'].includes(status)).length
  return {
    phase: resumeImportBatchPhase(batch),
    total: statuses.length,
    uploaded,
    uploadFailed: statuses.filter((status, index) => status === 'failed' && !batch.items[index]?.analysisTaskId).length,
    uploadProcessing: statuses.filter(status => ['pending', 'uploading'].includes(status)).length,
    queued: statuses.filter(status => status === 'queued').length,
    analyzing: statuses.filter(status => status === 'processing').length,
    completed: statuses.filter(status => status === 'completed').length,
    analysisFailed: statuses.filter((status, index) => status === 'failed' && !!batch.items[index]?.analysisTaskId).length,
    removed: statuses.filter(status => status === 'removed').length,
    cancelled: statuses.filter(status => status === 'cancelled').length,
    terminalAnalysis: statuses.filter(status => ['completed', 'failed', 'removed', 'cancelled'].includes(status)).length,
  }
}
