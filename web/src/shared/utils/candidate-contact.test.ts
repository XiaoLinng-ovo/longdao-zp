import { describe, expect, it } from 'vitest'
import { candidateSourceLabel, emailHref, phoneHref } from './candidate-contact'

describe('候选人来源和联系方式展示', () => {
  it('maps import batch internals to readable labels', () => {
    expect(candidateSourceLabel('resume-import:2')).toBe('批量导入')
  })
  it('creates safe actionable links only for valid contact values', () => {
    expect(emailHref('candidate@example.com')).toBe('mailto:candidate@example.com')
    expect(emailHref('javascript:alert(1)')).toBeUndefined()
    expect(phoneHref('+1 (415) 555-0123')).toBe('tel:+14155550123')
    expect(phoneHref('not a phone')).toBeUndefined()
  })
})
