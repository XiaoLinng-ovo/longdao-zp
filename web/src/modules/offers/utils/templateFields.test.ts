import { describe, expect, it } from 'vitest'
import { offerTemplateFieldValues, restoreOfferTemplateFields } from './templateFields'

describe('salary timing', () => {
  it.each(['1', '2个月', '3月', ' 3 个月 ', '0', '12'])('defaults the salary month from probation %s', (duration) => {
    const months = Number.parseInt(duration.trim(), 10)
    const values = offerTemplateFieldValues({ probationDuration: duration })
    expect(values.probationSalaryMonths).toBe(String(months))
    expect(values.formalSalaryStartMonth).toBe(String(months + 1))
    expect(values['转正后薪资生效月份']).toBe(String(months + 1))
    expect(values['调薪起始月（入职第几个月）']).toBe(String(months + 1))
  })
  it('does not infer eleven trial salary months from a calendar-like legacy value', () => {
    const values = offerTemplateFieldValues({ probationDuration: '1', formalSalaryStartMonth: '12' })
    expect(values.probationSalaryMonths).toBe('1')
    expect(values.formalSalaryStartMonth).toBe('12')
  })
  it('keeps an earlier raise independent of the probation duration', () => {
    const values = offerTemplateFieldValues({ probationDuration: '3个月', formalSalaryStartMonth: '3' })
    expect(values.probationDuration).toBe('3个月')
    expect(values.probationSalaryMonths).toBe('2')
    expect(values.formalSalaryStartMonth).toBe('3')
    expect(offerTemplateFieldValues({ probationDuration: '3', probationSalaryMonths: '1' }).probationSalaryMonths).toBe('1')
  })
  it.each(['', '待定', '半个月', '13个月', '1.5个月', '-1', '2026-12'])('does not guess a duration from %s', (duration) => {
    const values = offerTemplateFieldValues({ probationDuration: duration })
    expect(values.probationSalaryMonths).toBe('')
    expect(values.formalSalaryStartMonth).toBe('')
  })
  it('treats empty fields as automatic rather than suppressing defaults', () => {
    expect(offerTemplateFieldValues({ probationDuration: '1', formalSalaryStartMonth: '', probationSalaryMonths: '' }).formalSalaryStartMonth).toBe('2')
  })
})

describe('restoreOfferTemplateFields', () => {
  it.each([
    [{}, '2026-12-01', '2026-12-01'],
    [{ reportingTime: '09:30' }, '2026-12-01', '2026-12-01T09:30'],
    [{ reportingTime: '2026-12-02T10:00' }, '2026-12-01', '2026-12-02T10:00'],
    [{ reportingTime: '2026-12-02' }, '2026-12-01', '2026-12-02'],
    [{ reportingTime: '09:30' }, '', '09:30'],
  ])('restores legacy reporting dates without replacing a saved reporting date', (fields, startDate, expected) => {
    expect(restoreOfferTemplateFields(fields, startDate).reportingTime).toBe(expected)
  })
  it('preserves every existing template field without mutating the source', () => {
    const original = { reportingTime: '09:30', supervisorName: '张主管', payday: '15' }
    expect(restoreOfferTemplateFields(original, '2026-12-01')).toEqual({ ...original, reportingTime: '2026-12-01T09:30' })
    expect(original.reportingTime).toBe('09:30')
  })
})
