import type { Pool } from 'pg'
import { EnterpriseAiError, type EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import type { ResumeAnalysisInput } from './resume-analysis.js'

/** Only persisted task parents establish a tenant. Payload-supplied organization IDs never participate. */
export async function resolvePersistedEnterpriseAiEnv(pool: Pick<Pool, 'query'>, store: Pick<EnterpriseAiStore, 'runtimeEnv'>, input: ResumeAnalysisInput): Promise<NodeJS.ProcessEnv> {
  const result = await pool.query(`SELECT t.organization_id FROM analysis_tasks t
    JOIN resumes r ON r.id = t.resume_id AND r.organization_id = t.organization_id
    JOIN candidates c ON c.id = r.candidate_id AND c.organization_id = t.organization_id
    LEFT JOIN applications a ON a.id = t.application_id AND a.organization_id = t.organization_id AND a.candidate_id = r.candidate_id
    LEFT JOIN jobs j ON j.id = a.job_id AND j.organization_id = t.organization_id
    WHERE t.id = $1::uuid AND t.resume_id = $2::uuid AND t.application_id IS NOT DISTINCT FROM $3::uuid
      AND organization_service_available(t.organization_id)
      AND (t.application_id IS NULL OR (a.id IS NOT NULL AND j.id IS NOT NULL))`,
    [input.task.id, input.task.payload.resumeId, input.task.payload.applicationId ?? null])
  const organizationId = result.rows[0]?.organization_id
  if (!organizationId) throw new EnterpriseAiError('ANALYSIS_WORKSPACE_MISMATCH', '简历解析任务与候选人、岗位的企业归属不一致，或企业服务不可用。请联系管理员检查记录；重新选择工作空间不能修复该任务。', 409)
  return store.runtimeEnv(organizationId)
}
