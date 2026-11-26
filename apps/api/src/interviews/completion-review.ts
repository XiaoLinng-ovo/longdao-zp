import type { QueryResultRow } from 'pg'
import type { InterviewAudioManifestEntry } from './audio-recording-repository.js'
import type { CorrectedTranscriptTurn } from './transcript-postprocessing.js'
import { unresolvedTranscriptTurns } from './transcript-postprocessing.js'

export const MAX_UNRESOLVED_SPEAKER_TURNS = 30
export interface CompletionReview {
  phase: 'processing' | 'review_required' | 'ready' | 'completed' | 'failed'
  error?: string
  unresolvedCount: number
  unresolvedIds: string[]
  limit: number
  versionId?: string
}
type Queryable = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> }

export function evaluateCompletionReview(turns: CorrectedTranscriptTurn[], manifest: InterviewAudioManifestEntry[], versionId?: string): CompletionReview {
  const unresolvedIds = unresolvedTranscriptTurns(manifest, turns).map(turn => turn.id)
  return { phase: 'ready',
    unresolvedCount: unresolvedIds.length, unresolvedIds, limit: MAX_UNRESOLVED_SPEAKER_TURNS, ...(versionId ? { versionId } : {}) }
}

export async function loadRoleManifest(db: Queryable, sessionId: string): Promise<InterviewAudioManifestEntry[]> {
  const rows = await db.query('SELECT audio_source,source_multiple_speakers,offset_ms,end_ms FROM interview_audio_recordings WHERE session_id=$1::uuid', [sessionId])
  return rows.rows.map(row => ({ audioSource: row.audio_source ?? undefined, sourceMultipleSpeakers: row.source_multiple_speakers ?? undefined,
    offsetMs: Number(row.offset_ms), endMs: row.end_ms == null ? null : Number(row.end_ms) } as InterviewAudioManifestEntry))
}

export async function loadCompletionReview(db: Queryable, session: Record<string, unknown>): Promise<CompletionReview | undefined> {
  if (!session.ended_at && session.status !== 'completed') return undefined
  const base: CompletionReview = { phase: 'processing', unresolvedCount: 0, unresolvedIds: [], limit: MAX_UNRESOLVED_SPEAKER_TURNS }
  const failures = await db.query("SELECT error FROM interview_audio_transcription_jobs WHERE session_id=$1::uuid AND status='failed' UNION ALL SELECT error FROM interview_transcript_postprocess_jobs WHERE session_id=$1::uuid AND status='failed' LIMIT 1", [session.id])
  if (failures.rows[0]?.error) return { ...base, phase: 'failed', error: String(failures.rows[0].error) }
  const versionId = session.corrected_transcript_version_id
  if (typeof versionId !== 'string') return session.status === 'completed' ? { ...base, phase: 'completed' } : base
  const versions = await db.query('SELECT turns FROM interview_transcript_versions WHERE id=$1::uuid AND session_id=$2::uuid', [versionId, session.id])
  if (!Array.isArray(versions.rows[0]?.turns)) return session.status === 'completed' ? { ...base, phase: 'completed' } : base
  const result = evaluateCompletionReview(versions.rows[0].turns, await loadRoleManifest(db, String(session.id)), versionId)
  // Historical completions remain closed, without pretending uncertain roles were confirmed.
  if (session.status === 'completed') return { ...result, phase: 'completed' }
  const pending = await db.query(
    "SELECT EXISTS(SELECT 1 FROM interview_audio_transcription_jobs WHERE session_id=$1::uuid AND status<>'completed') AS audio_pending, (SELECT status FROM interview_transcript_postprocess_jobs WHERE session_id=$1::uuid) AS postprocess_status", [session.id])
  return pending.rows[0]?.audio_pending || pending.rows[0]?.postprocess_status !== 'completed' ? { ...result, phase: 'processing' } : result
}

export async function assertInterviewSessionsEnded(db: Queryable, interviewId: string): Promise<void> {
  const sessions = await db.query("SELECT * FROM interview_live_sessions WHERE interview_id=$1::uuid AND status IN ('active','paused') ORDER BY id FOR UPDATE", [interviewId])
  for (const session of sessions.rows) {
    const review = await loadCompletionReview(db, session)
    throw Object.assign(new Error(review?.phase === 'failed' ? '录音自动处理失败，请重试处理后提交面试结论。' : '录音正在保存或自动整理，请完成后提交面试结论。'), { code: 'INTERVIEW_SESSION_NOT_ENDED', status: 409 })
  }
}
