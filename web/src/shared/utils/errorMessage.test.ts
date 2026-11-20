import { describe, expect, it } from 'vitest'
import { ApiResponseError } from '../api/errors'
import { describeApiFailure } from './errorMessage'

describe('业务错误中文展示', () => {
  it.each([
    'Failed to fetch', '保存失败：TypeError: cannot read properties',
    '保存失败：duplicate key violates constraint users_email',
    '处理失败：/var/app/private/file.ts', '保存失败：request_id=secret-value',
    '保存失败 https://private.example.invalid/path',
    '保存失败：code=foo', '处理失败：null', '读取失败：rpc unavailable',
  ])('隐藏英文与混合技术信息：%s', raw => {
    expect(describeApiFailure(new Error(raw), '保存失败，请重试').message).toBe('保存失败，请重试')
    expect(new ApiResponseError(raw).message).toBe('操作失败，请稍后重试')
  })
  it('保留可操作的中文校验信息', () => {
    expect(describeApiFailure(new Error('请填写岗位名称')).message).toBe('请填写岗位名称')
    expect(new ApiResponseError('结束时间必须晚于开始时间').message).toBe('结束时间必须晚于开始时间')
    expect(new ApiResponseError('请上传 PDF 或 DOCX 文件').message).toBe('请上传 PDF 或 DOCX 文件')
    expect(new ApiResponseError('请先创建 Offer').message).toBe('请先创建 Offer')
    expect(new ApiResponseError('支付地址必须使用公开 HTTPS 域名和标准端口').message).toBe('支付地址必须使用公开 HTTPS 域名和标准端口')
    expect(new ApiResponseError('「应用 RSA 私钥」格式无效，请粘贴完整 PEM 密钥并保留起止标记').message).toContain('应用 RSA 私钥')
    expect(new ApiResponseError('微信支付 API v3 Key 长度必须为 32 字节').message).toBe('微信支付 API v3 Key 长度必须为 32 字节')
    expect(new ApiResponseError('「应用 App ID」格式无效，仅支持字母、数字、下划线和连字符').message).toContain('应用 App ID')
    expect(new ApiResponseError('「收款方 seller_id」格式无效，仅支持字母、数字、下划线和连字符').message).toContain('收款方 seller_id')
  })
  it('模型错误脱敏后仍保留程序依赖的错误码和请求标识', () => {
    const error = new ApiResponseError('MODEL_RESPONSE_INVALID model=private diagnostic=secret', { code: 'MODEL_RESPONSE_INVALID', status: 502, requestId: 'trace-for-support', details: { retry: true } })
    expect(error.message).toBe('AI 返回的结果格式异常，请重新尝试；若持续失败，请联系管理员检查分析服务')
    expect(describeApiFailure(error)).toMatchObject({ code: 'MODEL_RESPONSE_INVALID', status: 502 })
    expect(error.requestId).toBe('trace-for-support')
    expect(error.details).toEqual({ retry: true })
  })
  it.each([[401, '登录状态已失效，请重新登录'], [403, '当前账号暂时无法执行此操作，请联系管理员'], [429, '操作过于频繁，请稍后重试']] as const)('为状态 %s 提供中文处理建议', (status, message) => {
    expect(new ApiResponseError('Forbidden upstream', { status }).message).toBe(message)
  })
  it('保留防伪校验的恢复指引', () => {
    expect(new ApiResponseError('CSRF_TOKEN_INVALID', { code: 'CSRF_TOKEN_INVALID' }).message).toContain('刷新后重试')
    expect(new ApiResponseError('CSRF_ORIGIN_MISMATCH', { code: 'CSRF_ORIGIN_MISMATCH' }).message).toContain('页面访问地址')
    expect(describeApiFailure(undefined, '读取失败').message).toBe('读取失败')
  })
})
