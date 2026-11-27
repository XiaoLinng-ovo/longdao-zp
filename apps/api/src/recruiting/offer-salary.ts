import { normalizedOfferSalaryFields, offerSalaryTiming, offerSalaryTimingIssue, validOfferSalaryAmount } from '@smartrecruit-pro/contracts'
import { normalizeOfferTemplateFields, type OfferTemplateFields } from './offer-template-fields.js'
import { RecruitingWorkflowError } from './workflow.js'

type Money = { amount: number; currency: string }
interface SalaryInput { employmentType?: string; templateFields?: OfferTemplateFields; baseSalary?: Money; probationSalary?: Money | null }
interface PreviousSalary { employmentType: string; templateFields?: OfferTemplateFields; compensation: { baseSalary?: Money; probationSalary?: Money } }

export function prepareOfferSalary(input: SalaryInput, previous?: PreviousSalary) {
  const fail = (message: string): never => { throw new RecruitingWorkflowError('OFFER_SALARY_INVALID', message, 400) }
  const base = input.baseSalary ?? previous?.compensation.baseSalary
  if (!base || !validOfferSalaryAmount(base.amount) || typeof base.currency !== 'string' || !base.currency.trim()) fail('正常月薪必须大于零、最多两位小数，并指定币种')
  let initial = input.probationSalary === undefined ? previous?.compensation.probationSalary : input.probationSalary
  if (initial !== undefined && initial !== null && (typeof initial !== 'object' || Array.isArray(initial))) fail('初期月薪格式无效')
  if (initial && (!validOfferSalaryAmount(initial.amount) || initial.currency !== base!.currency)) fail('初期月薪必须大于零、最多两位小数，且与正常月薪币种一致')
  let fields: OfferTemplateFields = { ...previous?.templateFields, ...normalizeOfferTemplateFields(input.templateFields) }
  const fullTime = (input.employmentType ?? previous?.employmentType) === 'full_time'
  const salaryKeys = ['probationDuration', 'probationSalaryMonths', 'formalSalaryStartMonth'] as const
  const changed = !previous || input.employmentType !== undefined && input.employmentType !== previous.employmentType
    || input.baseSalary !== undefined && JSON.stringify(input.baseSalary) !== JSON.stringify(previous.compensation.baseSalary)
    || input.probationSalary !== undefined && JSON.stringify(input.probationSalary) !== JSON.stringify(previous.compensation.probationSalary)
    || salaryKeys.some(key => input.templateFields?.[key] !== undefined && input.templateFields[key] !== previous.templateFields?.[key])
  if (!fullTime) { initial = null; fields = { ...fields, probationDuration: '', probationSalaryMonths: '0', formalSalaryStartMonth: '1' } }
  else if (changed) {
    if (!initial && !salaryKeys.some(key => fields[key]?.trim())) fields = { ...fields, probationSalaryMonths: '0', formalSalaryStartMonth: '1' }
    const issue = offerSalaryTimingIssue(fields)
    if (issue) fail(issue)
    fields = normalizedOfferSalaryFields(fields)
    if (Number(offerSalaryTiming(fields).probationSalaryMonths) === 0) initial = null
    else if (!initial) fail('存在初期薪资阶段时必须填写初期月薪')
  }
  return { templateFields: fields, baseSalary: base!, probationSalary: initial ?? null }
}
