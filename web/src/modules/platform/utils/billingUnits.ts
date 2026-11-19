import type { BillingPolicy, BillingResource } from '../api/payments';

// The ledger and historical snapshots keep integer seconds; every form uses minutes.
export const billingResourceLabels: Record<BillingResource, string> = {
  ai_points: 'AI 点数', interview_seconds: '转写分钟', ocr_pages: 'OCR 页数',
};
export function toBillingDisplay(value: number | string, resource: BillingResource): number {
  return Number(value) / (resource === 'interview_seconds' ? 60 : 1);
}
export function toBillingStorage(value: number, resource: BillingResource): number {
  const units = value * (resource === 'interview_seconds' ? 60 : 1);
  const rounded = Math.round(units);
  if (typeof value !== 'number' || !Number.isFinite(units) || units < 0 || !Number.isSafeInteger(rounded)
    || Math.abs(units - rounded) > Math.max(1e-7, Math.abs(units) * Number.EPSILON * 2)) {
    throw new Error(resource === 'interview_seconds'
      ? '请输入有效的转写分钟数，精度需能换算为整秒'
      : '额度数量必须为非负整数');
  }
  return rounded;
}
export function formatBillingAmount(value: number | string, resource: BillingResource): string {
  const amount = toBillingDisplay(value, resource);
  // Mark recurring fractional minutes as approximate; never round the stored balance.
  const approximate = resource === 'interview_seconds' && Number(value) % 3 !== 0;
  return (approximate ? '≈' : '') + amount.toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}
export function billingPolicyInMinutes(config: BillingPolicy): BillingPolicy {
  const result = structuredClone(config);
  for (const [key, rule] of Object.entries(result.rules)) {
    rule.quantity = toBillingDisplay(rule.quantity, rule.resource);
    if (key === 'interview_audio') rule.unitSize /= 60;
  }
  result.trial.interviewSeconds /= 60;
  return result;
}
export function billingPolicyInSeconds(config: BillingPolicy): BillingPolicy {
  // JSON also unwraps Vue proxies. Do not mutate the editing form on submit/retry.
  const result: BillingPolicy = JSON.parse(JSON.stringify(config));
  for (const [key, rule] of Object.entries(result.rules)) {
    rule.quantity = toBillingStorage(rule.quantity, rule.resource);
    if (key === 'interview_audio') rule.unitSize = toBillingStorage(rule.unitSize, 'interview_seconds');
  }
  result.trial.interviewSeconds = toBillingStorage(result.trial.interviewSeconds, 'interview_seconds');
  return result;
}
