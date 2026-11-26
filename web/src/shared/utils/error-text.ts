const businessTerms = /^(?:AI|HR|JD|Offer|PDF|DOCX?|XLSX?|CSV|ZIP|MB|KB|GB|API|HTTPS?|PEM|RSA|Key|ID|App|seller_id|PID|v\d+)$/iu

/** 业务缩写可保留；路径、参数和其他英文诊断不得进入业务提示。 */
export function hasTechnicalErrorText(message: string): boolean {
  if (/https?:\/\/|[A-Z]:\\|(?:\/(?:home|var|usr|app|tmp)\/)|(?:request|trace)[_-]?id\s*[:=]|诊断(?:编号|标识)/iu.test(message)) return true
  return (message.match(/[A-Za-z][A-Za-z0-9_.-]*/gu) ?? []).some(term => !businessTerms.test(term))
}
