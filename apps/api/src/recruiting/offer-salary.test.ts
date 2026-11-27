import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { prepareOfferSalary } from './offer-salary.js'

const baseSalary = { amount: 10000, currency: 'CNY' }
const probationSalary = { amount: 8000, currency: 'CNY' }
describe('Offer salary stages', () => {
  it('keeps three-month probation independent of a one-month initial salary', () => {
    const result = prepareOfferSalary({ employmentType: 'full_time', baseSalary, probationSalary,
      templateFields: { probationDuration: '3个月', probationSalaryMonths: '1' } })
    assert.deepEqual(result.templateFields, { probationDuration: '3个月', probationSalaryMonths: '1', formalSalaryStartMonth: '2' })
    assert.deepEqual(result.probationSalary, probationSalary)
  })
  it('explicitly removes the previous initial salary when switching to regular salary', () => {
    const result = prepareOfferSalary({ probationSalary: null, templateFields: { probationSalaryMonths: '0', formalSalaryStartMonth: '1' } },
      { employmentType: 'full_time', templateFields: { probationDuration: '3个月', probationSalaryMonths: '1', formalSalaryStartMonth: '2' }, compensation: { baseSalary, probationSalary } })
    assert.equal(result.probationSalary, null)
    assert.equal(result.templateFields.probationDuration, '3个月')
  })
  it('rejects inconsistent months, missing amounts and invalid precision', () => {
    for (const input of [
      { templateFields: { probationSalaryMonths: '1', formalSalaryStartMonth: '4' }, probationSalary },
      { templateFields: { probationSalaryMonths: '1' } },
      { baseSalary: { amount: 100.123, currency: 'CNY' } },
      { probationSalary },
    ]) assert.throws(() => prepareOfferSalary({ employmentType: 'full_time', baseSalary, ...input }), { code: 'OFFER_SALARY_INVALID' })
  })
  it('does not reinterpret unresolved legacy timing on an unrelated edit', () => {
    const templateFields = { probationDuration: '1个月', formalSalaryStartMonth: '12' }
    const result = prepareOfferSalary({}, { employmentType: 'full_time', templateFields, compensation: { baseSalary, probationSalary } })
    assert.deepEqual(result.templateFields, templateFields)
  })
  it('accepts regular salary from the first month and clears internship stages', () => {
    assert.equal(prepareOfferSalary({ employmentType: 'full_time', baseSalary }).templateFields.formalSalaryStartMonth, '1')
    assert.equal(prepareOfferSalary({ employmentType: 'internship', baseSalary, probationSalary }).probationSalary, null)
  })
})
