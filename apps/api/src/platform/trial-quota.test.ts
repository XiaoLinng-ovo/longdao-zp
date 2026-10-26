import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { mapTrialQuotaError, TrialQuotaService } from './trial-quota.js'

test('trial quota migration enforces three resume and interview inserts', async () => {
  let root = process.cwd()
  while (!existsSync(join(root, 'db/migrations/0052_trial_feature_quotas.sql')) && dirname(root) !== root) root = dirname(root)
  const sql = await readFile(resolve(root, 'db/migrations/0052_trial_feature_quotas.sql'), 'utf8')
  assert.match(sql, /organization_trial_usage/u)
  assert.match(sql, /organization_trial_interviews/u)
  assert.match(sql, /resume_uploads < 3/u)
  assert.match(sql, /BEFORE INSERT ON resumes/u)
  assert.match(sql, /BEFORE INSERT ON interview_live_sessions/u)
  assert.match(sql, /BEFORE INSERT OR UPDATE OF status ON interview_feedback/u)
  assert.doesNotMatch(sql, /BEFORE INSERT ON interviews/u)
})

test('trial quota read reports remaining uses only while the service is trial', async () => {
  const pool = {
    query: async () => ({
      rows: [{ service_status: 'trial', trial_ends_at: new Date('2026-11-09T00:00:00Z'), resume_uploads: 2, interviews: 3 }],
    }),
  } as unknown as Pool
  const usage = await new TrialQuotaService(pool).read('11111111-1111-4111-8111-111111111111')
  assert.equal(usage.enforced, true)
  assert.deepEqual(usage.resumeUploads, { used: 2, limit: 3, remaining: 1, reached: false })
  assert.deepEqual(usage.interviews, { used: 3, limit: 3, remaining: 0, reached: true })
})

test('database trial errors map to actionable quota HTTP errors', () => {
  assert.throws(() => mapTrialQuotaError({ code: 'P0001', message: 'TRIAL_RESUME_LIMIT_REACHED' }), {
    status: 409,
    code: 'TRIAL_RESUME_LIMIT_REACHED',
  })
  assert.throws(() => mapTrialQuotaError({ code: 'P0001', message: 'TRIAL_INTERVIEW_LIMIT_REACHED' }), {
    status: 409,
    code: 'TRIAL_INTERVIEW_LIMIT_REACHED',
  })
  assert.doesNotThrow(() => mapTrialQuotaError({ code: 'P0001', message: 'OTHER_DATABASE_ERROR' }))
})
