import { describe, expect, it } from 'vitest'
import { formatBusinessDateTime } from './date-time'

describe('北京时间格式化', () => {
  it('keeps calendar dates timezone-free and formats timestamps in China time', () => {
    expect(formatBusinessDateTime('2026-11-09')).toBe('2026-11-09')
    expect(formatBusinessDateTime('2026-11-09T01:00:00.000Z')).toBe('2026-11-09 09:00:00')
  })
  it('returns an explicit fallback for invalid values', () => {
    expect(formatBusinessDateTime('invalid')).toBe('未记录')
  })
})
