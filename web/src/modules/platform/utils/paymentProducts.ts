import type { Checkout, PaymentProduct } from '../api/payments';


export function capacityIssue(product: PaymentProduct, organization: Checkout['organization']): string {
  if (product.billingKind === 'addon') return '该历史商品已停售';
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
