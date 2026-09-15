import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import {
  PostgresAnalysisTaskStore,
  PostgresIdempotencyStore,
  createPostgresAnalysisTaskStore,
} from '../src/db/analysis-task-store.js'
import { createResumePayloadResolver } from '../src/db/payload.js'
import { startPersistedPoll } from '../src/db/persisted-poll.js'
import { processNextPersistedResumeAnalysis } from '../src/handlers/persisted-resume-analysis.js'
import { createTaskExecutor } from '../src/runner.js'

const CLAIM_NOW = '2026-09-10T00:00:00.000Z'

function hasPostgresCredentials(): boolean {
  if (process.env.PGPASSWORD?.trim()) return true
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) return false
  try {
    return Boolean(new URL(databaseUrl).password)
  } catch {
    return false
  }
}

const integrationSkip = hasPostgresCredentials()
  ? false
  : 'PGPASSWORD or a password-bearing DATABASE_URL is not configured'

interface Seed {
  candidateId: string
  resumeId: string
  taskId: string
  idempotencyKey: string
}

const resumeText = '张三\nTypeScript Node.js PostgreSQL 五年后端经验'

async function seedResumeAnalysis(pool: Pool, quarantineRoot: string): Promise<Seed> {
  const candidateId = randomUUID()
  const resumeId = randomUUID()
  const taskId = randomUUID()
  const idempotencyKey = `resume-analysis:${resumeId}:${randomUUID()}`

  await writeFile(join(quarantineRoot, `${resumeId}.txt`), resumeText, 'utf8')

  await pool.query(
    `INSERT INTO candidates (id, candidate_no, name) VALUES ($1::uuid, $2, $3)`,
    [candidateId, `CAN-${randomUUID().slice(0, 8).toUpperCase()}`, '集成测试候选人'],
  )
  await pool.query(
    `INSERT INTO resumes (id, candidate_id, storage_key, original_filename, mime_type, size_bytes, content_hash)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
    [resumeId, candidateId, `${resumeId}.txt`, 'resume.txt', 'text/plain', Buffer.byteLength(resumeText, 'utf8'), null],
  )
  await pool.query(
    `INSERT INTO analysis_tasks (id, resume_id, status, attempts, idempotency_key, available_at)
     VALUES ($1::uuid, $2::uuid, 'queued', 0, $3, $4::timestamptz)`,
    [taskId, resumeId, idempotencyKey, CLAIM_NOW],
  )

  return { candidateId, resumeId, taskId, idempotencyKey }
}

async function cleanupSeed(pool: Pool, seed: Seed): Promise<void> {
  await pool.query('DELETE FROM analysis_tasks WHERE id = $1::uuid', [seed.taskId])
  await pool.query('DELETE FROM resumes WHERE id = $1::uuid', [seed.resumeId])
  await pool.query('DELETE FROM candidates WHERE id = $1::uuid', [seed.candidateId])
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`condition not satisfied within ${timeoutMs}ms`)
}

test('consumes a persisted resume-analysis task end-to-end and fences by idempotency', { skip: integrationSkip }, async () => {
  const pool = new Pool({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE || 'smartrecruit',
    }),
  })
  const quarantineRoot = await mkdtemp(join(tmpdir(), 'smartrecruit-worker-it-'))
  const seed = await seedResumeAnalysis(pool, quarantineRoot)

  try {
    const store = createPostgresAnalysisTaskStore(pool)
    const resolver = createResumePayloadResolver(store, { quarantineRoot })
    const executor = createTaskExecutor({
      idempotencyStore: new PostgresIdempotencyStore(store),
      now: () => CLAIM_NOW,
    })

    const outcome = await processNextPersistedResumeAnalysis({
      store,
      executor,
      claim: { maxAttempts: 3, leaseDurationMs: 60_000, now: CLAIM_NOW },
      payloadFor: resolver,
    })

    assert.ok(outcome, 'expected a queued task to be claimed')
    assert.equal(outcome.execution.status, 'completed')
    assert.equal(outcome.execution.result?.safety.advisoryOnly, true)

    const row = await pool.query<{ status: string }>(
      'SELECT status FROM analysis_tasks WHERE id = $1::uuid',
      [seed.taskId],
    )
    assert.equal(row.rows[0]?.status, 'completed')

    const persistedResult = await store.getResult(seed.taskId)
    assert.ok(persistedResult, 'expected analysis_results row to be persisted')
    assert.equal(persistedResult.humanReviewStatus, 'pending')

    // A completed task must not be claimed again by the next tick.
    const next = await processNextPersistedResumeAnalysis({
      store,
      executor,
      claim: { maxAttempts: 3, leaseDurationMs: 60_000, now: CLAIM_NOW },
      payloadFor: resolver,
    })
    assert.equal(next, undefined)
  } finally {
    await cleanupSeed(pool, seed).catch(() => undefined)
    await rm(quarantineRoot, { recursive: true, force: true })
    await pool.end()
  }
})

test('startPersistedPoll drains a queued task from PostgreSQL into a completed result', { skip: integrationSkip }, async () => {
  const pool = new Pool({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE || 'smartrecruit',
    }),
  })
  const quarantineRoot = await mkdtemp(join(tmpdir(), 'smartrecruit-worker-poll-'))
  const seed = await seedResumeAnalysis(pool, quarantineRoot)

  const stop = startPersistedPoll({
    store: new PostgresAnalysisTaskStore(pool),
    pool,
    maxAttempts: 3,
    leaseDurationMs: 60_000,
    pollIntervalMs: 50,
    quarantineRoot,
    now: () => CLAIM_NOW,
    logger: { log() {}, warn() {}, error() {} },
  })

  try {
    await waitFor(async () => {
      const result = await pool.query<{ status: string }>(
        'SELECT status FROM analysis_tasks WHERE id = $1::uuid',
        [seed.taskId],
      )
      return result.rows[0]?.status === 'completed'
    }, 5000)

    const count = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM analysis_results WHERE analysis_task_id = $1::uuid',
      [seed.taskId],
    )
    assert.equal(count.rows[0]?.count, '1')
  } finally {
    stop()
    await cleanupSeed(pool, seed).catch(() => undefined)
    await rm(quarantineRoot, { recursive: true, force: true })
    await pool.end()
  }
})