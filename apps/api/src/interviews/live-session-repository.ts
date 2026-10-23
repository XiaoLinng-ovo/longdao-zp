import type { Pool } from 'pg'
import type { AnalysisSourceSegment, InterviewAnswerAnalysis, TranscriptRefinement } from './answer-analyzer.js'
import type { InterviewRole, TranscriptComparison } from './role-mapper.js'
import { ACTUAL_ANSWER_PROMPT_VERSION } from './actual-answer-analysis.js'
import { simplifyTranscript } from './transcript-text.js'
import { selectUtteranceSegments } from './utterance-segments.js'

export interface LiveSession { id: string; interviewId: string; status: string; externalStatus: string; startedAt: string; endedAt?: string; createdBy: string; currentQuestion: string }
export interface LiveSegment { transcriptComparison?: TranscriptComparison; audioSource?: 'microphone' | 'meeting'; speakerConfirmed?: boolean; id: string; sessionId: string; speakerId: string; role: InterviewRole; confidence: number; text: string; startMs: number; endMs: number; status: string; analysis?: InterviewAnswerAnalysis }

function mapSession(row: Record<string, unknown>): LiveSession { return { id: String(row.id), interviewId: String(row.interview_id), status: String(row.status), externalStatus: String(row.external_status), startedAt: new Date(String(row.started_at)).toISOString(), ...(row.ended_at ? { endedAt: new Date(String(row.ended_at)).toISOString() } : {}), createdBy: String(row.created_by), currentQuestion: typeof row.current_question === 'string' ? row.current_question : '请先做一下自我介绍，并重点说明与你应聘岗位相关的经历。' } }
function mapSegment(row: Record<string, unknown>): LiveSegment { const raw=row.analysis; const analysis=raw && typeof raw==='object' ? raw as InterviewAnswerAnalysis : undefined; return { ...(row.transcript_comparison ? { transcriptComparison: row.transcript_comparison as TranscriptComparison } : {}), ...(row.audio_source === 'microphone' || row.audio_source === 'meeting' ? { audioSource: row.audio_source } : {}), speakerConfirmed: row.speaker_confirmed === true, id: String(row.id), sessionId: String(row.session_id), speakerId: String(row.speaker_id), role: String(row.role) as InterviewRole, confidence: Number(row.role_confidence), text: simplifyTranscript(String(row.text)), startMs: Number(row.start_ms), endMs: Number(row.end_ms), status: String(row.status), ...(analysis ? { analysis } : {}) } }

export class LiveInterviewSessionRepository {
  constructor(private readonly pool: Pool) {}
  async create(interviewId: string, createdBy: string): Promise<LiveSession> { try { const result = await this.pool.query('INSERT INTO interview_live_sessions (interview_id, created_by) VALUES ($1::uuid, $2::uuid) RETURNING *', [interviewId, createdBy]); return mapSession(result.rows[0]) } catch (error) { if ((error as { code?: string }).code === '23505') throw Object.assign(new Error('该面试已存在进行中的实时会话，请先结束当前会话'), { code: 'LIVE_SESSION_ALREADY_ACTIVE', status: 409 }); throw error } }
  async findActive(interviewId: string): Promise<{ session: LiveSession; segments: LiveSegment[] } | undefined> { const found=await this.pool.query("SELECT id FROM interview_live_sessions WHERE interview_id=$1::uuid AND status IN ('active','paused') ORDER BY started_at DESC LIMIT 1",[interviewId]); return found.rows[0] ? this.get(String(found.rows[0].id)) : undefined }
  async findLatest(interviewId: string): Promise<{ session: LiveSession; segments: LiveSegment[] } | undefined> { const found=await this.pool.query('SELECT id FROM interview_live_sessions WHERE interview_id=$1::uuid ORDER BY started_at DESC LIMIT 1',[interviewId]); return found.rows[0] ? this.get(String(found.rows[0].id)) : undefined }
  async get(sessionId: string): Promise<{ session: LiveSession; segments: LiveSegment[] }> { const session = await this.pool.query('SELECT * FROM interview_live_sessions WHERE id = $1::uuid', [sessionId]); if (!session.rows[0]) throw new Error('LIVE_SESSION_NOT_FOUND'); const segments = await this.pool.query(`SELECT s.*, CASE WHEN a.id IS NULL OR a.prompt_version <> 'whole-dialogue-v3' THEN NULL ELSE jsonb_build_object('summary',a.summary,'evidence',a.evidence,'scores',a.scores,'concerns',a.concerns,'confidence',a.confidence,'nextQuestion',a.next_question,'advisoryOnly',true,'applicationStatusMutation','none','transcriptRefinement',a.transcript_refinement,'sourceSegments',a.source_segments) END AS analysis FROM interview_live_segments s LEFT JOIN interview_live_analyses a ON a.segment_id=s.id WHERE s.session_id = $1::uuid ORDER BY s.start_ms, s.id`, [sessionId]); return { session: mapSession(session.rows[0]), segments: segments.rows.map(mapSegment) } }
  async addSegment(sessionId: string, input: { speakerId: string; role: InterviewRole; confidence: number; text: string; startMs: number; endMs: number; audioSource?: 'microphone' | 'meeting'; audioObjectKey?: string; transcriptComparison?: TranscriptComparison }): Promise<LiveSegment> { const result = await this.pool.query('INSERT INTO interview_live_segments (session_id, speaker_id, role, role_confidence, text, start_ms, end_ms, audio_object_key, audio_source, transcript_comparison) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *', [sessionId, input.speakerId, input.role, input.confidence, simplifyTranscript(input.text), input.startMs, input.endMs, input.audioObjectKey ?? null, input.audioSource ?? null, JSON.stringify(input.transcriptComparison ?? null)]); return mapSegment(result.rows[0]) }
  async correctRole(segmentId: string, role: Exclude<InterviewRole, 'unknown'>): Promise<LiveSegment> { const result = await this.pool.query("UPDATE interview_live_segments SET role = $2, role_confidence = 1, speaker_confirmed = true WHERE id = $1::uuid RETURNING *", [segmentId, role]); if (!result.rows[0]) throw new Error('LIVE_SEGMENT_NOT_FOUND'); return mapSegment(result.rows[0]) }
  private async selectUtterance(primarySegmentId: string, segmentIds: string[]): Promise<LiveSegment[]> {
    const result = await this.pool.query('SELECT * FROM interview_live_segments WHERE session_id = (SELECT session_id FROM interview_live_segments WHERE id = $1::uuid) ORDER BY start_ms, end_ms, id', [primarySegmentId])
    return selectUtteranceSegments(result.rows.map(mapSegment), primarySegmentId, segmentIds)
  }
  async correctUtteranceRole(primarySegmentId: string, segmentIds: string[], role: Exclude<InterviewRole, 'unknown'>): Promise<LiveSegment[]> {
    const selected = await this.selectUtterance(primarySegmentId, segmentIds)
    const result = await this.pool.query('UPDATE interview_live_segments SET role=$2, role_confidence=1, speaker_confirmed=true WHERE id=ANY($1::uuid[]) RETURNING *', [selected.map(segment => segment.id), role])
    return result.rows.map(mapSegment)
  }
  async getAnalysisContext(segmentId: string): Promise<{ segment: LiveSegment; interviewId: string; jobTitle: string; jobRequirements: string[] }> { const result=await this.pool.query(`SELECT s.*, ls.interview_id, j.title AS job_title, COALESCE(js.content, '{}'::jsonb) AS job_spec FROM interview_live_segments s JOIN interview_live_sessions ls ON ls.id=s.session_id JOIN interviews i ON i.id=ls.interview_id JOIN applications a ON a.id=i.application_id JOIN jobs j ON j.id=a.job_id LEFT JOIN LATERAL (SELECT content FROM job_spec_versions WHERE job_id=j.id ORDER BY version DESC LIMIT 1) js ON true WHERE s.id=$1::uuid`,[segmentId]); const row=result.rows[0] as Record<string,unknown>|undefined; if(!row) throw new Error('LIVE_SEGMENT_NOT_FOUND'); const spec=row.job_spec && typeof row.job_spec==='object' ? row.job_spec as Record<string,unknown> : {}; const requirements=Array.isArray(spec.requirements) ? spec.requirements.filter((item):item is string=>typeof item==='string'&&item.trim().length>0) : [JSON.stringify(spec)]; return {segment:mapSegment(row),interviewId:String(row.interview_id),jobTitle:String(row.job_title),jobRequirements:requirements.filter(Boolean)} }
  async getUtteranceText(primarySegmentId: string, segmentIds: string[]): Promise<string> {
    const selected = await this.selectUtterance(primarySegmentId, segmentIds)
    if (selected.some(segment => segment.role !== 'candidate' || segment.confidence < .6)) {
      throw Object.assign(new Error('请先确认这些分段均为候选人的回答。'), { code: 'INVALID_UTTERANCE_SEGMENTS', status: 400 })
    }
    return simplifyTranscript(selected.map(segment => segment.text).join(''))
  }
  async saveAnalysis(segmentId: string, question: string, analysis: InterviewAnswerAnalysis, model: string): Promise<LiveSegment> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("UPDATE interview_live_segments SET status = 'analyzed' WHERE id = $1::uuid", [segmentId])
      await client.query(`INSERT INTO interview_live_analyses
        (segment_id, question, summary, evidence, scores, concerns, confidence, next_question, model, prompt_version, transcript_refinement, source_segments)
        VALUES ($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12::jsonb)
        ON CONFLICT (segment_id) DO UPDATE SET question=EXCLUDED.question, summary=EXCLUDED.summary,
        evidence=EXCLUDED.evidence, scores=EXCLUDED.scores, concerns=EXCLUDED.concerns, confidence=EXCLUDED.confidence,
        next_question=EXCLUDED.next_question, model=EXCLUDED.model, prompt_version=EXCLUDED.prompt_version,
        transcript_refinement=EXCLUDED.transcript_refinement, source_segments=EXCLUDED.source_segments, created_at=now()`,
        [segmentId, question, analysis.summary, JSON.stringify(analysis.evidence), JSON.stringify(analysis.scores),
          JSON.stringify(analysis.concerns), analysis.confidence, analysis.nextQuestion, model, ACTUAL_ANSWER_PROMPT_VERSION,
          JSON.stringify(analysis.transcriptRefinement ?? null), JSON.stringify(analysis.sourceSegments ?? null)])
      await client.query('COMMIT')
      return mapSegment((await client.query('SELECT * FROM interview_live_segments WHERE id = $1::uuid', [segmentId])).rows[0])
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async updateRefinement(segmentId: string, input: { text: string; expectedText: string; sourceSegments: AnalysisSourceSegment[] }, actorId: string): Promise<TranscriptRefinement> {
    const client = await this.pool.connect()
    const conflict = () => Object.assign(new Error('发言或整理文本已更新，请刷新后重新编辑。你的修改尚未保存。'), { code: 'TRANSCRIPT_REFINEMENT_CONFLICT', status: 409 })
    const snapshot = (sources: AnalysisSourceSegment[]) => JSON.stringify(sources.map(source => [source.id, source.text, source.role, source.speakerId]))
    try {
      await client.query('BEGIN')
      // Lock speech before its analysis, matching saveAnalysis's lock order.
      const rows = await client.query('SELECT * FROM interview_live_segments WHERE session_id=(SELECT session_id FROM interview_live_segments WHERE id=$1::uuid) ORDER BY id FOR UPDATE', [segmentId])
      const segments = rows.rows.map(mapSegment)
      const current = await client.query('SELECT transcript_refinement, source_segments, prompt_version FROM interview_live_analyses WHERE segment_id=$1::uuid FOR UPDATE', [segmentId])
      const analysis = current.rows[0]
      if (!analysis?.transcript_refinement?.text || !Array.isArray(analysis.source_segments) || analysis.prompt_version !== ACTUAL_ANSWER_PROMPT_VERSION) throw conflict()
      const selected = selectUtteranceSegments(segments, segmentId, input.sourceSegments.map(source => source.id))
      if (selected.some(segment => segment.role === 'unknown' || segment.confidence < .6)
        || snapshot(selected) !== snapshot(input.sourceSegments)
        || snapshot(analysis.source_segments) !== snapshot(input.sourceSegments)
        || analysis.transcript_refinement.text !== input.expectedText) throw conflict()
      const refinement: TranscriptRefinement = { ...analysis.transcript_refinement, text: input.text.trim(), editedAt: new Date().toISOString(), editedBy: actorId }
      await client.query('UPDATE interview_live_analyses SET transcript_refinement=$2::jsonb WHERE segment_id=$1::uuid', [segmentId, JSON.stringify(refinement)])
      await client.query('COMMIT')
      return refinement
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async setCurrentQuestion(sessionId: string, question: string, source: 'manual' | 'ai_adopted', actorId: string, segmentId: string | null = null): Promise<LiveSession> { const client=await this.pool.connect(); try { await client.query('BEGIN'); const updated=await client.query('UPDATE interview_live_sessions SET current_question=$2, updated_at=now() WHERE id=$1::uuid RETURNING *',[sessionId,question]); if(!updated.rows[0]) throw new Error('LIVE_SESSION_NOT_FOUND'); await client.query('INSERT INTO interview_live_question_events (session_id, question, source, actor_id, segment_id) VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid)',[sessionId,question,source,actorId,segmentId]); await client.query('COMMIT'); return mapSession(updated.rows[0]) } catch(error) { await client.query('ROLLBACK'); throw error } finally { client.release() } }
  async end(sessionId: string): Promise<LiveSession> { const result = await this.pool.query("UPDATE interview_live_sessions SET status = 'completed', ended_at = now(), updated_at = now() WHERE id = $1::uuid RETURNING *", [sessionId]); if (!result.rows[0]) throw new Error('LIVE_SESSION_NOT_FOUND'); return mapSession(result.rows[0]) }
}
