import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { createPostgresHealthPool, shouldSkipPostgresIntegration } from '../src/recruiting/db-health.js'
import { InterviewAudioRecordingRepository } from '../src/interviews/audio-recording-repository.js'

test('audio migration backfills once and independent recordings survive without transcript, remain scoped and cascade', async context => {
  if (shouldSkipPostgresIntegration()) { context.skip('PostgreSQL integration is not configured'); return }
  const pool = createPostgresHealthPool(), client = await pool.connect()
  await client.query('BEGIN')
  try {
    const schema = 'audio_test_' + randomUUID().replaceAll('-', '')
    await client.query('CREATE SCHEMA ' + schema)
    await client.query('SET LOCAL search_path TO ' + schema)
    await client.query('CREATE TABLE interview_live_sessions (id uuid PRIMARY KEY,interview_id uuid,started_at timestamptz DEFAULT now()); CREATE TABLE interview_live_segments (session_id uuid,audio_object_key text,start_ms integer,end_ms integer)')
    const interview = randomUUID(), other = randomUUID(), session = randomUUID(), otherSession = randomUUID()
    await client.query('INSERT INTO interview_live_sessions (id,interview_id) VALUES ($1,$2),($3,$4)', [session,interview,otherSession,other])
    const key = 'interviews/' + session + '/audio/15000-old.webm'
    await client.query('INSERT INTO interview_live_segments VALUES ($1,$2,15000,20000),($1,$2,20000,30000),($1,null,0,1000)', [session,key])
    const migrations = resolve(process.cwd(), '../../db/migrations')
    await client.query(await readFile(resolve(migrations, '0042_interview_audio_recordings.sql'), 'utf8'))
    await client.query(await readFile(resolve(migrations, '0043_interview_audio_sources.sql'), 'utf8'))
    const repository = new InterviewAudioRecordingRepository({ query: (sql: string, values: unknown[]) => client.query(sql, values) } as never)
    const historical = await repository.list(interview)
    assert.equal(historical.length, 1); assert.equal(historical[0]!.offsetMs, 15000); assert.equal(historical[0]!.endMs, 30000)
    assert.equal(historical[0]!.contentType, 'audio/webm')
    assert.equal(historical[0]!.audioSource, undefined)
    const sourced = { sessionId: session, objectKey: 'meeting-recording', contentType: 'audio/webm', offsetMs: 15000, endMs: 30000, byteLength: 321, audioSource: 'meeting' as const, sourceRole: 'candidate' as const, sourceMultipleSpeakers: false }
    await repository.save(sourced)
    const tagged = (await repository.list(interview)).find(row => row.audioSource === 'meeting')!
    assert.equal(tagged.sourceRole, 'candidate'); assert.equal(tagged.sourceMultipleSpeakers, false)
    assert.equal(tagged.offsetMs, 15000); assert.equal(tagged.endMs, 30000)
    await client.query('SAVEPOINT invalid_source')
    await assert.rejects(repository.save({ ...sourced, objectKey: 'invalid', audioSource: 'mixed' as never }), { code: '23514' })
    await client.query('ROLLBACK TO SAVEPOINT invalid_source')
    const input = { sessionId: session, objectKey: 'new-recording', contentType: 'audio/wav', offsetMs: 0, endMs: null, byteLength: 123 }
    await repository.save(input); await repository.save(input)
    await repository.save({ ...input, endMs: 10000 }); await repository.save(input)
    const rows = await repository.list(interview)
    assert.equal(rows.length, 3); assert.equal(rows[0]!.endMs, 10000); assert.equal(rows[0]!.byteLength, 123)
    assert.deepEqual(await repository.find(interview, rows[0]!.id), { objectKey: 'new-recording', contentType: 'audio/wav' })
    assert.equal(await repository.find(other, rows[0]!.id), undefined)
    assert.deepEqual(await repository.list(other), [])
    const manifest = await repository.manifest(interview, session)
    assert.equal(manifest.length, 3); assert.equal(manifest[0]!.objectKey, 'new-recording')
    assert.deepEqual(await repository.manifest(other, session), [])
    assert.deepEqual(await repository.manifest(interview, otherSession), [])
    await client.query('DELETE FROM interview_live_sessions WHERE id=$1', [session])
    assert.deepEqual(await repository.list(interview), [])
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end() }
})
