import type { Pool } from 'pg'
import { HttpError } from '../http.js'
import { BillingStore } from '@smartrecruit-pro/enterprise-ai'

export interface TrialQuotaUsage {
  serviceStatus: 'enabled' | 'trial' | 'suspended'
  trialEndsAt: string | null
  enforced: boolean
  resumeUploads: { used: number; limit: number; remaining: number; reached: boolean }
  interviews: { used: number; limit: number; remaining: number; reached: boolean }
  aiGeneration: { used: number; limit: number; remaining: number; reached: boolean }
}

export function mapTrialQuotaError(error: unknown): never | void {
  const candidate = error as { code?: string; message?: string }
  if (candidate?.code !== 'P0001') return
  if (candidate.message?.includes('TRIAL_RESUME_LIMIT_REACHED')) {
    throw new HttpError(409, 'TRIAL_RESUME_LIMIT_REACHED', '已达到平台设置的试用简历额度，请升级服务或联系平台管理员')
  }
  if (candidate.message?.includes('TRIAL_INTERVIEW_LIMIT_REACHED')) {
    throw new HttpError(409, 'TRIAL_INTERVIEW_LIMIT_REACHED', '已达到平台设置的试用面试额度，请升级服务或联系平台管理员')
  }
}

export class TrialQuotaService {
  constructor(private readonly pool: Pool) {}

  async read(organizationId: string): Promise<TrialQuotaUsage> {
    const result = await this.pool.query<any>(
      `SELECT o.service_status,o.trial_ends_at,
              COALESCE(u.resume_uploads,0) AS resume_uploads,
              COALESCE(ai.generations,0) AS ai_generations,
              (SELECT count(*)::integer FROM organization_trial_interviews ti
                WHERE ti.organization_id=o.id) AS interviews
         FROM organizations o
         LEFT JOIN organization_trial_usage u ON u.organization_id=o.id
         LEFT JOIN organization_trial_ai_usage ai ON ai.organization_id=o.id
        WHERE o.id=$1::uuid`,
      [organizationId],
    )
    const row = result.rows[0]
    if (!row) throw new HttpError(404, 'NOT_FOUND', '企业不存在')
    const enforced = false
    const trial=(await new BillingStore(this.pool).policy()).config.trial
    const TRIAL_RESUME_LIMIT=trial.resumeUploads, TRIAL_INTERVIEW_LIMIT=trial.interviews, TRIAL_AI_GENERATION_LIMIT=trial.aiGenerations
    const resumeUsed = Number(row.resume_uploads)
    const interviewUsed = Number(row.interviews)
    const aiGenerationUsed = Number(row.ai_generations)
    return {
      serviceStatus: row.service_status,
      trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
      enforced,
      resumeUploads: {
        used: resumeUsed,
        limit: TRIAL_RESUME_LIMIT,
        remaining: Math.max(0, TRIAL_RESUME_LIMIT - resumeUsed),
        reached: enforced && resumeUsed >= TRIAL_RESUME_LIMIT,
      },
      interviews: {
        used: interviewUsed,
        limit: TRIAL_INTERVIEW_LIMIT,
        remaining: Math.max(0, TRIAL_INTERVIEW_LIMIT - interviewUsed),
        reached: enforced && interviewUsed >= TRIAL_INTERVIEW_LIMIT,
      },
      aiGeneration: {
        used: aiGenerationUsed,
        limit: TRIAL_AI_GENERATION_LIMIT,
        remaining: Math.max(0, TRIAL_AI_GENERATION_LIMIT - aiGenerationUsed),
        reached: enforced && aiGenerationUsed >= TRIAL_AI_GENERATION_LIMIT,
      },
    }
  }
}
