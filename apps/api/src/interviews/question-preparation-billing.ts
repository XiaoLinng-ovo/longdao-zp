import { createHash } from 'node:crypto'
import type { InterviewQuestionGenerationInput, InterviewQuestionGroup } from './question-generator.js'

export function preparationBillingFailureMessage(code: string): string | undefined {
  const messages: Record<string, string> = {
    BILLING_TASK_EXISTS: '上次生成任务仍在处理或结果待核对，系统已阻止重复调用和重复扣费。确认需要重新生成后可点击重试；新任务可能产生新的调用费用，已完成题组会保留。',
    BILLING_KEY_CONFLICT: '生成任务标识与资料不一致，请点击重试创建新任务；已完成题组会保留。',
    BILLING_QUOTA_EXHAUSTED: '企业可用算力额度不足，请增购额度或联系管理员；已有面试资料不会丢失。',
    AI_CHANNEL_BUSY: '后台生成通道繁忙，任务已排队，将自动继续；右侧对话和录音不受影响。',
    BILLING_CONCURRENCY_LIMIT: 'AI任务暂时繁忙，已排队等待，将自动继续。',
    BILLING_DAILY_LIMIT: '企业今日AI用量已达保护上限，请联系管理员或次日重试。',
    BILLING_INPUT_LIMIT: '面试资料超出AI输入限制，请缩减资料或联系管理员调整限制。',
    BILLING_NOT_CONFIGURED: '平台计费配置缺失，请联系平台管理员。',
    PLATFORM_AI_NOT_CONFIGURED: '平台AI模型未配置，请联系平台管理员。',
    ORGANIZATION_AI_NOT_CONFIGURED: '企业AI模型未配置，请联系管理员。',
  }
  return messages[code]
}

export function preparationBillingIdentity(id: string, input: InterviewQuestionGenerationInput, group: InterviewQuestionGroup, generationId: string | null) {
  // A null identity preserves legacy replay and uncertain-task protection until an explicit retry.
  const fingerprint = { id, input, group, ...(generationId ? { generationId } : {}) }
  return { fingerprint, key: 'prep:' + createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex') }
}
