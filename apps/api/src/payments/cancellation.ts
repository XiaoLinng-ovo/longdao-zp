import { HttpError } from '../http.js';

const channelFailures: Record<string, string> = {
  PAYMENT_APPLICATION_NOT_ONLINE: '支付宝应用尚未上线，请联系平台管理员完成上线；系统会继续重试取消。',
  PAYMENT_ENDPOINT_BLOCKED: '支付渠道网络配置异常，请联系平台管理员；系统会继续重试取消。',
  PAYMENT_DNS_LOOKUP_FAILED: '暂时无法解析支付渠道地址，系统会继续重试取消。',
  PAYMENT_UPSTREAM_UNCERTAIN: '支付渠道暂未确认关单结果，系统会继续重试取消，请勿重复付款。',
  PAYMENT_CLOSE_UNSUPPORTED: '此支付渠道不支持主动关单，请联系平台管理员核对渠道订单。',
  PAYMENT_ALIPAY_HANDOFF_ACTIVE: '支付宝暂未创建交易，旧付款链接仍可能有效。系统会继续核对，请勿打开旧链接或付款。',
  PAYMENT_ALIPAY_LEGACY_HANDOFF: '支付宝暂未查到交易，但无法确认旧付款链接已失效。系统会继续核对，请勿使用旧链接；如长时间未解决，请联系平台管理员。',
};

export function cancellationFailure(error: unknown): string | null {
  return error instanceof HttpError && Object.hasOwn(channelFailures, error.code) ? error.code : null;
}

export function cancellationMessage(code: unknown): string {
  return typeof code === 'string' && Object.hasOwn(channelFailures, code)
    ? channelFailures[code]!
    : '取消申请已保存，正在等待支付渠道确认关闭订单，请勿继续付款。';
}
