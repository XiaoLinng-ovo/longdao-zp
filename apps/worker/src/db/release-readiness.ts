import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { assertReleaseReady } from '@smartrecruit-pro/database-readiness'
import { createInterviewObjectStorageFromEnv, createObjectStorageFromEnv, type ObjectStorage } from '@smartrecruit-pro/object-storage'

export async function checkReleaseReadiness(pool: Pool, quarantineRoot?: string, storage?: ObjectStorage): Promise<void> {
  const resume = storage ?? createObjectStorageFromEnv(process.env, quarantineRoot ?? resolve(process.cwd(), '../../data/resumes/quarantine'))
  let interview: ObjectStorage | undefined
  try {
    interview = createInterviewObjectStorageFromEnv(process.env)
    await assertReleaseReady(pool, {
      migrationsDirectory: fileURLToPath(new URL('../../../../../db/migrations/', import.meta.url)),
      tenantRouting: process.env.TENANT_SCHEMA_ROUTING === 'on',
      storageLocations: { resume: resume.locationId, interview: interview.locationId },
    })
  } finally { await Promise.all([storage ? undefined : resume.close?.(), interview?.close?.()]) }
}
