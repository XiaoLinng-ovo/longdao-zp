export function formatAnalysisError(value: string | undefined): string {
  const message = value?.trim() ?? ''
  if (!message) return '未记录失败原因'
  if (/ENOENT|no such file or directory/iu.test(message)) return '原始简历文件不存在或已被删除，请重新上传'
  if (/timed out|timeout/iu.test(message)) return 'AI 分析服务超时，请稍后重试'
  return message.replace(/[A-Z]:\\[^\s]+/giu, '[本地文件]')
}
