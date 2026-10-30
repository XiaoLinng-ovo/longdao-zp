import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import { createDatabasePool } from '../db/connection.js'
import { RecruitingService } from '../recruiting/service.js'
import { MemoryInterviewQuestionSetRepository, PostgresInterviewQuestionSetRepository, type InterviewQuestionSetRepository } from './interview-question-set-repository.js'
import { createInterviewQuestionGenerator, InterviewQuestionGenerationError, loadInterviewQuestionGeneratorConfig } from './question-generator.js'
import { MemoryPreparationRepository, PostgresPreparationRepository } from './question-preparation-repository.js'
import { QuestionPreparationService } from './question-preparation-service.js'
import { createConfiguredQuestionSheetService } from './question-sheet-runtime.js'

export function createConfiguredQuestionPreparationService(options: { recruiting?: RecruitingService; questions?: InterviewQuestionSetRepository } = {}): QuestionPreparationService {
  const pool = createDatabasePool()
  const enterpriseAi = new EnterpriseAiStore(pool)
  const recruiting = options.recruiting ?? new RecruitingService()
  const sheets = createConfiguredQuestionSheetService()
  const scoped = async (id: string) => {
    if (process.env.NODE_ENV === 'test') return { recruiting, organizationId: undefined }
    const result = await pool.query(`SELECT a.organization_id FROM interviews i JOIN applications a ON a.id = i.application_id
      WHERE i.id = $1::uuid AND organization_service_available(a.organization_id)`, [id])
    const organizationId: string | undefined = result.rows[0]?.organization_id
    if (!organizationId) throw new InterviewQuestionGenerationError('INVALID_INPUT', '面试不存在或所属企业当前不可用。')
    return { recruiting: recruiting.forOrganization(organizationId), organizationId }
  }
  return new QuestionPreparationService(process.env.NODE_ENV === 'test' ? new MemoryPreparationRepository() : new PostgresPreparationRepository(pool), {
    questions: options.questions ?? (process.env.NODE_ENV === 'test' ? new MemoryInterviewQuestionSetRepository() : new PostgresInterviewQuestionSetRepository(pool)),
    interview: async id => (await scoped(id)).recruiting.getInterview(id),
    context: async id => (await scoped(id)).recruiting.getInterviewQuestionContext(id),
    generate: async (id, input, group) => {
      const { organizationId } = await scoped(id)
      const config = loadInterviewQuestionGeneratorConfig(await enterpriseAi.runtimeEnv(organizationId))
      try { return await createInterviewQuestionGenerator(config).generateGroup(input, group) }
      catch (error) {
        if (error instanceof InterviewQuestionGenerationError) {
          throw new InterviewQuestionGenerationError(error.code, error.message, error.cause, { ...error.diagnostic, model: config.model })
        }
        throw error
      }
    },
    prepareRubrics: async (interview, actorId) => {
      const result = await sheets.requestStageGeneration(interview.applicationId, interview.stage ?? (interview.round >= 2 ? 'final' : 'initial'), actorId)
      if (result.sheets.some(sheet => sheet.failed)) throw new Error('Assessment preparation failed')
      return result.sheets.some(sheet => sheet.queued) ? 'queued' : 'ready'
    },
    logger: console,
  })
}
