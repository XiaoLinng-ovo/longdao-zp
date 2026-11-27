import { normalizedOfferSalaryFields, offerSalaryTiming, offerSalaryTimingIssue, validOfferSalaryAmount } from '@smartrecruit-pro/contracts'
import type { OfferTemplateFields } from './templateFields'

export function salaryFormError(employmentType: string, fields: OfferTemplateFields, base: number, initial: number): string {
  if (!validOfferSalaryAmount(base)) return '请填写大于零且最多两位小数的正常月薪'
  if (employmentType !== 'full_time') return ''
  const issue = offerSalaryTimingIssue(fields)
  if (issue) return issue
  if (Number(offerSalaryTiming(fields).probationSalaryMonths) > 0 && !validOfferSalaryAmount(initial)) return '请填写大于零且最多两位小数的初期月薪'
  return ''
}

export function salaryPayload(employmentType: string, fields: OfferTemplateFields, initial: number) {
  const normalized = employmentType === 'full_time' ? normalizedOfferSalaryFields(fields)
    : { ...fields, probationDuration: '', probationSalaryMonths: '0', formalSalaryStartMonth: '1' }
  return { templateFields: normalized,
    probationSalary: employmentType === 'full_time' && Number(normalized.probationSalaryMonths) > 0
      ? { amount: initial, currency: 'CNY' } : null }
}
