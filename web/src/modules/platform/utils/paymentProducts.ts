import type { Checkout, PaymentProduct } from '../api/payments';
import { formatBillingAmount } from './billingUnits';

export function productQuotaLines(product: PaymentProduct): string[] {
  const quotas = product.billingEntitlements?.quotas;
  if (!quotas) return [];
  return [
    quotas.ai_points > 0 ? `${quotas.ai_points.toLocaleString('zh-CN')} AI 点数` : '',
    quotas.interview_seconds > 0 ? `${formatBillingAmount(quotas.interview_seconds, 'interview_seconds')} 分钟转写` : '',
    quotas.ocr_pages > 0 ? `${quotas.ocr_pages.toLocaleString('zh-CN')} 页 OCR` : '',
  ].filter(Boolean);
}

export function capacityIssue(product: PaymentProduct, organization: Checkout['organization']): string {
  if (product.billingKind === 'addon') return organization.serviceAvailable === false ? '请先开通或续费服务' : '';
  return organization.seatUsage > product.seatLimit || organization.jobUsage > product.jobLimit
    ? '套餐席位或岗位容量低于当前用量' : '';
}

export function subscriptionPreview(product: PaymentProduct, organization: Checkout['organization'], now = new Date()) {
  const renewal = product.subscriptionRenewal ?? organization.planVersionId === product.planVersionId;
  const start = new Date(renewal ? Math.max(now.getTime(), Date.parse(organization.expiresAt ?? '') || 0) : now.getTime());
  const end = new Date(start);
  if (product.durationMonths != null) {
    // Calendar arithmetic uses the billing timezone and clamps month-end dates.
    const china = new Date(start.getTime() + 8 * 3600000);
    const target = new Date(Date.UTC(china.getUTCFullYear(), china.getUTCMonth() + product.durationMonths, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    end.setTime(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(china.getUTCDate(), lastDay), china.getUTCHours(), china.getUTCMinutes(), china.getUTCSeconds(), china.getUTCMilliseconds()) - 8 * 3600000);
  } else end.setTime(start.getTime() + (product.durationDays ?? 0) * 86400000);
  return { action: renewal ? '续费' : organization.expiresAt ? '变更套餐' : '开通', start, end };
}
