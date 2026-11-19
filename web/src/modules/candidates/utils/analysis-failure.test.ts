import { describe, expect, it } from 'vitest'
import { ApiClientError } from '../../../shared/api'
import { isJobAnalysisScopeFailure, resumeAnalysisFailureMessage } from './analysis-failure'

describe('resume analysis failure presentation', () => {
  it('maps structured API scope errors without exposing raw codes', () => {
    const error = new ApiClientError('企业归属不一致', { kind: 'api', status: 409, code: 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH' })
    expect(isJobAnalysisScopeFailure(error)).toBe(true)
    expect(resumeAnalysisFailureMessage(error)).toContain('无需重新上传')
    expect(resumeAnalysisFailureMessage(error)).not.toContain('JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH')
  })
  it('maps historical Worker errors and does not imply corrupt files', () => {
    const error = 'JOB_ANALYSIS_CONTEXT_SCOPE_MISMATCH: 岗位说明书或JD的企业归属与岗位不一致'
    expect(resumeAnalysisFailureMessage(error)).toContain('本次 AI 评分未执行')
    expect(resumeAnalysisFailureMessage(error)).toContain('管理员')
    expect(resumeAnalysisFailureMessage(error)).not.toContain('检查文件内容')
  })
  it('preserves unrelated failures and uses a fallback for empty messages', () => {
    expect(isJobAnalysisScopeFailure('NETWORK_ERROR')).toBe(false)
    expect(resumeAnalysisFailureMessage('网络连接失败')).toBe('网络连接失败')
    expect(resumeAnalysisFailureMessage(undefined, '解析失败')).toBe('解析失败')
    expect(resumeAnalysisFailureMessage('')).toBe('简历解析失败，请稍后重试')
  })
})
