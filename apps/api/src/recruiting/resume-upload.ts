import type { ResumeCreateInput, RepositoryClient } from './repositories/types.js'

export interface PreparedResumeUpload {
  input: ResumeCreateInput
  attempt: string
  locationId: string | null
  acknowledged: boolean
  write(): Promise<void>
}

export interface ResumeUploadResult {
  resume: { id: string }
  task: { id: string }
}

export type ResumeUploadCheckpoint = (client: RepositoryClient, result: ResumeUploadResult) => Promise<void>
