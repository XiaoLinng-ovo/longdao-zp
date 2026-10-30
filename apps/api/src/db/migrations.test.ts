import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { Pool } from 'pg'
import { runMigrations } from './migrations.js'

test('upstream migrations follow the saved local audio and candidate migrations without changing their ledger', async () => {
  const directory = fileURLToPath(new URL('../../../../../db/migrations/', import.meta.url))
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()
  const existing = names.filter(name => name < '0056_').map(name => ({ version: name.split('_')[0]!, name }))
  assert.ok(existing.some(row => row.name === '0050_live_audio_transcription_queue.sql'))
  assert.ok(existing.some(row => row.name === '0051_candidate_manual_name.sql'))
  const recorded: unknown[][] = []
  let released = false
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql === 'SELECT version, name FROM schema_migrations ORDER BY version') return { rows: existing }
      if (sql.startsWith('INSERT INTO schema_migrations')) recorded.push(values!)
      return { rows: [] }
    },
    release() { released = true },
  }
  const pool = { connect: async () => client } as unknown as Pool
  const result = await runMigrations(pool, directory)
  assert.deepEqual(result.alreadyApplied, existing.map(row => row.name))
  const pending = names.filter(name => name >= '0056_')
  assert.ok(pending.includes('0057_interview_question_preparations.sql'))
  assert.ok(pending.includes('0058_interview_question_preparation_diagnostics.sql'))
  assert.deepEqual(result.applied, pending)
  assert.deepEqual(recorded, result.applied.map(name => [name.split('_')[0], name]))
  assert.equal(released, true)
})
