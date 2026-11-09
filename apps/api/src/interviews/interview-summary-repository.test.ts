import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { InterviewSummaryReport } from './interview-summary.js'
import { InterviewSummaryRepository, type SummaryJob } from './interview-summary-repository.js'

const job: SummaryJob = {
  sessionId: 'session-1',
  applicationId: 'application-1',
  revision: 3,
  claim: 'claim-1',
  previousReport: null,
}

function fixture() {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values })
      return { rowCount: 1, rows: [] }
    },
  }
  return { repository: new InterviewSummaryRepository(pool as never), calls }
}

it('marks a failed regeneration as failed when the retained report has no score evidence', async () => {
  const f = fixture()
  const report = { overallScore: null } as unknown as InterviewSummaryReport
  assert.equal(await f.repository.save(job, report, '模型输出不完整'), true)
  assert.equal(f.calls[0]?.values[3], 'failed')
  assert.equal(f.calls[0]?.values[4], JSON.stringify(report))
})

it('keeps a previously evidenced report ready when regeneration fails', async () => {
  const f = fixture()
  const report = { overallScore: 82 } as unknown as InterviewSummaryReport
  assert.equal(await f.repository.save(job, report, '模型输出不完整'), true)
  assert.equal(f.calls[0]?.values[3], 'ready')
})

it('marks a successful summary ready even when it is intentionally unscored', async () => {
  const f = fixture()
  const report = { overallScore: null } as unknown as InterviewSummaryReport
  assert.equal(await f.repository.save(job, report, null), true)
  assert.equal(f.calls[0]?.values[3], 'ready')
})
