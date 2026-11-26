export const offerTemplateFieldDefinitions = [
  { key: 'reportingTime', label: '报到时间', type: 'datetime', maxLength: 16 },
  { key: 'supervisorName', label: '直属上级姓名', type: 'text', maxLength: 100 },
  { key: 'supervisorTitle', label: '直属上级职务', type: 'text', maxLength: 100 },
  { key: 'probationDuration', label: '试用期时长', type: 'text', maxLength: 50 },
  { key: 'formalSalaryStartMonth', label: '调薪起始月（入职第几个月）', type: 'number', maxLength: 2, min: 1, max: 13 },
  { key: 'payday', label: '发薪日', type: 'number', maxLength: 2, min: 1, max: 31 },
] as const

export type OfferTemplateFields = Partial<Record<typeof offerTemplateFieldDefinitions[number]['key'], string>> & {
  probationSalaryMonths?: string
}

export function restoreOfferTemplateFields(fields: OfferTemplateFields = {}, startDate = ''): OfferTemplateFields {
  const restored = { ...fields }
  const reportingTime = restored.reportingTime ?? ''
  if (startDate && !/^\d{4}-\d{2}-\d{2}(?:T|$)/u.test(reportingTime)) {
    restored.reportingTime = reportingTime ? startDate + 'T' + reportingTime : startDate
  }
  return restored
}

export const additionalOfferVariables = offerTemplateFieldDefinitions.map(field => ({ value: `{{${field.label}}}`, label: field.label }))

export function probationDurationMonths(duration = ''): number | undefined {
  const match = /^(\d{1,2})\s*(?:个?月)?$/u.exec(duration.trim())
  if (!match || Number(match[1]) > 12) return undefined
  return Number(match[1])
}

export function offerSalaryTiming(fields: OfferTemplateFields = {}) {
  const months = probationDurationMonths(fields.probationDuration)
  const formalSalaryStartMonth = fields.formalSalaryStartMonth?.trim() || (months === undefined ? '' : String(months + 1))
  // An explicitly agreed earlier raise ends the initial salary period, not probation.
  const probationSalaryMonths = fields.probationSalaryMonths?.trim() || (months === undefined ? ''
    : String(formalSalaryStartMonth ? Math.min(months, Math.max(0, Number(formalSalaryStartMonth) - 1)) : months))
  return { probationSalaryMonths, formalSalaryStartMonth }
}

export function offerTemplateFieldValues(fields: OfferTemplateFields = {}): Record<string, string> {
  const reportingTime = fields.reportingTime ?? ''
  const timing = offerSalaryTiming(fields)
  const [reportingDate, reportingClock] = reportingTime.includes('T')
    ? reportingTime.split('T')
    : /^\d{4}-\d{2}-\d{2}$/u.test(reportingTime)
      ? [reportingTime, '']
      : ['', reportingTime]
  return Object.fromEntries(offerTemplateFieldDefinitions.flatMap(field => {
    const value = field.key === 'reportingTime' ? reportingClock ?? ''
      : field.key === 'formalSalaryStartMonth' ? timing.formalSalaryStartMonth : fields[field.key] ?? ''
    return [[field.key, value], [field.label, value]]
  }).concat([
    ['reportingDate', reportingDate ?? ''],
    ['报到日期', reportingDate ?? ''],
    ['probationSalaryMonths', timing.probationSalaryMonths],
    ['试用期薪资适用月数', timing.probationSalaryMonths],
    ['转正后薪资生效月份', timing.formalSalaryStartMonth],
  ]))
}
