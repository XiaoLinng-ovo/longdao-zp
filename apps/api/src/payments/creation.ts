import { HttpError } from "../http.js";

// Only transport preflight or an authenticated creation rejection may prove this.
export class PaymentNotCreatedError extends HttpError {}

export function creationMessage(outcome: unknown, code: unknown): string | null {
  if (outcome !== "not_created") return null;
  if (code === "PAYMENT_APPLICATION_NOT_ONLINE")
    return "订单创建失败：支付宝应用尚未上线。可直接取消此订单，完成应用上线后重新下单。";
  if (code === "PAYMENT_ENDPOINT_BLOCKED" || code === "PAYMENT_DNS_LOOKUP_FAILED")
    return "订单创建失败：连接支付渠道前网络检查失败，尚未发起支付请求。可直接取消后重试。";
  return "支付渠道未创建此订单，可直接取消后重试。";
}
