import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AudioSourceConfig } from './audio-source.js'
import { LiveInterviewSessionRepository } from './live-session-repository.js'
import type { TranscriptCheckpoint } from './transcript-checkpoint.js'

export interface AudioTranscriptionJob {
  objectKey: string; sessionId: string; contentType: string; offsetMs: number; endMs: number
  source?: AudioSourceConfig; checkpoint?: TranscriptCheckpoint; claim: string; attempts: number
}
export interface AudioTranscriptionProgress { pendingCount: number; retryingCount: number }
export type TranscribedSegmentInput = Parameters<LiveInterviewSessionRepository['addSegment']>[1]

export class LiveAudioTranscriptionRepository {
  constructor(private readonly pool: Pool) {}
  async enqueue(objectKey: string, sessionId: string, source: AudioSourceConfig | undefined, checkpoint: TranscriptCheckpoint | undefined): Promise<void> {
    await this.pool.query(`INSERT INTO interview_audio_transcription_jobs (object_key,session_id,audio_source,checkpoint)
      VALUES ($1,$2::uuid,$3,$4::jsonb) ON CONFLICT (object_key) DO NOTHING`,
    [objectKey, sessionId, source?.id ?? null, JSON.stringify(checkpoint ?? null)])
  }
  async progress(sessionId: string): Promise<AudioTranscriptionProgress> {
    const result = await this.pool.query(`SELECT count(*) FILTER (WHERE status<>'completed') AS pending,
      count(*) FILTER (WHERE status<>'completed' AND error IS NOT NULL) AS retrying
      FROM interview_audio_transcription_jobs WHERE session_id=$1::uuid`, [sessionId])
    return { pendingCount: Number(result.rows[0]?.pending ?? 0), retryingCount: Number(result.rows[0]?.retrying ?? 0) }
  }
  async claim(): Promise<AudioTranscriptionJob | null> {
    const claim = randomUUID()
    // Serialize each source, but let another source/interview progress during retries.
    const result = await this.pool.query(`UPDATE interview_audio_transcription_jobs j SET
      status='processing',claim=$1::uuid,attempts=j.attempts+1,updated_at=now()
      WHERE j.object_key=(SELECT q.object_key FROM interview_audio_transcription_jobs q
        JOIN interview_audio_recordings a ON a.object_key=q.object_key
        WHERE (q.status='pending' AND q.available_at<=now() OR q.status='processing' AND q.updated_at<now()-interval '15 minutes')
        AND NOT EXISTS (SELECT 1 FROM interview_audio_transcription_jobs prior
          JOIN interview_audio_recordings p ON p.object_key=prior.object_key
          WHERE prior.session_id=q.session_id AND prior.audio_source IS NOT DISTINCT FROM q.audio_source
            AND prior.object_key<>q.object_key AND prior.status<>'completed'
            AND (prior.status='processing' AND prior.updated_at>=now()-interval '15 minutes'
              OR (p.offset_ms,p.created_at,p.id)<(a.offset_ms,a.created_at,a.id)))
        ORDER BY q.available_at,a.offset_ms,a.created_at FOR UPDATE OF q SKIP LOCKED LIMIT 1)
      RETURNING j.*, (SELECT row_to_json(a) FROM interview_audio_recordings a WHERE a.object_key=j.object_key) AS recording`, [claim])
    const row = result.rows[0]
    if (!row) return null
    const audio = row.recording
    return { objectKey: String(row.object_key), sessionId: String(row.session_id), contentType: String(audio.content_type),
      offsetMs: Number(audio.offset_ms), endMs: Number(audio.end_ms), claim, attempts: Number(row.attempts),
      ...(audio.audio_source ? { source: { id: audio.audio_source, role: audio.source_role, multipleSpeakers: audio.source_multiple_speakers } } : {}),
      ...(row.checkpoint ? { checkpoint: row.checkpoint as TranscriptCheckpoint } : {}) }
  }
  async complete(job: AudioTranscriptionJob, segments: TranscribedSegmentInput[]): Promise<boolean> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const owned = await client.query(`SELECT object_key FROM interview_audio_transcription_jobs
        WHERE object_key=$1 AND claim=$2::uuid AND status='processing' FOR UPDATE`, [job.objectKey, job.claim])
      if (!owned.rowCount) { await client.query('ROLLBACK'); return false }
      const sessions = new LiveInterviewSessionRepository(this.pool)
      for (const segment of segments) await sessions.addSegment(job.sessionId, segment, client)
      await client.query(`UPDATE interview_audio_transcription_jobs SET status='completed',claim=NULL,error=NULL,updated_at=now()
        WHERE object_key=$1`, [job.objectKey])
      await client.query('COMMIT')
      return true
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async retry(job: AudioTranscriptionJob, error: unknown): Promise<void> {
    const delaySeconds = Math.min(300, 5 * 2 ** Math.min(job.attempts - 1, 6))
    await this.pool.query(`UPDATE interview_audio_transcription_jobs SET status='pending',claim=NULL,error=$3,
      available_at=now()+$4*interval '1 second',updated_at=now() WHERE object_key=$1 AND claim=$2::uuid`,
    [job.objectKey, job.claim, (error instanceof Error ? error.message : String(error)).slice(0, 600), delaySeconds])
  }
}
