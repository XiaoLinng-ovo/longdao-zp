import { LocalRecruitingStore } from './store.js'

/**
 * Legacy state-store factory retained for the test-only compatibility path.
 *
 * RecruitingService uses the normalized PostgreSQL repository directly in
 * non-test environments. Keeping this factory fail-closed outside tests
 * prevents accidental reintroduction of the removed JSON state bridge.
 */
export function createRecruitingStore(): LocalRecruitingStore {
  if (process.env.NODE_ENV === 'test') {
    return new LocalRecruitingStore()
  }
  throw new Error('Local recruiting store is test-only; production uses the normalized PostgreSQL repository')
}
