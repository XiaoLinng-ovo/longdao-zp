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
    if (path === "/api/v1/platform/payments" && method === "GET") {
      sendSuccess(c, await service.adminOverview(actor));
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
      /^\/api\/v1\/platform\/payments\/orders\/([^/]+)\/(verify|refund)$/,
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
          : await service.adminVerify(actor, adminOrder[1]!),
      );
      return;
    }
    // Explicit billing-only organization selection permits renewal of an expired workspace.
    // Every operation checks live membership; it does not change the recruitment workspace.
    const enterprise = path.match(
      /^\/api\/v1\/payments\/workspaces\/([^/]+)(?:\/orders(?:\/([^/]+)(?:\/(verify|cancel))?)?)?$/,
    );
    if (enterprise) {
      const [, org, id, action] = enterprise;
      if (auth.user.workspaceId && auth.user.workspaceId !== org)
        throw new HttpError(
          409,
          "WORKSPACE_CONTEXT_CHANGED",
          "请切换到付款企业后操作",
        );
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
