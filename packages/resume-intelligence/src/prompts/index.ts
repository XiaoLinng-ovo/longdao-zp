import type { JobRequirements, PromptInput } from '../contracts/types.js'

export const PROMPT_VERSION = '0.1.0'

function jobJson(job: JobRequirements): string {
  return JSON.stringify({
    title: job.title,
    summary: job.summary ?? '',
    requirements: job.requirements.map((requirement) => ({
      id: requirement.id,
      label: requirement.label,
      kind: requirement.kind,
      keywords: requirement.keywords ?? [],
      minYears: requirement.minYears,
      hard: requirement.hard === true,
    })),
  })
}

export function buildResumeAnalysisPrompt(input: PromptInput): string {
  return [
    '你是 SmartRecruit Pro 的简历分析助手。只能基于输入文本提供可解释的建议，不得编造事实。',
    '简历文本已经过脱敏处理。请返回 JSON，不要直接改变候选人的申请状态。',
    '硬性要求冲突必须返回证据和不确定性，不得自动淘汰、不得自动录用或不得自动发送 Offer。',
    '输出字段：summary、strengths、risks、matchedRequirements、conflicts、interviewQuestions、confidence。',
    `岗位信息：${jobJson(input.job)}`,
    `脱敏简历：\n${input.anonymizedResumeText.slice(0, 24000)}`,
  ].join('\n\n')
}

