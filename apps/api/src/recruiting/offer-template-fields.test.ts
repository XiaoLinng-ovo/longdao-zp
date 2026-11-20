import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeOfferTemplateFields, offerTemplateFieldValues } from './offer-template-fields.js'

describe('Offer manual template fields', () => {
  it('defaults salary timing from the trial duration and retains both aliases', () => {
    for (const [duration, months] of [['1', 1], ['2个月', 2], ['3月', 3], [' 3 个月 ', 3], ['0', 0], ['12', 12]] as const) {
      const values = offerTemplateFieldValues(normalizeOfferTemplateFields({ probationDuration: duration }))
      assert.equal(values.probationSalaryMonths, String(months))
      assert.equal(values.formalSalaryStartMonth, String(months + 1))
      assert.equal(values['转正后薪资生效月份'], String(months + 1))
      assert.equal(values['调薪起始月（入职第几个月）'], String(months + 1))
    }
    assert.equal(offerTemplateFieldValues({ probationDuration: '1', formalSalaryStartMonth: '', probationSalaryMonths: '' }).formalSalaryStartMonth, '2')
  })

  it('does not expand probation to eleven months for an explicit month twelve', () => {
    const values = offerTemplateFieldValues({ probationDuration: '1', formalSalaryStartMonth: '12' })
    assert.equal(values.probationSalaryMonths, '1')
    assert.equal(values.formalSalaryStartMonth, '12')
  })

  it('keeps early raises separate from the probation duration', () => {
    const values = offerTemplateFieldValues({ probationDuration: '3个月', formalSalaryStartMonth: '3' })
    assert.equal(values.probationDuration, '3个月')
    assert.equal(values.probationSalaryMonths, '2')
    assert.equal(values.formalSalaryStartMonth, '3')
    assert.equal(offerTemplateFieldValues({ probationDuration: '3', probationSalaryMonths: '1' }).probationSalaryMonths, '1')
  })

  it('leaves unknown durations unresolved instead of guessing', () => {
    for (const duration of ['', '待定', '半个月', '13个月', '1.5个月', '-1', '2026-12']) {
      const values = offerTemplateFieldValues({ probationDuration: duration })
      assert.equal(values.probationSalaryMonths, '')
      assert.equal(values.formalSalaryStartMonth, '')
    }
  })
  it('normalizes fields and provides both Chinese and internal aliases', () => {
    const fields = normalizeOfferTemplateFields({ reportingTime: ' 09:30 ', supervisorName: ' 王经理 ', supervisorTitle: '总监', probationDuration: '3个月', probationSalaryMonths: '3', formalSalaryStartMonth: '4', payday: '15' })!
    assert.equal(fields.reportingTime, '09:30')
    assert.equal(fields.supervisorName, '王经理')
    assert.equal(offerTemplateFieldValues(fields)['报到时间'], '09:30')
    assert.equal(offerTemplateFieldValues(fields)['发薪日'], '15')
    assert.equal(offerTemplateFieldValues(fields).formalSalaryStartMonth, '4')
    assert.equal(normalizeOfferTemplateFields(undefined), undefined)
    assert.deepEqual(normalizeOfferTemplateFields({ supervisorName: '' }), { supervisorName: '' })
  })

  it('splits a saved reporting date and time into the corresponding template variables', () => {
    const fields = normalizeOfferTemplateFields({ reportingTime: '2026-11-15T09:30' })!
    assert.equal(offerTemplateFieldValues(fields)['报到日期'], '2026-11-15')
    assert.equal(offerTemplateFieldValues(fields)['报到时间'], '09:30')
    assert.equal(offerTemplateFieldValues({ reportingTime: '09:30' })['报到时间'], '09:30')
  })

  it('accepts a complete reporting date and time within the API field limit', () => {
    const fields = normalizeOfferTemplateFields({ reportingTime: '2026-11-10T09:00' })!
    assert.equal(fields.reportingTime, '2026-11-10T09:00')
    assert.equal(offerTemplateFieldValues(fields)['报到日期'], '2026-11-10')
    assert.equal(offerTemplateFieldValues(fields)['报到时间'], '09:00')
  })

  it('treats a date-only value as the reporting date', () => {
    const values = offerTemplateFieldValues({ reportingTime: '2026-11-15' })
    assert.equal(values['报到日期'], '2026-11-15')
    assert.equal(values['报到时间'], '')
  })

  it('rejects unsupported fields, invalid types, times and numeric ranges', () => {
    for (const invalid of [null, [], 'text', { unknown: 'x' }, { payday: 15 }, { reportingTime: '24:00' }, { reportingTime: '9:30' }, { reportingTime: '2026-11-15T9:30' }, { payday: '32' }, { payday: '0' }, { probationSalaryMonths: '-1' }, { formalSalaryStartMonth: '0' }, { supervisorName: 'x'.repeat(101) }]) {
      assert.throws(() => normalizeOfferTemplateFields(invalid), (error: any) => error.code === 'VALIDATION_ERROR' && error.status === 400)
    }
  })
})
