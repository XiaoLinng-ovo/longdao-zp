import { LocalRecruitingStore } from './store.js'

/**
 * RecruitingService is not yet wired to the normalized PostgreSQL repository.
 * Keep the local adapter for tests and fail closed elsewhere so no caller can
 * accidentally recreate the removed JSON state bridge.
 */
export function createRecruitingStore(): LocalRecruitingStore {
  if (process.env.NODE_ENV === 'test') {
    return new LocalRecruitingStore()
  }
  throw new Error('Normalized PostgreSQL recruiting repository is not wired into RecruitingService yet')
}
