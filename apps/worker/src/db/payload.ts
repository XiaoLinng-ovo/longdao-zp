import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PostgresAnalysisTaskStore, type AnalysisTaskRecord } from './analysis-task-store.js'
import type { ResumeAnalysisTaskPayload } from '../handlers/resume-analysis.js'

export interface ResumePayloadResolverOptions {
  quarantineRoot?: string
}

/**
 * Resolves a payload for a persisted analysis task by reading resume metadata
 * from PostgreSQL and the quarantine file from the shared API upload directory.
 * `applicationId` is optional because resume-only analysis is legal.
 */
export function createResumePayloadResolver(
  store: PostgresAnalysisTaskStore,
  options: ResumePayloadResolverOptions = {},
): (task: AnalysisTaskRecord) => Promise<ResumeAnalysisTaskPayload> {
  const quarantineRoot = options.quarantineRoot ?? process.env.RECRUITING_QUARANTINE_ROOT ?? resolve(process.cwd(), '../../data/resumes/quarantine')

  return async (task) => {
    const source = await store.getResumeAnalysisSource(task.resumeId)
    const text = await readFile(resolve(quarantineRoot, source.storageKey), 'utf8')
    const jobId = task.applicationId ? await store.getApplicationJob(task.applicationId) : undefined

    return {
      ...(task.applicationId === undefined ? {} : { applicationId: task.applicationId }),
      resumeId: source.resumeId,
      candidateId: source.candidateId,
      ...(jobId === undefined ? {} : { jobId }),
      fileName: source.originalFilename,
      mimeType: source.mimeType ?? 'text/plain',
      text,
      ...(source.contentHash === undefined ? {} : { contentSha256: source.contentHash }),
      source: 'upload',
    }
  }
}