import { describeApiFailure } from '../../../shared/utils/errorMessage'

const JOB_SCOPE_CODE = 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH'
export const JOB_SCOPE_FAILURE_MESSAGE = '岗位评分配置异常：岗位说明书或 JD 的企业归属与当前岗位不一致，本次 AI 评分未执行。这不是简历文件错误，无需重新上传；请管理员修复岗位关联后再重新解析。'

/** Supports both structured API failures and persisted Worker lastError strings. */
export function isJobAnalysisScopeFailure(cause: unknown): boolean {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
  const message = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : ''
  return code === JOB_SCOPE_CODE || message.includes(JOB_SCOPE_CODE)
}

export function resumeAnalysisFailureMessage(cause: unknown, fallback = '简历解析失败，请稍后重试'): string {
  if (isJobAnalysisScopeFailure(cause)) return JOB_SCOPE_FAILURE_MESSAGE
  return typeof cause === 'string' ? cause.trim() || fallback : describeApiFailure(cause, fallback).message
}
