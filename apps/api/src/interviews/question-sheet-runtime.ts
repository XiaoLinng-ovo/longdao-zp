import { EnterpriseAiStore, type Queryable } from '@smartrecruit-pro/enterprise-ai'
import { createDatabasePool } from '../db/connection.js'
import { QuestionSheetGenerationError } from './question-sheet-generator.js'
import { QuestionSheetRepository } from './question-sheet-repository.js'
import { QuestionSheetService } from './question-sheet-service.js'

export function createQuestionSheetAiResolver(pool: Queryable, enterpriseAi: Pick<EnterpriseAiStore, 'runtimeEnv'>) {
  return async (applicationId: string): Promise<NodeJS.ProcessEnv> => {
    const result = await pool.query(
      `SELECT a.organization_id FROM applications a
       JOIN jobs j ON j.id = a.job_id AND j.organization_id = a.organization_id
       JOIN candidates c ON c.id = a.candidate_id AND c.organization_id = a.organization_id
       WHERE a.id = $1::uuid AND organization_service_available(a.organization_id)`, [applicationId])
    const organizationId = result.rows[0]?.organization_id
    if (typeof organizationId !== 'string') throw new QuestionSheetGenerationError('INVALID_INPUT', '申请不存在或所属企业当前不可用，无法生成面试表。')
    return enterpriseAi.runtimeEnv(organizationId)
  }
}

/** HTTP requests and background generation must resolve the same enterprise model settings. */
export function createConfiguredQuestionSheetService(): QuestionSheetService {
  const pool = createDatabasePool()
  return new QuestionSheetService(new QuestionSheetRepository(pool), {
    resolveAiEnv: createQuestionSheetAiResolver(pool, new EnterpriseAiStore(pool)),
    logger: console,
  })
}
