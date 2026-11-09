export interface OfferTemplateFields {
  reportingTime?: string
  supervisorName?: string
  supervisorTitle?: string
  probationDuration?: string
  probationSalaryMonths?: string
  formalSalaryStartMonth?: string
  payday?: string
}

const definitions = {
  reportingTime: { label: '报到时间', maxLength: 16 },
  supervisorName: { label: '直属上级姓名', maxLength: 100 },
  supervisorTitle: { label: '直属上级职务', maxLength: 100 },
  probationDuration: { label: '试用期时长', maxLength: 50 },
  probationSalaryMonths: { label: '试用期薪资适用月数', maxLength: 2, min: 0, max: 12 },
  formalSalaryStartMonth: { label: '转正后薪资生效月份', maxLength: 2, min: 1, max: 13 },
  payday: { label: '发薪日', maxLength: 2, min: 1, max: 31 },
} as const

export function normalizeOfferTemplateFields(value: unknown): OfferTemplateFields | undefined {
  if (value === undefined) return undefined
  const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'VALIDATION_ERROR', status: 400 }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Offer 模板填写项格式无效')
  const result: OfferTemplateFields = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.hasOwn(definitions, key)) invalid(`不支持的 Offer 模板填写项：${key}`)
    const definition = definitions[key as keyof OfferTemplateFields]
    if (typeof raw !== 'string') invalid(`${definition.label}必须为文本`)
    const text = (raw as string).trim()
    if (text.length > definition.maxLength) invalid(`${definition.label}长度不能超过${definition.maxLength}个字符`)
    if (text && key === 'reportingTime' && !/^(?:\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d)?|(?:[01]\d|2[0-3]):[0-5]\d)$/u.test(text)) invalid('报到日期或时间格式无效')
    if (text && 'min' in definition && (!/^\d+$/u.test(text) || Number(text) < definition.min || Number(text) > definition.max)) invalid(`${definition.label}应为${definition.min}至${definition.max}之间的整数`)
    result[key as keyof OfferTemplateFields] = text
  }
  return result
}

export function offerTemplateFieldValues(fields: OfferTemplateFields = {}): Record<string, string> {
  const reportingTime = fields.reportingTime ?? ''
  const [reportingDate, reportingClock] = reportingTime.includes('T')
    ? reportingTime.split('T')
    : /^\d{4}-\d{2}-\d{2}$/u.test(reportingTime)
      ? [reportingTime, '']
      : ['', reportingTime]
  return Object.fromEntries(Object.entries(definitions).flatMap(([key, definition]) => {
    const value = key === 'reportingTime' ? reportingClock ?? '' : fields[key as keyof OfferTemplateFields] ?? ''
    return [[key, value], [definition.label, value]]
  }).concat([['reportingDate', reportingDate ?? ''], ['报到日期', reportingDate ?? '']]))
}
