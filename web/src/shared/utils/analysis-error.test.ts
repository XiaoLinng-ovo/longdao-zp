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
    expect(formatAnalysisError('failed at C:\\项目\\secret\\file.docx')).toBe('failed at [本地文件]')
  })
})
