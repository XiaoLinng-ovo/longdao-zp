import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import type { Pool } from 'pg'
import type { LiveSegment } from './live-session-repository.js'
import type { RoleMapping } from './role-mapper.js'
import { createQuestionSheetAiResolver } from './question-sheet-runtime.js'
import { SemanticRoleReviewer, type SemanticRoleReview } from './semantic-role-review.js'

export type LiveRoleMapping = RoleMapping & { roleReview?: SemanticRoleReview }
export type LiveSemanticReviewer = (sessionId: string, turns: RoleMapping[], history: LiveSegment[]) => Promise<LiveRoleMapping[]>

export function createLiveSemanticRoleReviewer(resolveEnv: (sessionId: string) => Promise<NodeJS.ProcessEnv>,
  reviewer = new SemanticRoleReviewer()): LiveSemanticReviewer {
  return async (sessionId, turns, history) => {
    let env: NodeJS.ProcessEnv = {}
    try { env = await resolveEnv(sessionId) }
    catch { /* Missing enterprise config must never leak another tenant's settings. */ }
    const result = await reviewer.review(turns, env, { history, timeoutMs: 12_000 })
    if (result.warnings.length) console.warn('[semantic-role-review]', { sessionId, warnings: result.warnings })
    return result.turns
  }
}

export function createConfiguredLiveSemanticRoleReviewer(pool: Pool): LiveSemanticReviewer {
  const resolveApplicationEnv = createQuestionSheetAiResolver(pool, new EnterpriseAiStore(pool))
  return createLiveSemanticRoleReviewer(async sessionId => {
    const result = await pool.query('SELECT i.application_id FROM interview_live_sessions s JOIN interviews i ON i.id=s.interview_id WHERE s.id=$1::uuid', [sessionId])
    const applicationId = result.rows[0]?.application_id
    if (typeof applicationId !== 'string') throw new Error('面试会话不存在')
    return resolveApplicationEnv(applicationId)
  })
}
