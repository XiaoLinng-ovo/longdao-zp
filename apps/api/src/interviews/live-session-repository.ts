import type { Pool } from 'pg'
import type { AnalysisSourceSegment, InterviewAnswerAnalysis, TranscriptRefinement } from './answer-analyzer.js'
import type { InterviewRole, TranscriptComparison } from './role-mapper.js'
import { ACTUAL_ANSWER_PROMPT_VERSION } from './actual-answer-analysis.js'
import { simplifyTranscript } from './transcript-text.js'
import { selectUtteranceSegments } from './utterance-segments.js'
import { loadCompletionReview, loadRoleManifest, type CompletionReview } from './completion-review.js'
import { correctedContentFingerprint, transcriptRoleReviewWarning, type CorrectedTranscriptTurn } from './transcript-postprocessing.js'
import type { ManualTranscriptRole } from './manual-transcript-roles.js'

import type { SemanticRoleReview } from './semantic-role-review.js'
function sessionNotFound() { return Object.assign(new Error('未找到该面试录音会话'), { code: 'LIVE_SESSION_NOT_FOUND', status: 404 }) }
function segmentNotFound() { return Object.assign(new Error('未找到该面试发言分段'), { code: 'LIVE_SEGMENT_NOT_FOUND', status: 404 }) }
export interface LiveSession { id: string; interviewId: string; status: string; externalStatus: string; startedAt: string; endedAt?: string; createdBy: string; currentQuestion: string }
export interface LiveSegment { roleReview?: SemanticRoleReview; transcriptComparison?: TranscriptComparison; audioSource?: 'microphone' | 'meeting'; speakerConfirmed?: boolean; id: string; sessionId: string; speakerId: string; role: InterviewRole; confidence: number; text: string; startMs: number; endMs: number; status: string; analysis?: InterviewAnswerAnalysis }

function mapSession(row: Record<string, unknown>): LiveSession { return { id: String(row.id), interviewId: String(row.interview_id), status: String(row.status), externalStatus: String(row.external_status), startedAt: new Date(String(row.started_at)).toISOString(), ...(row.ended_at ? { endedAt: new Date(String(row.ended_at)).toISOString() } : {}), createdBy: String(row.created_by), currentQuestion: typeof row.current_question === 'string' ? row.current_question : '请先做一下自我介绍，并重点说明与你应聘岗位相关的经历。' } }
function mapSegment(row: Record<string, unknown>): LiveSegment { const raw=row.analysis; const analysis=raw && typeof raw==='object' ? raw as InterviewAnswerAnalysis : undefined; return { ...(row.role_review ? { roleReview: row.role_review as SemanticRoleReview } : {}), ...(row.transcript_comparison ? { transcriptComparison: row.transcript_comparison as TranscriptComparison } : {}), ...(row.audio_source === 'microphone' || row.audio_source === 'meeting' ? { audioSource: row.audio_source } : {}), speakerConfirmed: row.speaker_confirmed === true, id: String(row.id), sessionId: String(row.session_id), speakerId: String(row.speaker_id), role: String(row.role) as InterviewRole, confidence: Number(row.role_confidence), text: simplifyTranscript(String(row.text)), startMs: Number(row.start_ms), endMs: Number(row.end_ms), status: String(row.status), ...(analysis ? { analysis } : {}) } }
function mapCorrectedTurn(row: Record<string, unknown>, sessionId: string): LiveSegment {
  return {
    ...(row.roleReview ? { roleReview: row.roleReview as SemanticRoleReview } : {}),
    ...(row.audioSource === 'microphone' || row.audioSource === 'meeting' ? { audioSource: row.audioSource } : {}),
    id: String(row.id), sessionId, speakerId: String(row.speakerId), role: String(row.role) as InterviewRole,
    confidence: Number(row.confidence), text: simplifyTranscript(String(row.text)), startMs: Number(row.startMs),
    endMs: Number(row.endMs), status: 'transcribed', speakerConfirmed: row.speakerConfirmed === true,
  }
}

export class LiveInterviewSessionRepository {
  constructor(private readonly pool: Pick<Pool, 'query'> | Pick<Pool, 'query' | 'connect'>) {}
  private transactionClient() {
    if (!('connect' in this.pool)) throw new Error('TRANSACTION_POOL_REQUIRED')
    return this.pool.connect()
  }
  async create(interviewId: string, createdBy: string): Promise<LiveSession> {
    const client = await this.transactionClient()
    try {
      await client.query('BEGIN')
      const interview = await client.query('SELECT status, stage, round, scheduled_start_at, participants FROM interviews WHERE id = $1::uuid FOR UPDATE', [interviewId])
      const interviewStatus = interview.rows[0]?.status
      if (!interviewStatus) throw Object.assign(new Error('未找到该面试'), { code: 'INTERVIEW_NOT_FOUND', status: 404 })
      if (interviewStatus === 'completed') throw Object.assign(new Error('面试已完成，不能重新创建实时会话'), { code: 'INTERVIEW_ALREADY_COMPLETED', status: 409 })
      if (interviewStatus === 'cancelled') throw Object.assign(new Error('面试已取消，不能创建实时会话'), { code: 'INTERVIEW_CANCELLED', status: 409 })
      if (interviewStatus !== 'scheduled') throw Object.assign(new Error('仅已排期的面试可以创建实时会话'), { code: 'INTERVIEW_NOT_SCHEDULED', status: 409 })
      const row = interview.rows[0]!
      if ((row.stage === 'final' || Number(row.round) >= 2) && (!row.scheduled_start_at || !Array.isArray(row.participants)
        || !row.participants.some((person: { userId?: string; role?: string }) => person.userId && (person.role ?? 'interviewer') === 'interviewer'))) {
        throw Object.assign(new Error('请先确认复试时间和面试官，再进入面试室'), { code: 'INTERVIEW_SCHEDULE_INCOMPLETE', status: 409 })
      }
      const result = await client.query('INSERT INTO interview_live_sessions (interview_id, created_by) VALUES ($1::uuid, $2::uuid) RETURNING *', [interviewId, createdBy])
      await client.query('COMMIT')
      return mapSession(result.rows[0])
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      const candidate = error as { code?: string; message?: string }
      if (candidate.code === '23505') throw Object.assign(new Error('该面试已存在进行中的实时会话，请先结束当前会话'), { code: 'LIVE_SESSION_ALREADY_ACTIVE', status: 409 })
      // 数据库触发器是绕过 HTTP 状态校验时的最后一道防线。把 P0001 领域异常
      // 还原成带状态码的错误，否则前端只会看到 500「服务器内部错误」。
      if (candidate.code === 'P0001' && candidate.message) {
        const known: Record<string, { status: number; message: string }> = {
          INTERVIEW_ALREADY_COMPLETED: { status: 409, message: '面试已完成，不能重新创建实时会话' },
          INTERVIEW_CANCELLED: { status: 409, message: '面试已取消，不能创建实时会话' },
          INTERVIEW_NOT_SCHEDULED: { status: 409, message: '仅已排期的面试可以创建实时会话' },
          INTERVIEW_NOT_FOUND: { status: 404, message: '未找到该面试' },
          TRIAL_INTERVIEW_LIMIT_REACHED: { status: 409, message: '已达到平台设置的试用面试额度，请升级服务或联系平台管理员' },
        }
        const mapped = known[candidate.message.trim()]
        if (mapped) throw Object.assign(new Error(mapped.message), { code: candidate.message.trim(), status: mapped.status })
      }
      throw error
    } finally {
      client.release()
    }
  }
  async findActive(interviewId: string): Promise<{ session: LiveSession; segments: LiveSegment[] } | undefined> { const found=await this.pool.query("SELECT id FROM interview_live_sessions WHERE interview_id=$1::uuid AND status IN ('active','paused') ORDER BY started_at DESC LIMIT 1",[interviewId]); return found.rows[0] ? this.get(String(found.rows[0].id)) : undefined }
  async findLatest(interviewId: string) { const found=await this.pool.query('SELECT id FROM interview_live_sessions WHERE interview_id=$1::uuid ORDER BY started_at DESC LIMIT 1',[interviewId]); return found.rows[0] ? this.get(String(found.rows[0].id)) : undefined }
  async get(sessionId: string): Promise<{ session: LiveSession; segments: LiveSegment[]; completionReview?: CompletionReview; transcriptWarnings?: string[]; transcriptRoleReviewRequired?: boolean }> {
    const session = await this.pool.query('SELECT * FROM interview_live_sessions WHERE id = $1::uuid', [sessionId])
    if (!session.rows[0]) throw sessionNotFound()
    const completionReview = await loadCompletionReview(this.pool, session.rows[0])
    const versionId = session.rows[0].corrected_transcript_version_id
    if (typeof versionId === 'string') {
      const version = await this.pool.query('SELECT turns, metadata FROM interview_transcript_versions WHERE id=$1::uuid AND session_id=$2::uuid', [versionId, sessionId])
      if (Array.isArray(version.rows[0]?.turns)) {
        const warnings = Array.isArray(version.rows[0].metadata?.warnings)
          ? version.rows[0].metadata.warnings.filter((warning: unknown): warning is string => typeof warning === 'string' && Boolean(warning.trim()))
          : []
        return { session: mapSession(session.rows[0]), ...(completionReview ? { completionReview } : {}), segments: version.rows[0].turns.map((row: Record<string, unknown>) => mapCorrectedTurn(row, sessionId)), transcriptWarnings: warnings,
          transcriptRoleReviewRequired: version.rows[0].metadata?.roleReviewRequired === true }
      }
    }
    const segments = await this.pool.query(`SELECT s.*, CASE WHEN a.id IS NULL OR a.prompt_version <> 'whole-dialogue-v3' THEN NULL ELSE jsonb_build_object('summary',a.summary,'evidence',a.evidence,'scores',a.scores,'concerns',a.concerns,'confidence',a.confidence,'nextQuestion',a.next_question,'advisoryOnly',true,'applicationStatusMutation','none','transcriptRefinement',a.transcript_refinement,'sourceSegments',a.source_segments) END AS analysis FROM interview_live_segments s LEFT JOIN interview_live_analyses a ON a.segment_id=s.id WHERE s.session_id = $1::uuid ORDER BY s.start_ms, s.id`, [sessionId])
    return { session: mapSession(session.rows[0]), ...(completionReview ? { completionReview } : {}), segments: segments.rows.map(mapSegment) }
  }
  async addSegment(sessionId: string, input: { speakerId: string; role: InterviewRole; confidence: number; text: string; startMs: number; endMs: number; audioSource?: 'microphone' | 'meeting'; audioObjectKey?: string; transcriptComparison?: TranscriptComparison; roleReview?: SemanticRoleReview }, connection: Pick<Pool, 'query'> = this.pool): Promise<LiveSegment> { const result = await connection.query('INSERT INTO interview_live_segments (session_id, speaker_id, role, role_confidence, text, start_ms, end_ms, audio_object_key, audio_source, transcript_comparison, role_review) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) RETURNING *', [sessionId, input.speakerId, input.role, input.confidence, simplifyTranscript(input.text), input.startMs, input.endMs, input.audioObjectKey ?? null, input.audioSource ?? null, JSON.stringify(input.transcriptComparison ?? null), input.roleReview ? JSON.stringify(input.roleReview) : null]); return mapSegment(result.rows[0]) }
  async correctRole(segmentId: string, role: Exclude<InterviewRole, 'unknown'>): Promise<LiveSegment> { const result = await this.pool.query("UPDATE interview_live_segments SET role = $2, role_confidence = 1, speaker_confirmed = true WHERE id = $1::uuid RETURNING *", [segmentId, role]); if (!result.rows[0]) throw segmentNotFound(); return mapSegment(result.rows[0]) }
  private async selectUtterance(primarySegmentId: string, segmentIds: string[]): Promise<LiveSegment[]> {
    const result = await this.pool.query('SELECT * FROM interview_live_segments WHERE session_id = (SELECT session_id FROM interview_live_segments WHERE id = $1::uuid) ORDER BY start_ms, end_ms, id', [primarySegmentId])
    if (!result.rows.some(row => String(row.id) === primarySegmentId)) throw segmentNotFound()
    return selectUtteranceSegments(result.rows.map(mapSegment), primarySegmentId, segmentIds)
  }
  async correctUtteranceRole(primarySegmentId: string, segmentIds: string[], role: Exclude<InterviewRole, 'unknown'>): Promise<LiveSegment[]> {
    const selected = await this.selectUtterance(primarySegmentId, segmentIds)
    const result = await this.pool.query('UPDATE interview_live_segments SET role=$2, role_confidence=1, speaker_confirmed=true WHERE id=ANY($1::uuid[]) RETURNING *', [selected.map(segment => segment.id), role])
    return result.rows.map(mapSegment)
  }
  async getAnalysisContext(segmentId: string): Promise<{ segment: LiveSegment; interviewId: string; jobTitle: string; jobRequirements: string[] }> { const result=await this.pool.query(`SELECT s.*, ls.interview_id, j.title AS job_title, COALESCE(js.content, '{}'::jsonb) AS job_spec FROM interview_live_segments s JOIN interview_live_sessions ls ON ls.id=s.session_id JOIN interviews i ON i.id=ls.interview_id JOIN applications a ON a.id=i.application_id JOIN jobs j ON j.id=a.job_id LEFT JOIN LATERAL (SELECT content FROM job_spec_versions WHERE job_id=j.id ORDER BY version DESC LIMIT 1) js ON true WHERE s.id=$1::uuid`,[segmentId]); const row=result.rows[0] as Record<string,unknown>|undefined; if(!row) throw segmentNotFound(); const spec=row.job_spec && typeof row.job_spec==='object' ? row.job_spec as Record<string,unknown> : {}; const requirements=Array.isArray(spec.requirements) ? spec.requirements.filter((item):item is string=>typeof item==='string'&&item.trim().length>0) : [JSON.stringify(spec)]; return {segment:mapSegment(row),interviewId:String(row.interview_id),jobTitle:String(row.job_title),jobRequirements:requirements.filter(Boolean)} }
  async getUtteranceText(primarySegmentId: string, segmentIds: string[]): Promise<string> {
    const selected = await this.selectUtterance(primarySegmentId, segmentIds)
    if (selected.some(segment => segment.role !== 'candidate' || segment.confidence < .6)) {
      throw Object.assign(new Error('请先确认这些分段均为候选人的回答。'), { code: 'INVALID_UTTERANCE_SEGMENTS', status: 400 })
    }
    return simplifyTranscript(selected.map(segment => segment.text).join(''))
  }
  async saveAnalysis(segmentId: string, question: string, analysis: InterviewAnswerAnalysis, model: string): Promise<LiveSegment> {
    const client = await this.transactionClient()
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
    const client = await this.transactionClient()
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
  async setCurrentQuestion(sessionId: string, question: string, source: 'manual' | 'ai_adopted', actorId: string, segmentId: string | null = null): Promise<LiveSession> { const client=await this.transactionClient(); try { await client.query('BEGIN'); const updated=await client.query('UPDATE interview_live_sessions SET current_question=$2, updated_at=now() WHERE id=$1::uuid RETURNING *',[sessionId,question]); if(!updated.rows[0]) throw sessionNotFound(); await client.query('INSERT INTO interview_live_question_events (session_id, question, source, actor_id, segment_id) VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid)',[sessionId,question,source,actorId,segmentId]); await client.query('COMMIT'); return mapSession(updated.rows[0]) } catch(error) { await client.query('ROLLBACK'); throw error } finally { client.release() } }
  async end(sessionId: string): Promise<LiveSession & { completionReview?: CompletionReview }> {
    const client = await this.transactionClient()
    try {
      await client.query('BEGIN')
      let row = (await client.query('SELECT * FROM interview_live_sessions WHERE id=$1::uuid FOR UPDATE', [sessionId])).rows[0]
      if (!row) throw sessionNotFound()
      if (row.status === 'failed') throw Object.assign(new Error('该录音会话已取消，不能结束。'), { code: 'LIVE_SESSION_CLOSED', status: 409 })
      if (row.status !== 'completed' && !row.ended_at) {
        row = (await client.query("UPDATE interview_live_sessions SET status='paused',ended_at=COALESCE(ended_at,now()),updated_at=now() WHERE id=$1::uuid RETURNING *", [sessionId])).rows[0]
      }
      let completionReview = await loadCompletionReview(client, row)
      if (row.status !== 'completed' && completionReview?.phase === 'ready') {
        row = (await client.query("UPDATE interview_live_sessions SET status='completed',updated_at=now() WHERE id=$1::uuid RETURNING *", [sessionId])).rows[0]
        completionReview = { ...completionReview, phase: 'completed' }
      }
      await client.query('COMMIT')
      return { ...mapSession(row), ...(completionReview ? { completionReview } : {}) }
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async correctTranscriptRoles(sessionId: string, versionId: string, turnIds: string[], role: 'candidate' | 'interviewer', actorId: string) {
    const client = await this.transactionClient()
    const conflict = () => Object.assign(new Error('转写版本已更新，请刷新后重新选择说话角色。'), { code: 'TRANSCRIPT_VERSION_CONFLICT', status: 409 })
    try {
      await client.query('BEGIN')
      const session = (await client.query('SELECT * FROM interview_live_sessions WHERE id=$1::uuid FOR UPDATE', [sessionId])).rows[0]
      if (!session) throw sessionNotFound()
      if (session.status !== 'paused' || !session.ended_at) throw Object.assign(new Error('仅停录后待复核的会话可以修正整理版本。'), { code: 'LIVE_SESSION_NOT_REVIEWABLE', status: 409 })
      if (session.corrected_transcript_version_id !== versionId) throw conflict()
      const review = await loadCompletionReview(client, session)
      if (!review || review.phase === 'processing') throw conflict()
      const version = (await client.query('SELECT * FROM interview_transcript_versions WHERE id=$1::uuid AND session_id=$2::uuid', [versionId, sessionId])).rows[0]
      if (!version || !Array.isArray(version.turns)) throw conflict()
      const ids = new Set(turnIds)
      if (!ids.size || ids.size > 1000 || [...ids].some(id => !version.turns.some((turn: CorrectedTranscriptTurn) => turn.id === id))) throw conflict()
      const turns: CorrectedTranscriptTurn[] = version.turns.map((turn: CorrectedTranscriptTurn) => ids.has(turn.id) ? { ...turn, role, confidence: 1, speakerConfirmed: true } : turn)
      const prior: ManualTranscriptRole[] = Array.isArray(session.manual_transcript_roles) ? session.manual_transcript_roles : []
      const manual = [...prior.filter(turn => !ids.has(turn.id)), ...turns.filter(turn => ids.has(turn.id)).map(({ id, text, startMs, endMs, audioSource, role }) => ({ id, text, startMs, endMs, audioSource, role }))]
      const warning = transcriptRoleReviewWarning(await loadRoleManifest(client, sessionId), turns)
      const warnings: string[] = (version.metadata?.warnings ?? []).filter((value: string) => !value.startsWith('角色复核未完成：'))
      if (warning) warnings.push(warning)
      const metadata = { ...version.metadata, warnings, roleReviewRequired: Boolean(warning), reviewedBy: actorId, reviewedFrom: versionId }
      const fingerprint = correctedContentFingerprint(turns, version.corrections, version.uncertainties, warnings, Boolean(warning))
      await client.query(`INSERT INTO interview_transcript_versions (session_id,content_fingerprint,turns,evidence,corrections,uncertainties,metadata)
        VALUES ($1::uuid,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb) ON CONFLICT (session_id,content_fingerprint) DO NOTHING`,
        [sessionId, fingerprint, JSON.stringify(turns), JSON.stringify(version.evidence), JSON.stringify(version.corrections), JSON.stringify(version.uncertainties), JSON.stringify(metadata)])
      const next = (await client.query('SELECT id FROM interview_transcript_versions WHERE session_id=$1::uuid AND content_fingerprint=$2', [sessionId, fingerprint])).rows[0]
      if (!next) throw conflict()
      await client.query(`UPDATE interview_live_sessions SET corrected_transcript_version_id=$2::uuid,manual_transcript_roles=$3::jsonb,
        summary_revision=summary_revision+1,summary_status='pending',summary_claim=NULL,summary_report=NULL,summary_error=NULL,updated_at=now() WHERE id=$1::uuid`,
        [sessionId, next.id, JSON.stringify(manual)])
      await client.query("UPDATE interview_transcript_postprocess_jobs SET warnings=$2::jsonb,updated_at=now() WHERE session_id=$1::uuid AND status='completed'", [sessionId, JSON.stringify(warnings)])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return this.get(sessionId)
  }
}
