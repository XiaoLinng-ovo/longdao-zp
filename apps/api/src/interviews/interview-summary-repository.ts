import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { InterviewSummaryReport } from './interview-summary.js'

export interface InterviewSummaryView {
  sessionId: string; status: 'none' | 'pending' | 'generating' | 'ready' | 'failed'
  report: InterviewSummaryReport | null; error: string | null; revision: number
}
export interface SummaryJob { sessionId: string; applicationId: string; revision: number; claim: string; previousReport: InterviewSummaryReport | null }
const view = (row: Record<string, unknown>): InterviewSummaryView => ({ sessionId: String(row.id),
  status: row.summary_status as InterviewSummaryView['status'], report: row.summary_report as InterviewSummaryReport | null,
  error: typeof row.summary_error === 'string' ? row.summary_error : null, revision: Number(row.summary_revision) })

export class InterviewSummaryRepository {
  constructor(private readonly pool: Pool) {}
  async latest(interviewId: string): Promise<InterviewSummaryView | null> {
    const result = await this.pool.query('SELECT id, summary_status, summary_report, summary_error, summary_revision FROM interview_live_sessions WHERE interview_id=$1::uuid ORDER BY started_at DESC, id DESC LIMIT 1', [interviewId])
    return result.rows[0] ? view(result.rows[0]) : null
  }
  async request(interviewId: string, actorId: string): Promise<InterviewSummaryView> {
    const result = await this.pool.query(`UPDATE interview_live_sessions SET
      summary_status=CASE WHEN summary_status IN ('pending','generating') THEN summary_status ELSE 'pending' END,
      summary_error=NULL, summary_requested_by=$2::uuid,
      updated_at=CASE WHEN summary_status IN ('pending','generating') THEN updated_at ELSE now() END
      WHERE id=(SELECT id FROM interview_live_sessions WHERE interview_id=$1::uuid ORDER BY started_at DESC, id DESC LIMIT 1)
      AND status='completed' RETURNING id, summary_status, summary_report, summary_error, summary_revision`, [interviewId, actorId])
    if (!result.rows[0]) throw Object.assign(new Error('请先结束并保存本场面试，再生成总结。'), { status: 409, code: 'INTERVIEW_NOT_ENDED' })
    return view(result.rows[0])
  }
  async claim(): Promise<SummaryJob | null> {
    const claim = randomUUID()
    const result = await this.pool.query(`UPDATE interview_live_sessions SET summary_status='generating', summary_claim=$1::uuid, updated_at=now()
      WHERE id=(SELECT id FROM interview_live_sessions WHERE status='completed' AND
        (summary_status='pending' OR (summary_status='generating' AND updated_at<now()-interval '15 minutes'))
        ORDER BY updated_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, summary_revision, summary_report, (SELECT application_id FROM interviews WHERE id=interview_id) AS application_id`, [claim])
    const row = result.rows[0]
    return row ? { sessionId: String(row.id), applicationId: String(row.application_id), revision: Number(row.summary_revision), claim,
      previousReport: row.summary_report as InterviewSummaryReport | null } : null
  }
  async save(job: SummaryJob, report: InterviewSummaryReport, error: string | null): Promise<boolean> {
    const result = await this.pool.query(`UPDATE interview_live_sessions SET
      summary_status=CASE WHEN $6::text IS NOT NULL AND summary_report IS NOT NULL THEN 'ready' ELSE $4 END,
      summary_report=CASE WHEN $6::text IS NOT NULL AND summary_report IS NOT NULL THEN summary_report ELSE $5::jsonb END,
      summary_error=$6, summary_claim=NULL, updated_at=now()
      WHERE id=$1::uuid AND summary_revision=$2 AND summary_claim=$3::uuid`,
    [job.sessionId, job.revision, job.claim, error ? 'failed' : 'ready', JSON.stringify(report), error?.slice(0, 600) ?? null])
    return result.rowCount === 1
  }
}
