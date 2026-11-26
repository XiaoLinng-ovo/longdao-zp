import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { InterviewSummaryReport } from './interview-summary.js'

export interface InterviewSummaryView {
  sessionId: string; status: 'none' | 'pending' | 'generating' | 'ready' | 'failed'
  report: InterviewSummaryReport | null; error: string | null; revision: number; stale?: boolean
  phase?: 'transcribing' | 'role_review' | 'scoring' | 'failed' | 'ready' | 'idle'
}
export interface SummaryJob { sessionId: string; applicationId: string; revision: number; claim: string; previousReport: InterviewSummaryReport | null }
const view = (row: Record<string, unknown>): InterviewSummaryView => ({ sessionId: String(row.id),
  status: row.summary_status as InterviewSummaryView['status'], report: row.summary_report as InterviewSummaryReport | null,
  error: typeof row.summary_error === 'string' ? row.summary_error : null, revision: Number(row.summary_revision), stale: row.summary_stale === true })

export class InterviewSummaryRepository {
  constructor(private readonly pool: Pool) {}
  async latest(interviewId: string): Promise<InterviewSummaryView | null> {
    const result = await this.pool.query('SELECT id, summary_status, summary_report, summary_error, summary_revision, summary_stale FROM interview_live_sessions WHERE interview_id=$1::uuid ORDER BY started_at DESC, id DESC LIMIT 1', [interviewId])
    const row = result.rows[0]
    if (!row) return null
    const progress = await this.pool.query(
      "SELECT EXISTS(SELECT 1 FROM interview_audio_transcription_jobs WHERE session_id=$1::uuid AND status<>'completed') AS audio_pending, (SELECT status FROM interview_transcript_postprocess_jobs WHERE session_id=$1::uuid) AS postprocess_status, (SELECT error FROM interview_audio_transcription_jobs WHERE session_id=$1::uuid AND status='failed' LIMIT 1) AS audio_error, (SELECT error FROM interview_transcript_postprocess_jobs WHERE session_id=$1::uuid AND status='failed') AS postprocess_error", [row.id])
    const state = progress.rows[0] ?? {}
    const current = view(row)
    if (state.audio_error || state.postprocess_error) return { ...current, status: 'failed' as const, phase: 'failed' as const, error: String(state.audio_error || state.postprocess_error) }
    return { ...current, phase: state.audio_pending ? 'transcribing' as const : state.postprocess_status && state.postprocess_status !== 'completed' ? 'role_review' as const : current.status === 'pending' || current.status === 'generating' ? 'scoring' as const : current.status === 'ready' ? 'ready' as const : 'idle' as const }
  }
  async history(interviewId: string) {
    const result = await this.pool.query('SELECT v.id,v.revision,v.transcript_version_id,v.report,v.created_at FROM interview_summary_versions v JOIN interview_live_sessions s ON s.id=v.session_id WHERE s.interview_id=$1::uuid ORDER BY v.created_at DESC,v.id DESC LIMIT 30', [interviewId])
    return result.rows.map(row => ({ id: String(row.id), revision: Number(row.revision), transcriptVersionId: row.transcript_version_id, report: row.report as InterviewSummaryReport, createdAt: String(row.created_at) }))
  }
  async request(interviewId: string, actorId: string): Promise<InterviewSummaryView> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const row = (await client.query("SELECT * FROM interview_live_sessions WHERE interview_id=$1::uuid ORDER BY started_at DESC,id DESC LIMIT 1 FOR UPDATE", [interviewId])).rows[0]
      if (!row || !row.ended_at || !['paused','completed'].includes(String(row.status))) throw Object.assign(new Error('请先结束并保存本场面试，再生成总结。'), { status: 409, code: 'INTERVIEW_NOT_ENDED' })
      for (const table of ['interview_audio_transcription_jobs', 'interview_transcript_postprocess_jobs']) {
        await client.query("UPDATE " + table + " SET status='pending',attempts=0,claim=NULL,error=NULL,available_at=now(),updated_at=now() WHERE session_id=$1::uuid AND status='failed'", [row.id])
      }
      const result = await client.query("UPDATE interview_live_sessions SET summary_status=CASE WHEN summary_status IN ('pending','generating') THEN summary_status ELSE 'pending' END,summary_error=NULL,summary_requested_by=$2::uuid,summary_revision=summary_revision+CASE WHEN summary_status IN ('pending','generating') THEN 0 ELSE 1 END,updated_at=CASE WHEN summary_status IN ('pending','generating') THEN updated_at ELSE now() END WHERE id=$1::uuid RETURNING *", [row.id,actorId])
      await client.query('COMMIT')
      return view(result.rows[0]!)
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
  async claim(): Promise<SummaryJob | null> {
    // Recover old stopped sessions without requiring a browser to press End again.
    await this.pool.query("UPDATE interview_live_sessions s SET status='completed',updated_at=now() WHERE status='paused' AND ended_at IS NOT NULL AND corrected_transcript_version_id IS NOT NULL AND EXISTS(SELECT 1 FROM interview_transcript_postprocess_jobs p WHERE p.session_id=s.id AND p.status='completed') AND NOT EXISTS(SELECT 1 FROM interview_audio_transcription_jobs a WHERE a.session_id=s.id AND a.status<>'completed')")
    await this.pool.query("UPDATE interview_live_sessions s SET summary_status='failed',summary_claim=NULL,summary_error='录音转写或角色整理失败，已停止自动重试，请重新评分以重试处理。',updated_at=now() WHERE summary_status IN ('pending','generating') AND (EXISTS(SELECT 1 FROM interview_audio_transcription_jobs a WHERE a.session_id=s.id AND a.status='failed') OR EXISTS(SELECT 1 FROM interview_transcript_postprocess_jobs p WHERE p.session_id=s.id AND p.status='failed'))")
    const claim = randomUUID()
    const result = await this.pool.query(`UPDATE interview_live_sessions SET summary_status='generating', summary_claim=$1::uuid, updated_at=now()
      WHERE id=(SELECT id FROM interview_live_sessions s WHERE status='completed'
        AND NOT EXISTS (SELECT 1 FROM interview_audio_transcription_jobs j WHERE j.session_id=s.id AND j.status<>'completed')
        AND NOT EXISTS (SELECT 1 FROM interview_transcript_postprocess_jobs p WHERE p.session_id=s.id AND p.status<>'completed') AND
        (summary_status='pending' AND (summary_error IS DISTINCT FROM '后台通道繁忙，正在排队等待自动继续' OR updated_at<=now()-interval '5 seconds') OR (summary_status='generating' AND updated_at<now()-interval '15 minutes'))
        ORDER BY updated_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, summary_revision, summary_report, (SELECT application_id FROM interviews WHERE id=interview_id) AS application_id`, [claim])
    const row = result.rows[0]
    return row ? { sessionId: String(row.id), applicationId: String(row.application_id), revision: Number(row.summary_revision), claim,
      previousReport: row.summary_report as InterviewSummaryReport | null } : null
  }
  async defer(job: SummaryJob): Promise<void> {
    await this.pool.query(`UPDATE interview_live_sessions SET summary_status='pending',summary_claim=NULL,
      summary_error='后台通道繁忙，正在排队等待自动继续',updated_at=now()
      WHERE id=$1::uuid AND summary_revision=$2 AND summary_claim=$3::uuid`, [job.sessionId,job.revision,job.claim])
  }
  async save(job: SummaryJob, report: InterviewSummaryReport, error: string | null): Promise<boolean> {
    const result = await this.pool.query(`UPDATE interview_live_sessions SET
      summary_status=$4,
      summary_report=$5::jsonb,
      summary_error=$6, summary_claim=NULL,summary_stale=CASE WHEN $6::text IS NULL THEN false ELSE summary_stale END, updated_at=now()
      WHERE id=$1::uuid AND summary_revision=$2 AND summary_claim=$3::uuid`,
    [job.sessionId, job.revision, job.claim, error ? 'failed' : 'ready', JSON.stringify(report), error?.slice(0, 600) ?? null])
    return result.rowCount === 1
  }
}
