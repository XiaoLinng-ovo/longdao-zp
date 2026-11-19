import { describe, expect, it } from 'vitest'
import { safeAuthRedirect } from './redirect'

describe('登录与企业选择的返回地址', () => {
  it.each(['/jobs', '/candidates?keyword=test', '/workspaces?join=1&invite=example', '/interviews/123#notes'])('保留内部业务目标 %s', path => {
    expect(safeAuthRedirect(path)).toBe(path)
  })
  it.each([undefined, ['jobs'], 'https://example.test', '//example.test', '/\\example.test', '/\n/example.test', '/login', '/login?redirect=/jobs', '/register', '/forgot-password'])('拒绝外部、异常及循环登录目标 %s', path => {
    expect(safeAuthRedirect(path)).toBeUndefined()
  })
})
