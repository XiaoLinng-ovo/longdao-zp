import type { Pool } from 'pg'
import { HttpError } from '../http.js'

export const TRIAL_RESUME_LIMIT = 3
export const TRIAL_INTERVIEW_LIMIT = 3

export interface TrialQuotaUsage {
  serviceStatus: 'enabled' | 'trial' | 'suspended'
  trialEndsAt: string | null
  enforced: boolean
  resumeUploads: { used: number; limit: number; remaining: number; reached: boolean }
  interviews: { used: number; limit: number; remaining: number; reached: boolean }
}

export function mapTrialQuotaError(error: unknown): never | void {
  const candidate = error as { code?: string; message?: string }
  if (candidate?.code !== 'P0001') return
  if (candidate.message?.includes('TRIAL_RESUME_LIMIT_REACHED')) {
    throw new HttpError(409, 'TRIAL_RESUME_LIMIT_REACHED', '试用期内最多上传 3 份简历，请升级套餐或联系平台管理员')
  }
  if (candidate.message?.includes('TRIAL_INTERVIEW_LIMIT_REACHED')) {
    throw new HttpError(409, 'TRIAL_INTERVIEW_LIMIT_REACHED', '试用期内最多进行 3 场真实面试，请升级套餐或联系平台管理员')
  }
}

export class TrialQuotaService {
  constructor(private readonly pool: Pool) {}

  async read(organizationId: string): Promise<TrialQuotaUsage> {
    const result = await this.pool.query<any>(
      `SELECT o.service_status,o.trial_ends_at,
              COALESCE(u.resume_uploads,0) AS resume_uploads,
              (SELECT count(*)::integer FROM organization_trial_interviews ti
                WHERE ti.organization_id=o.id) AS interviews
         FROM organizations o
         LEFT JOIN organization_trial_usage u ON u.organization_id=o.id
        WHERE o.id=$1::uuid`,
      [organizationId],
    )
    const row = result.rows[0]
    if (!row) throw new HttpError(404, 'NOT_FOUND', '企业不存在')
    const enforced = row.service_status === 'trial'
    const resumeUsed = Number(row.resume_uploads)
    const interviewUsed = Number(row.interviews)
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
    }
  }
}
