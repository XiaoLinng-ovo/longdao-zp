import { offerSalaryTiming } from '@smartrecruit-pro/contracts'
export { offerSalaryTiming, probationDurationMonths } from '@smartrecruit-pro/contracts'

export const offerTemplateFieldDefinitions = [
  { key: 'reportingTime', label: '报到时间', type: 'datetime', maxLength: 16 },
  { key: 'supervisorName', label: '直属上级姓名', type: 'text', maxLength: 100 },
  { key: 'supervisorTitle', label: '直属上级职务', type: 'text', maxLength: 100 },
  { key: 'probationDuration', label: '试用期时长', type: 'text', maxLength: 50 },
  { key: 'formalSalaryStartMonth', label: '正常月薪起始月', type: 'number', maxLength: 2, min: 1, max: 13 },
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

export const additionalOfferVariables = [...offerTemplateFieldDefinitions.map(field => ({ value: `{{${field.label}}}`, label: field.label })),
  ...['初期月薪', '正常月薪', '初期薪资适用月数', '薪资安排说明'].map(label => ({ value: `{{${label}}}`, label }))]

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
    ['调薪起始月（入职第几个月）', timing.formalSalaryStartMonth],
  ]))
}
