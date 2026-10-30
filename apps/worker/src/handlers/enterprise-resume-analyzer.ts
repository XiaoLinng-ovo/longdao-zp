import { EnterpriseAiError } from '@smartrecruit-pro/enterprise-ai'
import { createOpenAIResumeAnalyzer } from './openai-resume-analyzer.js'
import { defaultAnalyzer, type ResumeAnalyzer, type ResumeAnalysisInput } from './resume-analysis.js'
import { WorkerFailure } from '../errors.js'

/** Resolve configuration for each persisted task; do not cache secrets between tasks or use process-global provider keys. */
export function createEnterpriseResumeAnalyzer(resolveEnv: (input: ResumeAnalysisInput) => Promise<NodeJS.ProcessEnv>): ResumeAnalyzer {
  return async (input) => {
    let env: NodeJS.ProcessEnv
    try { env = await resolveEnv(input) }
    catch (error) {
      if (error instanceof EnterpriseAiError) throw new WorkerFailure(error.message, { category: 'dependency_unavailable', code: error.code, retryable: false })
      throw error
    }
    if (!env.OPENAI_BASE_URL || !env.OPENAI_API_KEY || !env.OPENAI_MODEL) {
      if (input.task.payload.scoringSkill || input.task.payload.jobRequirements?.some(value => value.trim()) || input.task.payload.jobSkills?.some(value => value.trim())) throw new WorkerFailure('当前企业尚未配置 AI 模型，不能执行岗位语义或 Skill 评分', { category: 'validation', code: 'ENTERPRISE_AI_NOT_CONFIGURED', retryable: false })
      return defaultAnalyzer(input)
    }
    return createOpenAIResumeAnalyzer({ baseUrl: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL,
      timeoutMs: Number(env.OPENAI_TIMEOUT_MS ?? 120000) })(input)
  }
}
