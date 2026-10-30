import type { Pool } from 'pg'
import type { AudioSourceConfig, InterviewAudioSource } from './audio-source.js'

export interface InterviewAudioRecording {
  audioSource?: InterviewAudioSource; sourceRole?: AudioSourceConfig['role']; sourceMultipleSpeakers?: boolean
  id: string; sessionId: string; sessionStartedAt: string; offsetMs: number
  endMs: number | null; byteLength: number | null; contentType: string; createdAt: string
}
export interface InterviewAudioManifestEntry extends InterviewAudioRecording { objectKey: string }
interface RecordingInput { sessionId: string; objectKey: string; contentType: string; offsetMs: number; endMs: number | null; byteLength: number; audioSource?: InterviewAudioSource; sourceRole?: AudioSourceConfig['role']; sourceMultipleSpeakers?: boolean }
function map(row: Record<string, unknown>): InterviewAudioRecording {
  return { ...(row.audio_source === 'microphone' || row.audio_source === 'meeting' ? { audioSource: row.audio_source } : {}),
    ...(row.source_role ? { sourceRole: row.source_role as AudioSourceConfig['role'] } : {}),
    ...(typeof row.source_multiple_speakers === 'boolean' ? { sourceMultipleSpeakers: row.source_multiple_speakers } : {}),
    id: String(row.id), sessionId: String(row.session_id), sessionStartedAt: new Date(String(row.started_at)).toISOString(),
    offsetMs: Number(row.offset_ms), endMs: row.end_ms == null ? null : Number(row.end_ms),
    byteLength: row.byte_length == null ? null : Number(row.byte_length), contentType: String(row.content_type),
    createdAt: new Date(String(row.created_at)).toISOString() }
}
export class InterviewAudioRecordingRepository {
  constructor(private readonly pool: Pool) {}
  async save(input: RecordingInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO interview_audio_recordings (session_id,object_key,content_type,offset_ms,end_ms,byte_length,audio_source,source_role,source_multiple_speakers)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (object_key) DO UPDATE
       SET end_ms=COALESCE(EXCLUDED.end_ms,interview_audio_recordings.end_ms)`,
      [input.sessionId,input.objectKey,input.contentType,input.offsetMs,input.endMs,input.byteLength,input.audioSource ?? null,input.sourceRole ?? null,input.sourceMultipleSpeakers ?? null])
  }
  async list(interviewId: string): Promise<InterviewAudioRecording[]> {
    const result = await this.pool.query(
      `SELECT a.*,s.started_at FROM interview_audio_recordings a JOIN interview_live_sessions s ON s.id=a.session_id
       WHERE s.interview_id=$1::uuid ORDER BY s.started_at,a.offset_ms,a.id`, [interviewId])
    return result.rows.map(map)
  }
  async find(interviewId: string, recordingId: string): Promise<{ objectKey: string; contentType: string } | undefined> {
    const result = await this.pool.query(
      `SELECT a.object_key,a.content_type FROM interview_audio_recordings a JOIN interview_live_sessions s ON s.id=a.session_id
       WHERE s.interview_id=$1::uuid AND a.id=$2::uuid`, [interviewId,recordingId])
    const row = result.rows[0]
    return row ? { objectKey: String(row.object_key), contentType: String(row.content_type) } : undefined
  }
  async manifest(interviewId: string, sessionId: string): Promise<InterviewAudioManifestEntry[]> {
    const result = await this.pool.query(
      `SELECT a.*,s.started_at FROM interview_audio_recordings a JOIN interview_live_sessions s ON s.id=a.session_id
       WHERE s.interview_id=$1::uuid AND a.session_id=$2::uuid ORDER BY a.offset_ms,a.id`, [interviewId,sessionId])
    return result.rows.map(row => ({ ...map(row), objectKey: String(row.object_key) }))
  }
}
