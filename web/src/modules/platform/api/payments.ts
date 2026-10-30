import { apiClient } from "../../../shared/api";
export type PaymentStatus =
  | "creating"
  | "pending"
  | "uncertain"
  | "fulfilled"
  | "review"
  | "cancelled"
  | "expired"
  | "refund_pending"
  | "refunded";
export interface PaymentProduct {
  id: string;
  planVersionId: string;
  name: string;
  amountFen: number;
  currency: "CNY";
  durationDays: number | null;
  durationMonths?: number | null;
  allModules?: boolean;
  active: boolean;
  seatLimit: number;
  jobLimit: number;
}
export interface PaymentChannel {
  id: string;
  name: string;
  kind: "wxpay" | "alipay" | "easypay";
  enabled?: boolean;
}
export interface PaymentOrder {
  id: string;
  outTradeNo: string;
  organizationId: string;
  name: string;
  amountFen: number;
  currency: string;
  durationDays: number | null;
  durationMonths?: number | null;
  allModules?: boolean;
  method: "wxpay" | "alipay";
  mode: "qrcode" | "redirect";
  status: PaymentStatus;
  payURL: string | null;
  qrCode: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  refundedAt: string | null;
  reviewReason: string | null;
  organizationName?: string;
}
export interface Checkout {
  products: PaymentProduct[];
  providers: PaymentChannel[];
  orders: PaymentOrder[];
  organization: {
    id: string;
    name: string;
    entitlementVersion: number;
    expiresAt: string | null;
    seatUsage: number;
    jobUsage: number;
  };
  canPurchase: boolean;
}
export interface PaymentAdmin {
  products: PaymentProduct[];
  providers: PaymentChannel[];
  orders: PaymentOrder[];
  keyConfigured: boolean;
  publicBaseURL: string | null;
}
const base = (org: string) => "/payments/workspaces/" + encodeURIComponent(org);
export const getCheckout = async (org: string) =>
  (await apiClient.getJson<Checkout>(base(org))).data;
export const getPaymentOrder = async (org: string, id: string) =>
  (
    await apiClient.getJson<PaymentOrder>(
      base(org) + "/orders/" + encodeURIComponent(id),
    )
  ).data;
export const createPaymentOrder = async (
  org: string,
  input: {
    productId: string;
    providerId: string;
    method: "wxpay" | "alipay";
    mode: "qrcode" | "redirect";
    expectedVersion: number;
  },
  key: string,
) =>
  (
    await apiClient.postJson<PaymentOrder>(base(org) + "/orders", input, {
      headers: { "Idempotency-Key": key },
    })
  ).data;
export const paymentOrderAction = async (
  org: string,
  id: string,
  action: "verify" | "cancel",
) =>
  (
    await apiClient.postJson<PaymentOrder>(
      base(org) + "/orders/" + encodeURIComponent(id) + "/" + action,
      {},
    )
  ).data;
export const getPaymentAdmin = async () =>
  (await apiClient.getJson<PaymentAdmin>("/platform/payments")).data;
export const publishPaymentProduct = async (input: {
  planVersionId: string;
  name: string;
  amountFen: number;
  durationDays?: number | null;
  durationMonths?: number | null;
  allModules?: boolean;
  reason: string;
}) =>
  (
    await apiClient.postJson<PaymentProduct>(
      "/platform/payments/products",
      input,
    )
  ).data;
export const addPaymentProvider = async (input: {
  name: string;
  kind: PaymentChannel["kind"];
  config: Record<string, string>;
  reason: string;
}) =>
  (
    await apiClient.postJson<PaymentChannel>(
      "/platform/payments/providers",
      input,
    )
  ).data;
export const togglePaymentItem = async (
  kind: "products" | "providers",
  id: string,
  input: { active?: boolean; enabled?: boolean; reason: string },
) =>
  (
    await apiClient.patchJson(
      "/platform/payments/" + kind + "/" + encodeURIComponent(id),
      input,
    )
  ).data;
export const adminPaymentAction = async (
  id: string,
  action: "verify" | "refund",
  reason?: string,
) =>
  (
    await apiClient.postJson<PaymentOrder>(
      "/platform/payments/orders/" + encodeURIComponent(id) + "/" + action,
      { reason },
    )
  ).data;
export const paymentStatusLabel: Record<PaymentStatus, string> = {
  creating: "正在创建",
  pending: "等待付款",
  uncertain: "渠道结果待确认",
  fulfilled: "支付成功 · 套餐已开通",
  review: "已付款 · 待人工核对",
  cancelled: "已取消",
  expired: "已过期",
  refund_pending: "退款处理中",
  refunded: "已退款",
};
export const formatPayment = (fen: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
    fen / 100,
  );

export const paymentDurationLabel = (item: {
  durationDays: number | null;
  durationMonths?: number | null;
}) => item.durationMonths != null
  ? item.durationMonths + " 个月"
  : item.durationDays + " 天";
