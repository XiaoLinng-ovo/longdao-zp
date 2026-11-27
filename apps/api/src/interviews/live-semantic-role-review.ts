import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import type { Pool } from 'pg'
import { LiveInterviewSessionRepository, type LiveSegment } from './live-session-repository.js'
import type { RoleMapping } from './role-mapper.js'
import { createQuestionSheetAiResolver } from './question-sheet-runtime.js'
import { SemanticRoleReviewer, semanticRolePending, semanticRoleResolved, type SemanticRoleReview } from './semantic-role-review.js'

export type LiveRoleMapping = RoleMapping & { roleReview?: SemanticRoleReview; speakerConfirmed?: boolean }
export type LiveSemanticReviewer = (sessionId: string, turns: RoleMapping[], history: LiveSegment[]) => Promise<LiveRoleMapping[]>
export interface HistoricalRoleReview { before: LiveSegment; after: LiveRoleMapping }

export function createLiveSemanticRoleReviewer(resolveEnv: (sessionId: string) => Promise<NodeJS.ProcessEnv>,
  reviewer = new SemanticRoleReviewer(),
  saveHistory?: (sessionId: string, changes: HistoricalRoleReview[]) => Promise<unknown>): LiveSemanticReviewer {
  return async (sessionId, turns, history) => {
    if (!turns.length) return []
    let env: NodeJS.ProcessEnv = {}
    try { env = await resolveEnv(sessionId) }
    catch { /* Missing enterprise config must never leak another tenant's settings. */ }
    const currentIds = new Set(turns.map(turn => turn.id))
    const startMs = Math.min(...turns.map(turn => turn.startMs))
    // Later speech can clarify a short earlier fragment. Keep the live retry window bounded.
    const historyLimit = Math.max(0, Math.min(4, 8 - turns.length))
    const pending = saveHistory && historyLimit ? history.filter(turn => turn.sessionId === sessionId && !currentIds.has(turn.id)
      && turn.speakerConfirmed !== true && (turn.role === 'unknown' || semanticRolePending(turn))
      && turn.endMs <= startMs && turn.endMs >= startMs - 60_000)
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id)).slice(-historyLimit) : []
    const targets: LiveRoleMapping[] = [...pending.map(turn => ({ ...turn, reasons: [] })), ...turns]
    const result = await reviewer.review(targets, env, { history, timeoutMs: 12_000 })
    if (result.warnings.length) console.warn('[semantic-role-review]', { sessionId, warnings: result.warnings })
    const reviewed = new Map(result.turns.map(turn => [turn.id, turn]))
    const changes = pending.flatMap(before => {
      const after = reviewed.get(before.id)
      return after && semanticRoleResolved(after) ? [{ before, after }] : []
    })
    if (changes.length && saveHistory) {
      try { await saveHistory(sessionId, changes) }
      catch { console.warn('[semantic-role-review] historical update failed', { sessionId, count: changes.length }) }
    }
    return result.turns.filter(turn => currentIds.has(turn.id))
  }
}

export function createConfiguredLiveSemanticRoleReviewer(pool: Pool): LiveSemanticReviewer {
  const resolveApplicationEnv = createQuestionSheetAiResolver(pool, new EnterpriseAiStore(pool))
  return createLiveSemanticRoleReviewer(async sessionId => {
    const result = await pool.query('SELECT i.application_id FROM interview_live_sessions s JOIN interviews i ON i.id=s.interview_id WHERE s.id=$1::uuid', [sessionId])
    const applicationId = result.rows[0]?.application_id
    if (typeof applicationId !== 'string') throw new Error('面试会话不存在')
    return resolveApplicationEnv(applicationId)
  }, undefined, (sessionId, changes) => new LiveInterviewSessionRepository(pool).applyAutomaticRoleReviews(sessionId, changes))
}
