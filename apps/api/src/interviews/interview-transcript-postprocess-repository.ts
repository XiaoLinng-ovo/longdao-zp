import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'
import type {
  CorrectedTranscriptTurn,
  RawTranscriptSegment,
  RawTranscriptSnapshot,
  TranscriptCorrection,
  TranscriptEvidenceSegment,
  TranscriptPostprocessPhase,
  TranscriptUncertainty,
} from './transcript-postprocessing.js'
import { correctedContentFingerprint, rawSnapshotFingerprint, transcriptRoleReviewWarning } from './transcript-postprocessing.js'
import { applyManualTranscriptRoles } from './manual-transcript-roles.js'

export interface TranscriptPostprocessJob {
  sessionId: string
  applicationId: string
  claim: string
  attempts: number
  phase: TranscriptPostprocessPhase
}

export interface TranscriptVersionInput {
  turns: CorrectedTranscriptTurn[]
  evidence: TranscriptEvidenceSegment[]
  corrections: TranscriptCorrection[]
  uncertainties: TranscriptUncertainty[]
  warnings: string[]
  audioRoutes: string[]
  roleReviewRequired?: boolean
}

export type TranscriptPublishOutcome = 'published' | 'stale' | 'lease_lost'

type Queryable = Pick<Pool, 'query'> | PoolClient

function mapSegment(row: Record<string, unknown>): RawTranscriptSegment {
  return {
    id: String(row.id),
    speakerId: String(row.speaker_id),
    role: row.role as RawTranscriptSegment['role'],
    confidence: Number(row.role_confidence),
    speakerConfirmed: row.speaker_confirmed === true,
    ...(row.role_review ? { roleReview: row.role_review as NonNullable<RawTranscriptSegment['roleReview']> } : {}),
    text: String(row.text),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    ...(row.audio_source === 'microphone' || row.audio_source === 'meeting' ? { audioSource: row.audio_source } : {}),
    ...(row.audio_object_key ? { audioObjectKey: String(row.audio_object_key) } : {}),
    ...(row.transcript_comparison ? { transcriptComparison: row.transcript_comparison } : {}),
  }
}

function mapManifest(row: Record<string, unknown>): InterviewAudioManifestEntry {
  return {
    id: String(row.id), sessionId: String(row.session_id), sessionStartedAt: new Date(String(row.started_at)).toISOString(),
    offsetMs: Number(row.offset_ms), endMs: row.end_ms == null ? null : Number(row.end_ms),
    byteLength: row.byte_length == null ? null : Number(row.byte_length), contentType: String(row.content_type),
    createdAt: new Date(String(row.created_at)).toISOString(), objectKey: String(row.object_key),
    ...(row.audio_source === 'microphone' || row.audio_source === 'meeting' ? { audioSource: row.audio_source } : {}),
    ...(row.source_role ? { sourceRole: row.source_role as NonNullable<InterviewAudioManifestEntry['sourceRole']> } : {}),
    ...(typeof row.source_multiple_speakers === 'boolean' ? { sourceMultipleSpeakers: row.source_multiple_speakers } : {}),
  }
}

async function loadSnapshot(client: Queryable, sessionId: string): Promise<RawTranscriptSnapshot> {
  // A transaction-scoped PoolClient cannot execute concurrent queries. Keep
  // the three small reads ordered so publishing cannot emit pg deprecations.
  const segments = await client.query('SELECT * FROM interview_live_segments WHERE session_id=$1::uuid ORDER BY start_ms,id', [sessionId])
  const recordings = await client.query(`SELECT a.*,s.started_at FROM interview_audio_recordings a
    JOIN interview_live_sessions s ON s.id=a.session_id
    WHERE a.session_id=$1::uuid ORDER BY a.offset_ms,a.id`, [sessionId])
  const sessions = await client.query('SELECT started_at,ended_at FROM interview_live_sessions WHERE id=$1::uuid', [sessionId])
  const rawSegments = segments.rows.map(mapSegment)
  const manifest = recordings.rows.map(mapManifest)
  const session = sessions.rows[0]
  if (!session?.started_at) throw new Error('无法读取面试时间范围。')
  const startedAt = new Date(String(session.started_at)).getTime()
  const endedAt = session.ended_at ? new Date(String(session.ended_at)).getTime() : startedAt
  const sessionDurationMs = Math.max(0, endedAt - startedAt)
  return {
    fingerprint: rawSnapshotFingerprint(rawSegments, manifest, sessionDurationMs),
    sessionDurationMs,
    segments: rawSegments,
    manifest,
  }
}

export class InterviewTranscriptPostprocessRepository {
  constructor(private readonly pool: Pool) {}

  async claim(sessionId?: string): Promise<TranscriptPostprocessJob | null> {
    const claim = randomUUID()
    const result = await this.pool.query(`UPDATE interview_transcript_postprocess_jobs j SET
      status='processing',phase='offline_reidentification',claim=$1::uuid,attempts=j.attempts+1,error=NULL,updated_at=now()
      WHERE j.session_id=(SELECT q.session_id FROM interview_transcript_postprocess_jobs q
        JOIN interview_live_sessions s ON s.id=q.session_id
        WHERE (s.status='completed' OR s.status='paused' AND s.ended_at IS NOT NULL)
          AND (q.status='pending' AND q.available_at<=now()
            OR q.status='processing' AND q.updated_at<now()-interval '15 minutes')
          AND ($2::uuid IS NULL OR q.session_id=$2::uuid)
          AND NOT EXISTS (SELECT 1 FROM interview_audio_transcription_jobs a
            WHERE a.session_id=q.session_id AND a.status<>'completed')
        ORDER BY (q.status='pending') DESC,q.available_at,q.updated_at
        FOR UPDATE OF q SKIP LOCKED LIMIT 1)
      RETURNING j.session_id,j.attempts,j.phase,
        (SELECT application_id FROM interviews WHERE id=(SELECT interview_id FROM interview_live_sessions WHERE id=j.session_id)) AS application_id`,
    [claim, sessionId ?? null])
    const row = result.rows[0]
    return row ? { sessionId: String(row.session_id), applicationId: String(row.application_id), claim,
      attempts: Number(row.attempts), phase: row.phase as TranscriptPostprocessPhase } : null
  }

  load(job: TranscriptPostprocessJob): Promise<RawTranscriptSnapshot> {
    return loadSnapshot(this.pool, job.sessionId)
  }

  async updatePhase(job: TranscriptPostprocessJob, phase: TranscriptPostprocessPhase): Promise<boolean> {
    const result = await this.pool.query(`UPDATE interview_transcript_postprocess_jobs SET phase=$3,updated_at=now()
      WHERE session_id=$1::uuid AND claim=$2::uuid AND status='processing'`, [job.sessionId, job.claim, phase])
    return result.rowCount === 1
  }

  async retry(job: TranscriptPostprocessJob, error: unknown): Promise<void> {
    const delaySeconds = Math.min(300, 5 * 2 ** Math.min(Math.max(0, job.attempts - 1), 6))
    await this.pool.query(`UPDATE interview_transcript_postprocess_jobs SET status='pending',claim=NULL,
      error=$3,available_at=now()+$4*interval '1 second',updated_at=now()
      WHERE session_id=$1::uuid AND claim=$2::uuid AND status='processing'`,
    [job.sessionId, job.claim, (error instanceof Error ? error.message : String(error)).slice(0, 1000), delaySeconds])
  }

  async publish(job: TranscriptPostprocessJob, expectedFingerprint: string, input: TranscriptVersionInput): Promise<TranscriptPublishOutcome> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Evidence invalidation locks the session before its queue row as well.
      await client.query('SELECT id FROM interview_live_sessions WHERE id=$1::uuid FOR UPDATE', [job.sessionId])
      const owned = await client.query(`SELECT j.status,j.claim,j.error,s.status AS session_status,s.ended_at,s.manual_transcript_roles,
          s.corrected_transcript_version_id,s.summary_status,s.summary_report
        FROM interview_transcript_postprocess_jobs j
        JOIN interview_live_sessions s ON s.id=j.session_id
        WHERE j.session_id=$1::uuid FOR UPDATE OF j,s`, [job.sessionId])
      const current = owned.rows[0]
      if (!current || current.status !== 'processing' || current.claim !== job.claim) {
        await client.query('ROLLBACK')
        return 'lease_lost'
      }
      if (current.session_status !== 'completed' && !(current.session_status === 'paused' && current.ended_at)) {
        await client.query(`UPDATE interview_transcript_postprocess_jobs SET status='pending',phase='offline_reidentification',
          claim=NULL,error='面试已不在完成状态，暂停发布。',available_at=now(),updated_at=now()
          WHERE session_id=$1::uuid`, [job.sessionId])
        await client.query('COMMIT')
        return 'stale'
      }

      const snapshot = await loadSnapshot(client, job.sessionId)
      if (snapshot.fingerprint !== expectedFingerprint) {
        await client.query(`UPDATE interview_transcript_postprocess_jobs SET status='pending',phase='offline_reidentification',
          claim=NULL,input_fingerprint=NULL,error='原始字幕或录音清单已变化，旧校正结果已作废并将自动重跑。',
          available_at=now(),updated_at=now() WHERE session_id=$1::uuid`, [job.sessionId])
        await client.query('COMMIT')
        return 'stale'
      }

      const turns = applyManualTranscriptRoles(input.turns, Array.isArray(current.manual_transcript_roles) ? current.manual_transcript_roles : [])
      const roleWarning = transcriptRoleReviewWarning(snapshot.manifest, turns)
      input = { ...input, turns, roleReviewRequired: Boolean(roleWarning), warnings: input.warnings.filter(warning => !warning.startsWith('角色复核未完成：')) }
      if (roleWarning) input.warnings.push(roleWarning)
      const fingerprint = correctedContentFingerprint(input.turns, input.corrections, input.uncertainties, input.warnings, input.roleReviewRequired)
      const inserted = await client.query(`INSERT INTO interview_transcript_versions
        (session_id,content_fingerprint,turns,evidence,corrections,uncertainties,metadata)
        VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb)
        ON CONFLICT (session_id,content_fingerprint) DO NOTHING RETURNING id`,
      [job.sessionId, fingerprint, JSON.stringify(input.turns), JSON.stringify(input.evidence),
        JSON.stringify(input.corrections), JSON.stringify(input.uncertainties), JSON.stringify({ audioRoutes: input.audioRoutes,
          warnings: input.warnings, roleReviewRequired: input.roleReviewRequired === true,
          attempts: job.attempts, inputFingerprint: expectedFingerprint })])
      const versionId = inserted.rows[0]?.id ?? (await client.query(
        'SELECT id FROM interview_transcript_versions WHERE session_id=$1::uuid AND content_fingerprint=$2',
        [job.sessionId, fingerprint])).rows[0]?.id
      if (!versionId) throw new Error('无法保存或读取校正版本。')

      // Completion/evidence triggers already put the summary in pending. A first
      // canonical publication should not increment its revision a second time.
      const refreshSummary = current.summary_status !== 'pending' || current.summary_report !== null
      await client.query(`UPDATE interview_live_sessions SET corrected_transcript_version_id=$2::uuid,
        summary_status=CASE WHEN $3::boolean THEN 'pending' ELSE summary_status END,
        summary_revision=summary_revision+CASE WHEN $3::boolean THEN 1 ELSE 0 END,
        summary_claim=CASE WHEN $3::boolean THEN NULL ELSE summary_claim END,
        summary_report=CASE WHEN $3::boolean THEN NULL ELSE summary_report END,
        summary_error=CASE WHEN $3::boolean THEN NULL ELSE summary_error END,
        updated_at=CASE WHEN corrected_transcript_version_id IS DISTINCT FROM $2::uuid OR $3::boolean THEN now() ELSE updated_at END
        WHERE id=$1::uuid`, [job.sessionId, String(versionId), refreshSummary])
      await client.query(`UPDATE interview_transcript_postprocess_jobs SET status='completed',phase='publishing',claim=NULL,
        input_fingerprint=$2,error=NULL,warnings=$3::jsonb,completed_at=now(),updated_at=now()
        WHERE session_id=$1::uuid`, [job.sessionId, expectedFingerprint, JSON.stringify(input.warnings)])
      await client.query('COMMIT')
      return 'published'
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}
