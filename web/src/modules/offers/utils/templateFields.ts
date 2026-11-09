export const offerTemplateFieldDefinitions = [
  { key: 'reportingTime', label: '报到时间', type: 'datetime', maxLength: 16 },
  { key: 'supervisorName', label: '直属上级姓名', type: 'text', maxLength: 100 },
  { key: 'supervisorTitle', label: '直属上级职务', type: 'text', maxLength: 100 },
  { key: 'probationDuration', label: '试用期时长', type: 'text', maxLength: 50 },
  { key: 'formalSalaryStartMonth', label: '转正后薪资生效月份', type: 'number', maxLength: 2, min: 1, max: 13 },
  { key: 'payday', label: '发薪日', type: 'number', maxLength: 2, min: 1, max: 31 },
] as const

export type OfferTemplateFields = Partial<Record<typeof offerTemplateFieldDefinitions[number]['key'], string>> & {
  probationSalaryMonths?: string
}

export const additionalOfferVariables = offerTemplateFieldDefinitions.map(field => ({ value: `{{${field.label}}}`, label: field.label }))

export function offerTemplateFieldValues(fields: OfferTemplateFields = {}): Record<string, string> {
  const reportingTime = fields.reportingTime ?? ''
  const probationSalaryMonths = fields.probationSalaryMonths ?? (Number(fields.formalSalaryStartMonth) > 0
    ? String(Number(fields.formalSalaryStartMonth) - 1)
    : '')
  const [reportingDate, reportingClock] = reportingTime.includes('T')
    ? reportingTime.split('T')
    : /^\d{4}-\d{2}-\d{2}$/u.test(reportingTime)
      ? [reportingTime, '']
      : ['', reportingTime]
  return Object.fromEntries(offerTemplateFieldDefinitions.flatMap(field => {
    const value = field.key === 'reportingTime' ? reportingClock ?? '' : fields[field.key] ?? ''
    return [[field.key, value], [field.label, value]]
  }).concat([
    ['reportingDate', reportingDate ?? ''],
    ['报到日期', reportingDate ?? ''],
    ['probationSalaryMonths', probationSalaryMonths],
    ['试用期薪资适用月数', probationSalaryMonths],
  ]))
}
