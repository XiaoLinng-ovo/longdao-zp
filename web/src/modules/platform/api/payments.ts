import { apiClient } from "../../../shared/api";
import type { PlanVersion } from "./entitlements";
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
  subscriptionRenewal?: boolean;
  id: string;
  catalogId?: string;
  versionNumber?: number;
  versionReason?: string;
  createdBy?: string;
  createdAt?: string;
  operatorName?: string;
  planVersionId: string;
  name: string;
  description?: string;
  sortOrder?: number;
  amountFen: number;
  currency: "CNY";
  durationDays: number | null;
  durationMonths?: number | null;
  allModules?: boolean;
  active: boolean;
  seatLimit: number;
  jobLimit: number;
  billingKind?: 'subscription' | 'addon';
  billingEntitlements?: BillingEntitlements;
}
export type BillingResource = 'ai_points' | 'interview_seconds' | 'ocr_pages';
export type BillingOperation = 'resume_analysis' | 'job_spec' | 'jd' | 'interview_questions' | 'answer_analysis' | 'interview_summary' | 'transcript_processing' | 'interview_audio' | 'ocr';
export interface BillingEntitlements { quotas: Record<BillingResource, number>; grantPeriod: 'once' | 'monthly'; rollover: boolean }
export interface BillingPolicy { enabled: boolean; rules: Record<BillingOperation,{enabled:boolean;resource:BillingResource;quantity:number;unitSize:number}>; limits:{maxConcurrent:number;dailyAiPoints:number;maxInputChars:number;maxOutputTokens:number}; trial:{durationDays:number;seatLimit:number;jobLimit:number;resumeUploads:number;interviews:number;aiGenerations:number;aiPoints:number;interviewSeconds:number;ocrPages:number} }
export interface BillingOverview { version:string; config:BillingPolicy; history:{version:string;reason:string;created_at:string}[]; tasks?:BillingTask[] }
export interface PaymentChannel {
  id: string;
  name: string;
  kind: "wxpay" | "alipay" | "easypay";
  enabled?: boolean;
  environment?: "production" | "sandbox";
}
export interface PaymentOrder {
  description?: string;
  billingKind?: 'subscription' | 'addon';
  billingEntitlements?: BillingEntitlements;
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
  mode: "qrcode" | "redirect" | "wap";
  environment?: "production" | "sandbox";
  status: PaymentStatus;
  creationOutcome?: 'unknown' | 'created' | 'not_created';
  creationMessage?: string | null;
  channelClosePending?: boolean;
  cancelRequestedAt?: string | null;
  cancellationMessage?: string | null;
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
  billing?: EnterpriseBilling;
  products: PaymentProduct[];
  providers: PaymentChannel[];
  orders: PaymentOrder[];
  pendingOrder: PaymentOrder | null;
  organization: {
    id: string;
    name: string;
    entitlementVersion: number;
    expiresAt: string | null;
    seatUsage: number;
    jobUsage: number;
    planVersionId?: string;
    planName?: string;
    seatLimit?: number | null;
    jobLimit?: number | null;
    serviceAvailable?: boolean;
    serviceStatus?: string;
    trialEndsAt?: string | null;
  };
  canPurchase: boolean;
}
export interface PaymentAdmin {
  productVersioning?: boolean;
  duplicatePendingOrders?: { organizationId: string; organizationName: string; orders: PaymentOrder[] }[];
  serviceRequests?: EnterpriseServiceRequest[];
  plans: PlanVersion[];
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
    mode: "qrcode" | "redirect" | "wap";
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
export interface PublishPaymentProductInput {
  description?: string;
  sortOrder?: number;
  planVersionId?: string;
  seatLimit?: number;
  jobLimit?: number;
  name: string;
  amountFen: number;
  durationDays?: number | null;
  durationMonths?: number | null;
  allModules?: boolean;
  billingKind?: 'subscription' | 'addon';
  billingEntitlements?: BillingEntitlements;
  reason: string;
  requestId?: string;
  expectedVersionId?: string;
}
export interface PaymentProductHistory { catalogId:string; currentVersionId:string; versions:PaymentProduct[] }
export const getPaymentProductHistory = async (id:string) => (await apiClient.getJson<PaymentProductHistory>('/platform/payments/products/'+encodeURIComponent(id)+'/history')).data;
export const revisePaymentProduct = async (id:string,input:PublishPaymentProductInput) => (await apiClient.postJson<PaymentProduct>('/platform/payments/products/'+encodeURIComponent(id)+'/revisions',input)).data;
export const mergePaymentProducts = async (input:{versionIds:string[];keepVersionId:string;active:boolean;reason:string;requestId:string}) => (await apiClient.postJson<PaymentProduct>('/platform/payments/products/merge',input)).data;
export const publishPaymentProduct = async (input: PublishPaymentProductInput) =>
  (
    await apiClient.postJson<PaymentProduct>(
      "/platform/payments/products",
      input,
    )
  ).data;
export const getBillingPolicy = async (): Promise<BillingOverview> => (await apiClient.getJson<BillingOverview>('/platform/payments/billing-policy')).data as BillingOverview;
export const publishBillingPolicy = async (input:{config:BillingPolicy;expectedVersion:string;reason:string}):Promise<{version:string;config:BillingPolicy}> => (await apiClient.postJson<{version:string;config:BillingPolicy}>('/platform/payments/billing-policy',input)).data as {version:string;config:BillingPolicy};
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
  action: "verify" | "refund" | "cancel",
  reason?: string,
) =>
  (
    await apiClient.postJson<PaymentOrder>(
      "/platform/payments/orders/" + encodeURIComponent(id) + "/" + action,
      { reason },
    )
  ).data;
export interface EnterpriseServiceRequest {
  id: string; organizationId: string; organizationName?: string;
  message: string; status: 'open' | 'resolved'; response: string | null;
  createdAt: string; resolvedAt: string | null; updatedAt?: string;
}
export interface EnterpriseContinuity {
  dataRestricted: boolean;
  dataUnavailable?: boolean;
  data: null | {
    stats: { jobs: number; applications: number; interviews: number };
    jobs: { id: string; jobNo: string; title: string; status: string; headcount: number; createdAt: string; updatedAt: string }[];
    limit: number; truncated: boolean;
  };
  requests: EnterpriseServiceRequest[];
}
export const getEnterpriseContinuity = async (org: string) =>
  (await apiClient.getJson<EnterpriseContinuity>(base(org) + '/service')).data;
export const exportEnterpriseContinuity = async (org: string) =>
  (await apiClient.postJson<{filename: string; csv: string; rows: number; truncated: boolean; limit: number}>(base(org) + '/service/export', {})).data;
export const contactSystemAdministrator = async (org: string, message: string, attachments?: ServiceAttachmentUpload[]) =>
  (await apiClient.postJson<{request: EnterpriseServiceRequest; existing: boolean}>(base(org) + '/service/requests', { message, ...(attachments?.length ? {attachments} : {}) })).data;
export const resolveEnterpriseServiceRequest = async (id: string, response: string) =>
  (await apiClient.postJson<EnterpriseServiceRequest>('/platform/payments/service-requests/' + encodeURIComponent(id), { response })).data;
export interface ServiceAttachmentUpload { filename: string; base64: string }
export interface ServiceAttachment { id: string; filename: string; mimeType: string; sizeBytes: number }
export interface ServiceThread {
  request: EnterpriseServiceRequest;
  messages: { id: string; authorKind: 'member' | 'administrator'; message: string; createdAt: string; attachments: ServiceAttachment[] }[];
  hasMore: boolean; nextBefore: string | null;
}
const serviceThreadPath = (id: string, org?: string) => org
  ? base(org) + '/service/requests/' + encodeURIComponent(id)
  : '/platform/payments/service-requests/' + encodeURIComponent(id);
export const getServiceThread = async (id: string, org?: string, before?: string) =>
  (await apiClient.getJson<ServiceThread>(serviceThreadPath(id, org) + (before ? '?before=' + encodeURIComponent(before) : ''))).data;
export const replyServiceThread = async (id: string, input: { message: string; attachments: ServiceAttachmentUpload[]; resolve?: boolean }, org?: string) =>
  (await apiClient.postJson<ServiceThread>(serviceThreadPath(id, org) + '/messages', input)).data;
export const getServiceAttachment = async (id: string, attachmentId: string, org?: string) =>
  (await apiClient.getJson<{filename:string;mimeType:string;sizeBytes:number;base64:string}>(serviceThreadPath(id, org) + '/attachments/' + encodeURIComponent(attachmentId))).data;
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
  : item.durationDays == null ? '长期有效' : item.durationDays + " 天";

export interface BillingTask { id:string; organizationId?:string;organizationName?:string;operation:BillingOperation;resource:BillingResource;units:string;state:'reserved'|'settled'|'released'|'uncertain';policyVersion?:string;policy_version?:string;createdAt?:string;created_at?:string }
export interface EnterpriseBilling {enabled:boolean;serviceAvailable?:boolean;execution?:{enabled:boolean;text:{active:number;limit:number;reservedInteractive:number};audio:{active:number;limit:number};realtime:{active:number;limit:number}};rules:BillingPolicy['rules'];resources:{resource:BillingResource;available:string;permanent?:string;reserved?:string;next_expiry:string|null}[];tasks:BillingTask[];grants?:{id:string;resource:BillingResource;remaining:string;total:string;valid_from:string;expires_at:string|null;source:string;name:string|null}[]}
export const getEnterpriseBilling=async(org:string):Promise<EnterpriseBilling>=>(await apiClient.getJson<EnterpriseBilling>(base(org)+'/usage')).data;
export const grantBillingQuota=async(input:{organizationId:string;key:string;resource:BillingResource;units:number;expiresAt:string|null;reason:string})=>(await apiClient.postJson('/platform/payments/quota-grants',input)).data;
export interface CreditConversion {orderId:string;digest:string;grants:{id:string;resource:BillingResource;total:string;remaining:string;expires_at:string|null;blockedReason:string|null}[]}
export const previewCreditConversion=async(id:string)=>(await apiClient.getJson<CreditConversion>('/platform/payments/credit-conversions/'+encodeURIComponent(id))).data;
export const convertCredits=async(input:{orderId:string;expectedDigest:string;reason:string})=>(await apiClient.postJson<{converted:number}>('/platform/payments/credit-conversions',input)).data;
export const resolveBillingTask=async(id:string,input:{state:'settled'|'released';reason:string})=>(await apiClient.postJson('/platform/payments/billing-tasks/'+encodeURIComponent(id),input)).data;

export interface PaymentBillReport {
  id:string; providerId:string; providerName:string; environment:"production"|"sandbox"; billDate:string;
  status:"running"|"succeeded"|"differences"|"not_ready"|"failed";
  attempts:number; entryCount:number; differenceCount:number; errorCode:string|null; fileSha256:string|null;
  completedAt:string|null; nextRetryAt:string;
  differences:{type:string;outTradeNo:string;transactionId?:string;refundId?:string;expectedFen?:number;actualFen?:number;localStatus?:string}[];
}
export const getPaymentBills=async()=> (await apiClient.getJson<PaymentBillReport[]>("/platform/payments/bills")).data;
export const reconcilePaymentBill=async(input:{providerId:string;billDate:string;reason:string})=>
  (await apiClient.postJson<PaymentBillReport[]>("/platform/payments/bills",input)).data;
