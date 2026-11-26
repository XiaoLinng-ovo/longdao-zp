import { hasTechnicalErrorText } from './error-text'

export function formatAnalysisError(value: string | undefined): string {
  const message = value?.trim() ?? ''
  if (!message) return '未记录失败原因'
  if (/ENOENT|no such file or directory/iu.test(message)) return '原始简历文件不存在或已被删除，请重新上传'
  if (/timed out|timeout/iu.test(message)) return 'AI 分析服务超时，请稍后重试'
  if (/MODEL_RESPONSE_INVALID|invalid.*(?:json|response)|json.*(?:parse|invalid)/iu.test(message)) return 'AI 返回的结果格式异常，请重新尝试；若持续失败，请联系管理员检查分析服务'
  if (/rate.?limit|quota|insufficient|HTTP\s*429|余额|额度/iu.test(message)) return 'AI 服务暂时不可用，请联系管理员检查服务额度后重试'
  if (/model|diagnostic|trace|request.?id|诊断(?:编号|标识)|模型[:：]/iu.test(message) || hasTechnicalErrorText(message) || !/[\u3400-\u9fff]/u.test(message)) return 'AI 处理失败，请稍后重试；若持续失败，请联系管理员检查分析服务'
  return message
}
