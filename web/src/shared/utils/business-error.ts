import { formatAnalysisError } from './analysis-error'
import { hasTechnicalErrorText } from './error-text'

/** 错误码留给程序判断；业务提示不得包含服务端诊断原文。 */
export function businessErrorMessage(raw: string | undefined, fallback = '操作失败，请稍后重试', code?: string, status?: number): string {
  if (code === 'CSRF_ORIGIN_MISMATCH') return '当前页面暂时无法提交，请联系管理员核对页面访问地址与服务安全配置'
  if (code === 'CSRF_TOKEN_INVALID') return '页面验证已失效，请刷新后重试'
  const message = raw?.trim()
  if (!message) return fallback
  if (/MODEL|AI_|ANALYSIS|QUESTION_PREPARATION/u.test(code ?? '') || /model|diagnostic|trace.?id|MODEL_RESPONSE_INVALID/iu.test(message)) return formatAnalysisError(message)
  if (/\p{Script=Han}/u.test(message) && !hasTechnicalErrorText(message)) return message
  if (status === 401) return '登录状态已失效，请重新登录'
  if (status === 403) return '当前账号暂时无法执行此操作，请联系管理员'
  if (status === 429) return '操作过于频繁，请稍后重试'
  return fallback
}
