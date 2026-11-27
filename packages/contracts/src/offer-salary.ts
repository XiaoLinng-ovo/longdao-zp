export interface OfferSalaryFields {
  probationDuration?: string
  probationSalaryMonths?: string
  formalSalaryStartMonth?: string
}

export function probationDurationMonths(duration = ''): number | undefined {
  const match = /^(\d{1,2})\s*(?:个?月)?$/u.exec(duration.trim())
  if (!match || Number(match[1]) > 12) return undefined
  return Number(match[1])
}

export function offerSalaryTiming(fields: OfferSalaryFields = {}) {
  const duration = probationDurationMonths(fields.probationDuration)
  const savedMonths = fields.probationSalaryMonths?.trim() ?? ''
  const savedStart = fields.formalSalaryStartMonth?.trim() ?? ''
  const probationSalaryMonths = savedMonths || (duration === undefined ? (savedStart ? String(Math.max(0, Number(savedStart) - 1)) : '')
    : String(savedStart ? Math.min(duration, Math.max(0, Number(savedStart) - 1)) : duration))
  const formalSalaryStartMonth = savedStart || (probationSalaryMonths === '' ? '' : String(Number(probationSalaryMonths) + 1))
  return { probationSalaryMonths, formalSalaryStartMonth }
}

export function offerSalaryTimingIssue(fields: OfferSalaryFields = {}): string {
  const timing = offerSalaryTiming(fields)
  if (timing.probationSalaryMonths === '' || timing.formalSalaryStartMonth === '') return '请确认初期薪资适用月数或选择入职即正常月薪'
  const months = Number(timing.probationSalaryMonths), start = Number(timing.formalSalaryStartMonth)
  if (!Number.isInteger(months) || months < 0 || months > 12) return '初期薪资适用月数应为 0 至 12 之间的整数'
  if (!Number.isInteger(start) || start !== months + 1) return '正常月薪起始月必须为初期薪资适用月数加 1，请核对历史薪资安排'
  return ''
}

export function normalizedOfferSalaryFields<T extends OfferSalaryFields>(fields: T): T {
  return { ...fields, ...offerSalaryTiming(fields) }
}

export function validOfferSalaryAmount(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0
    && Number.isSafeInteger(Math.round(amount * 100)) && Math.abs(amount * 100 - Math.round(amount * 100)) < 0.000001
}

export function offerSalarySummary(fields: OfferSalaryFields, baseSalary: number, initialSalary?: number): string {
  const timing = offerSalaryTiming(fields)
  const prefix = fields.probationDuration?.trim() ? `试用期 ${fields.probationDuration.trim()}；` : ''
  if (offerSalaryTimingIssue(fields)) return prefix + '薪资适用月份待核对'
  const amount = (value: number) => value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  const months = Number(timing.probationSalaryMonths)
  if (!months) return prefix + `入职起正常月薪 ${amount(baseSalary)} 元`
  if (!validOfferSalaryAmount(initialSalary)) return prefix + '初期月薪待填写'
  return prefix + `${months === 1 ? '第 1 个月' : `前 ${months} 个月`}月薪 ${amount(initialSalary)} 元；第 ${timing.formalSalaryStartMonth} 个月起正常月薪 ${amount(baseSalary)} 元`
}

export function offerSalaryVariables(fields: OfferSalaryFields, baseSalary: number, initialSalary?: number): Record<string, string> {
  const timing = offerSalaryTiming(fields)
  const initial = Number(timing.probationSalaryMonths) === 0 ? '' : String(initialSalary ?? '')
  const summary = offerSalarySummary(fields, baseSalary, initialSalary)
  return { initialSalary: initial, normalSalary: String(baseSalary), salaryArrangement: summary,
    '初期月薪': initial, '正常月薪': String(baseSalary), '初期薪资适用月数': timing.probationSalaryMonths,
    '正常月薪起始月': timing.formalSalaryStartMonth, '薪资安排说明': summary }
}
