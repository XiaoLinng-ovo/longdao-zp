import { describe, expect, it } from 'vitest'
import { formatAnalysisError } from './analysis-error'

describe('analysis error display', () => {
  it('turns missing local files into an actionable message', () => {
    expect(formatAnalysisError("ENOENT: no such file or directory, open 'C:\\secret\\resume.docx'"))
      .toBe('原始简历文件不存在或已被删除，请重新上传')
  })

  it('turns model timeouts into retry guidance', () => {
    expect(formatAnalysisError('Resume analysis model timed out')).toBe('AI 分析服务超时，请稍后重试')
  })

  it('redacts absolute local paths from unknown failures', () => {
    expect(formatAnalysisError('failed at C:\\项目\\secret\\file.docx')).toBe('AI 处理失败，请稍后重试；若持续失败，请联系管理员检查分析服务')
  })
  it('does not disclose model names or diagnostic identifiers', () => {
    expect(formatAnalysisError('MODEL_RESPONSE_INVALID model=gpt-test diagnostic=abc')).toBe('AI 返回的结果格式异常，请重新尝试；若持续失败，请联系管理员检查分析服务')
    for (const message of ['Model: private-v1 处理失败', '失败，诊断编号: abc123', 'requestId=xyz 请求失败', 'fetch failed']) {
      expect(formatAnalysisError(message)).toBe('AI 处理失败，请稍后重试；若持续失败，请联系管理员检查分析服务')
    }
    expect(formatAnalysisError('请先上传简历')).toBe('请先上传简历')
    expect(formatAnalysisError('解析失败：null')).toBe('AI 处理失败，请稍后重试；若持续失败，请联系管理员检查分析服务')
  })
})
