import { resolve } from 'node:path'
import { PostgresAnalysisTaskStore, type AnalysisTaskRecord } from './analysis-task-store.js'
import type { ResumeAnalysisTaskPayload } from '../handlers/resume-analysis.js'
import { extractResumeText } from '../resume-text-extractor.js'
import { createLocalObjectStorage, type ObjectStorage } from '@smartrecruit-pro/object-storage'

export interface ResumePayloadResolverOptions {
  quarantineRoot?: string
  storage?: ObjectStorage
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
    const content = options.storage
      ? await options.storage.get(source.storageKey)
      : await createLocalObjectStorage(quarantineRoot).get(source.storageKey)
    const text = await extractResumeText(content, source.originalFilename, source.mimeType)
    const jobId = task.applicationId ? await store.getApplicationJob(task.applicationId) : undefined
    const jobContext = jobId ? await store.getJobAnalysisContext(jobId) : undefined

    return {
      ...(task.applicationId === undefined ? {} : { applicationId: task.applicationId }),
      resumeId: source.resumeId,
      candidateId: source.candidateId,
      ...(jobId === undefined ? {} : { jobId }),
      ...(jobContext === undefined ? {} : { jobTitle: jobContext.title, jobRequirements: jobContext.requirements, jobSkills: jobContext.skills }),
      fileName: source.originalFilename,
      mimeType: source.mimeType ?? 'text/plain',
      text,
      ...(source.contentHash === undefined ? {} : { contentSha256: source.contentHash }),
      source: 'upload',
    }
  }
}
