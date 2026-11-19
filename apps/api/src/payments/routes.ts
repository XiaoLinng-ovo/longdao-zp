import type { Middleware, RequestContext } from "../http.js";
import { HttpError } from "../http.js";
import { readJson } from "../body.js";
import { sendSuccess } from "../response.js";
import { assertPlatformWriteSecurity } from "../platform/access.js";
import { PaymentService } from "./service.js";
import { paymentClientIP } from "./security.js";
const readRaw = async (c: RequestContext) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of c.req) {
    size += chunk.length;
    if (size > 65536)
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "支付通知过大");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};
export function paymentRoutes(service: PaymentService): Middleware {
  return async (c, next) => {
    const path = c.url.pathname,
      method = c.req.method;
    if (
      !path.startsWith("/api/v1/payments/") &&
      !path.startsWith("/api/v1/platform/payments")
    )
      return next();
    c.res.setHeader("cache-control", "no-store");
    c.res.setHeader("referrer-policy", "no-referrer");
    const hook = path.match(/^\/api\/v1\/payments\/webhook\/([a-f0-9-]+)$/i);
    if (hook) {
      if (!["GET", "POST"].includes(method ?? ""))
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "回调方法无效");
      const raw =
        method === "GET" ? c.url.searchParams.toString() : await readRaw(c);
      if (raw.length > 65536)
        throw new HttpError(413, "PAYLOAD_TOO_LARGE", "支付通知过大");
      const headers = Object.fromEntries(
        Object.entries(c.req.headers).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.join(",") : (v ?? ""),
        ]),
      );
      const kind = await service.webhook(hook[1]!, raw, headers);
      c.res.statusCode = 200;
      c.res.setHeader(
        "content-type",
        kind === "wxpay" ? "application/json" : "text/plain;charset=utf-8",
      );
      c.res.end(
        kind === "wxpay"
          ? JSON.stringify({ code: "SUCCESS", message: "成功" })
          : "success",
      );
      return;
    }
    const auth = c.auth;
    if (!auth || auth.method !== "session")
      throw new HttpError(401, "AUTHENTICATION_REQUIRED", "请登录后管理付款");
    if (!["GET", "HEAD"].includes(method ?? "")) assertPlatformWriteSecurity(c);
    const actor = auth.user.id;
    const productVersion=path.match(/^\/api\/v1\/platform\/payments\/products\/([^/]+)\/(history|revisions)$/);
    if (productVersion) {
      if (productVersion[2]==='history' && method==='GET') sendSuccess(c,await service.productHistory(actor,productVersion[1]!));
      else if (productVersion[2]==='revisions' && method==='POST') sendSuccess(c,await service.publishProduct(actor,await readJson(c),productVersion[1]!),201);
      else throw new HttpError(405,'METHOD_NOT_ALLOWED','不支持此操作');
      return;
    }
    if (path==='/api/v1/platform/payments/products/merge' && method==='POST') {
      sendSuccess(c,await service.mergeProducts(actor,await readJson(c))); return;
    }
    if (path === '/api/v1/platform/payments/billing-policy') {
      if (method === 'GET') sendSuccess(c, await service.billingOverview(actor));
      else if (method === 'POST') sendSuccess(c, await service.publishBillingPolicy(actor, await readJson(c)), 201);
      else throw new HttpError(405,'METHOD_NOT_ALLOWED','不支持此操作');
      return;
    }
    if (path === '/api/v1/platform/payments/quota-grants' && method === 'POST') {
      sendSuccess(c, await service.grantBillingQuota(actor, await readJson(c)), 201); return;
    }
    if (path === '/api/v1/platform/payments/credit-conversions' && method === 'POST') {
      sendSuccess(c, await service.convertCredits(actor,await readJson(c))); return;
    }
    const conversion=path.match(/^\/api\/v1\/platform\/payments\/credit-conversions\/([^/]+)$/);
    if (conversion && method === 'GET') { sendSuccess(c,await service.previewCreditConversion(actor,conversion[1]!)); return; }
    const billingTask = path.match(/^\/api\/v1\/platform\/payments\/billing-tasks\/([^/]+)$/);
    if (billingTask && method === 'POST') { sendSuccess(c, await service.resolveBillingTask(actor,billingTask[1]!,await readJson(c))); return; }
    const balance = path.match(/^\/api\/v1\/payments\/workspaces\/([^/]+)\/usage$/);
    if (balance && method === 'GET') {
      if (c.req.headers['x-workspace-id'] !== undefined && c.req.headers['x-workspace-id'] !== balance[1]) throw new HttpError(409,'WORKSPACE_CONTEXT_CHANGED','企业信息已变化，请刷新');
      sendSuccess(c,await service.enterpriseBilling(actor,balance[1]!)); return;
    }
    if (path === "/api/v1/platform/payments/bills") {
      if (method === "GET") sendSuccess(c,await service.billReports(actor));
      else if (method === "POST") sendSuccess(c,await service.reconcileBill(actor,await readJson(c)));
      else throw new HttpError(405,"METHOD_NOT_ALLOWED","不支持此操作");
      return;
    }
    if (path === "/api/v1/platform/payments" && method === "GET") {
      sendSuccess(c, await service.adminOverview(actor));
      return;
    }
    const memberThread = path.match(/^\/api\/v1\/payments\/workspaces\/([^/]+)\/service\/requests\/([^/]+)(?:\/(messages|attachments)(?:\/([^/]+))?)?$/);
    const adminThread = path.match(/^\/api\/v1\/platform\/payments\/service-requests\/([^/]+)(?:\/(messages|attachments)(?:\/([^/]+))?)?$/);
    if (memberThread || (adminThread && (method === 'GET' || adminThread[2]))) {
      const org = memberThread?.[1], id = memberThread?.[2] ?? adminThread![1]!;
      const action = memberThread?.[3] ?? adminThread?.[2], attachmentId = memberThread?.[4] ?? adminThread?.[3];
      if (org && c.req.headers['x-workspace-id'] !== undefined && c.req.headers['x-workspace-id'] !== org)
        throw new HttpError(409, 'WORKSPACE_CONTEXT_CHANGED', '企业信息已变化，请刷新后重试');
      if (method === 'GET' && !action) sendSuccess(c, await service.serviceThread(actor,id,org,c.url.searchParams.get('before') ?? undefined));
      else if (method === 'POST' && action === 'messages' && !attachmentId) sendSuccess(c, await service.replyServiceRequest(actor,id,await readJson(c),org));
      else if (method === 'GET' && action === 'attachments' && attachmentId) {
        c.res.setHeader('x-content-type-options', 'nosniff');
        sendSuccess(c, await service.serviceAttachment(actor,id,attachmentId,org));
      } else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持此操作');
      return;
    }
    const serviceRequest = path.match(/^\/api\/v1\/platform\/payments\/service-requests\/([^/]+)$/);
    if (serviceRequest && method === 'POST') {
      sendSuccess(c, await service.resolveServiceRequest(actor, serviceRequest[1]!, await readJson(c)));
      return;
    }
    if (path === "/api/v1/platform/payments/products" && method === "POST") {
      sendSuccess(
        c,
        await service.publishProduct(actor, await readJson(c)),
        201,
      );
      return;
    }
    if (path === "/api/v1/platform/payments/providers" && method === "POST") {
      sendSuccess(c, await service.addProvider(actor, await readJson(c)), 201);
      return;
    }
    const toggle = path.match(
      /^\/api\/v1\/platform\/payments\/(products|providers)\/([^/]+)$/,
    );
    if (toggle && method === "PATCH") {
      const input = await readJson(c);
      sendSuccess(
        c,
        toggle[1] === "products"
          ? await service.toggleProduct(actor, toggle[2]!, input)
          : await service.toggleProvider(actor, toggle[2]!, input),
      );
      return;
    }
    const adminOrder = path.match(
      /^\/api\/v1\/platform\/payments\/orders\/([^/]+)\/(verify|refund|cancel)$/,
    );
    if (adminOrder && method === "POST") {
      sendSuccess(
        c,
        adminOrder[2] === "refund"
          ? await service.refund(
              actor,
              adminOrder[1]!,
              (await readJson(c)).reason,
            )
          : adminOrder[2] === 'cancel'
            ? await service.adminCancel(actor, adminOrder[1]!, (await readJson(c)).reason)
            : await service.adminVerify(actor, adminOrder[1]!),
      );
      return;
    }
    const continuity = path.match(/^\/api\/v1\/payments\/workspaces\/([^/]+)\/service(?:\/(export|requests))?$/);
    if (continuity) {
      const [,org,action] = continuity;
      if (c.req.headers['x-workspace-id'] !== undefined && c.req.headers['x-workspace-id'] !== org)
        throw new HttpError(409, 'WORKSPACE_CONTEXT_CHANGED', '企业信息已变化，请刷新后重试');
      if (method === 'GET' && !action) sendSuccess(c, await service.continuity(actor, org!));
      else if (method === 'POST' && action === 'export') sendSuccess(c, await service.exportContinuity(actor, org!));
      else if (method === 'POST' && action === 'requests') sendSuccess(c, await service.contactAdministrator(actor, org!, await readJson(c)));
      else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持此操作');
      return;
    }
    // Explicit billing-only organization selection permits renewal of an expired workspace.
    // Every operation checks live membership; it does not change the recruitment workspace.
    const enterprise = path.match(
      /^\/api\/v1\/payments\/workspaces\/([^/]+)(?:\/orders(?:\/([^/]+)(?:\/(verify|cancel))?)?)?$/,
    );
    if (enterprise) {
      const [, org, id, action] = enterprise;
      const expected = c.req.headers["x-workspace-id"];
      if (expected !== undefined && expected !== org)
        throw new HttpError(
          409,
          "WORKSPACE_CONTEXT_CHANGED",
          "付款页面企业信息已变化，请刷新",
        );
      if (method === "GET") {
        sendSuccess(
          c,
          id
            ? await service.read(actor, org!, id)
            : await service.checkout(actor, org!),
        );
        return;
      }
      if (method === "POST" && id && action) {
        sendSuccess(
          c,
          action === "verify"
            ? await service.verify(actor, org!, id)
            : await service.cancel(actor, org!, id),
        );
        return;
      }
      if (method === "POST" && !id && path.endsWith("/orders")) {
        const key = c.req.headers["idempotency-key"];
        sendSuccess(
          c,
          await service.create(
            actor,
            org!,
            await readJson(c),
            typeof key === "string" ? key : "",
            paymentClientIP(
              c.req.socket.remoteAddress,
              c.req.headers["x-forwarded-for"],
            ),
          ),
          201,
        );
        return;
      }
    }
    throw new HttpError(404, "NOT_FOUND", "支付接口不存在");
  };
}
