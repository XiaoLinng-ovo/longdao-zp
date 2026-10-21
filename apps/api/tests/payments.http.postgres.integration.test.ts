import assert from "node:assert/strict";
import { test } from "node:test";
import {
  randomUUID,
  randomBytes,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { createPostgresHealthPool } from "../src/recruiting/db-health.js";
import { PostgresSessionRepository } from "../src/auth/session-repository.js";
import { PaymentService } from "../src/payments/service.js";
import {
  createProvider,
  type PaymentEvidence,
  type PaymentProvider,
} from "../src/payments/providers.js";
import { createHttpServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
test("payment HTTP uses live sessions, enterprise authorization, CSRF and raw signed callback acknowledgement", async (t) => {
  assert.equal(process.env.PGPORT, "15433");
  assert.equal(process.env.PGDATABASE, "smartrecruit_test");
  const pool = createPostgresHealthPool(),
    repository = new PostgresSessionRepository(pool),
    org = randomUUID(),
    other = randomUUID(),
    actor = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID();
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const env = {
    PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PAYMENT_PUBLIC_BASE_URL: "https://recruit.example.com",
  };
  const evidence = new Map<string, PaymentEvidence>(),
    sessions: string[] = [];
  const service = new PaymentService(
    pool,
    (kind, cfg) => {
      const real = createProvider(kind, cfg);
      const p: PaymentProvider = {
        create: async () => ({
          payURL: null,
          qrCode: "https://pay.example.com/qr",
        }),
        query: async (no) =>
          evidence.get(no) ?? {
            outTradeNo: no,
            transactionId: "",
            amountFen: 19900,
            currency: "CNY",
            paid: false,
          },
        notification: real.notification.bind(real),
        close: async () => {},
        refund: async () => true,
        queryRefund: async () => true,
      };
      return p;
    },
    env,
  );
  const server = createHttpServer(
    { ...loadConfig(), host: "127.0.0.1", port: 0 },
    { paymentService: service },
  );
  let product: any,
    provider: any,
    order: any,
    headers: Record<string, string>,
    memberHeaders: Record<string, string>,
    outsiderHeaders: Record<string, string>;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  async function session(user: string, workspace: string) {
    const s = await repository.createSession({
      id: user,
      name: "HTTP payment fixture",
      email: user + "@example.invalid",
      role: "recruiter",
      departmentId: "",
      workspaceId: workspace,
    });
    sessions.push(s.session.sessionId);
    return {
      cookie:
        "smartrecruit_session=" + s.token + "; smartrecruit_csrf=fixture-csrf",
      "x-csrf-token": "fixture-csrf",
      origin: "http://127.0.0.1:5174",
      "x-workspace-id": workspace,
    };
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    h: Record<string, string> = {},
  ) {
    return fetch(base + "/api/v1" + path, {
      method,
      headers: {
        ...h,
        ...(body === undefined
          ? {}
          : {
              "content-type":
                typeof body === "string"
                  ? "application/x-www-form-urlencoded"
                  : "application/json",
            }),
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  }
  function signed(order: any, patch: Record<string, string> = {}) {
    const p: Record<string, string> = {
      app_id: "fixture-app",
      seller_id: "fixture-seller",
      out_trade_no: order.outTradeNo,
      trade_no: "ali_" + order.id,
      total_amount: "199.00",
      trade_status: "TRADE_SUCCESS",
      ...patch,
    };
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(
        Object.keys(p)
          .sort()
          .map((k) => k + "=" + p[k])
          .join("&"),
      ),
      keys.privateKey,
    ).toString("base64");
    return new URLSearchParams({
      ...p,
      sign_type: "RSA2",
      sign: signature,
    }).toString();
  }
  try {
    for (const id of [actor, member, outsider])
      await pool.query(
        "INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'HTTP payment fixture',true)",
        [id, id + "@example.invalid"],
      );
    await pool.query(
      "INSERT INTO platform_operators(user_id,role) VALUES($1,'admin')",
      [actor],
    );
    await pool.query(
      "INSERT INTO organizations(id,name,kind) VALUES($1,'HTTP payment fixture','test'),($2,'HTTP outsider','test')",
      [org, other],
    );
    await pool.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$3,'owner'),($1,$4,'member'),($2,$5,'owner')",
      [org, other, actor, member, outsider],
    );
    headers = await session(actor, org);
    memberHeaders = await session(member, org);
    outsiderHeaders = await session(outsider, other);
    await t.test(
      "anonymous and ordinary member are rejected; writes require trusted origin and CSRF",
      async () => {
        assert.equal(
          (await request("/payments/workspaces/" + org)).status,
          401,
        );
        assert.equal(
          (
            await request(
              "/payments/workspaces/" + org,
              "GET",
              undefined,
              memberHeaders,
            )
          ).status,
          403,
        );
        const input = {
          planVersionId: "00000000-0000-4000-8000-000000000053",
          name: "HTTP 正式售价",
          amountFen: 19900,
          durationDays: 30,
          reason: "支付测试",
        };
        assert.equal(
          (
            await request("/platform/payments/products", "POST", input, {
              ...headers,
              "x-csrf-token": "bad",
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/platform/payments/products", "POST", input, {
              ...headers,
              origin: "https://evil.example.com",
            })
          ).status,
          403,
        );
        const r = await request(
          "/platform/payments/products",
          "POST",
          input,
          headers,
        );
        assert.equal(r.status, 201);
        product = ((await r.json()) as any).data;
        assert.equal(
          (
            await request(
              "/platform/payments/products/" + product.id,
              "PATCH",
              { active: true, reason: "上架测试" },
              headers,
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      "admin saves RSA configuration without echoing secrets, then enables the channel",
      async () => {
        const input = {
          name: "HTTP 支付宝渠道",
          kind: "alipay",
          config: {
            appId: "fixture-app",
            sellerId: "fixture-seller",
            privateKey: keys.privateKey,
            publicKey: keys.publicKey,
          },
          reason: "渠道测试",
        };
        const r = await request(
          "/platform/payments/providers",
          "POST",
          input,
          headers,
        );
        assert.equal(r.status, 201);
        provider = ((await r.json()) as any).data;
        assert.equal(
          (
            await request(
              "/platform/payments/providers/" + provider.id,
              "PATCH",
              { enabled: true, reason: "启用测试" },
              headers,
            )
          ).status,
          200,
        );
        const body = await (
          await request("/platform/payments", "GET", undefined, headers)
        ).text();
        assert(!body.includes("PRIVATE KEY"));
        assert(!body.includes(keys.privateKey));
      },
    );
    await t.test(
      "server-priced order creation, tenant assertion and browser status cannot cause payment",
      async () => {
        const input = {
          productId: product.id,
          providerId: provider.id,
          method: "alipay",
          mode: "qrcode",
          expectedVersion: 1,
        };
        assert.equal(
          (
            await request(
              "/payments/workspaces/" + org + "/orders",
              "POST",
              { ...input, amountFen: 1 },
              { ...headers, "idempotency-key": randomUUID() },
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/payments/workspaces/" + org, "GET", undefined, {
              ...headers,
              "x-workspace-id": other,
            })
          ).status,
          409,
        );
        const r = await request(
          "/payments/workspaces/" + org + "/orders",
          "POST",
          input,
          { ...headers, "idempotency-key": randomUUID() },
        );
        assert.equal(r.status, 201);
        order = ((await r.json()) as any).data;
        assert.equal(order.amountFen, 19900);
        const result = await request(
          "/payments/workspaces/" +
            org +
            "/orders/" +
            order.id +
            "?status=success",
          "GET",
          undefined,
          headers,
        );
        assert.equal(((await result.json()) as any).data.status, "pending");
        assert.equal(
          (
            await request(
              "/payments/workspaces/" + other + "/orders/" + order.id,
              "GET",
              undefined,
              outsiderHeaders,
            )
          ).status,
          404,
        );
      },
    );
    await t.test(
      "invalid or wrong-amount callback fails; signed form success settles exactly once and ACKs plaintext success",
      async () => {
        const hook = "/payments/webhook/" + provider.id;
        assert.equal(
          (
            await request(
              hook,
              "POST",
              "out_trade_no=" + order.outTradeNo + "&status=success",
            )
          ).status,
          400,
        );
        assert.equal(
          (await request(hook, "POST", signed(order, { total_amount: "0.01" })))
            .status,
          409,
        );
        const responses = await Promise.all([
          request(hook, "POST", signed(order)),
          request(hook, "POST", signed(order)),
        ]);
        for (const r of responses) {
          assert.equal(r.status, 200);
          assert.equal(await r.text(), "success");
        }
        const status = (
          (await (
            await request(
              "/payments/workspaces/" + org + "/orders/" + order.id,
              "GET",
              undefined,
              headers,
            )
          ).json()) as any
        ).data.status;
        assert.equal(status, "fulfilled");
        assert.equal(
          (
            await pool.query(
              "SELECT entitlement_version FROM organizations WHERE id=$1",
              [org],
            )
          ).rows[0].entitlement_version,
          2,
        );
      },
    );
    await t.test(
      "role revocation blocks order reads even with an unchanged live session",
      async () => {
        await pool.query(
          "UPDATE organization_members SET role='member' WHERE organization_id=$1 AND user_id=$2",
          [org, actor],
        );
        assert.equal(
          (
            await request(
              "/payments/workspaces/" + org + "/orders/" + order.id,
              "GET",
              undefined,
              headers,
            )
          ).status,
          403,
        );
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of sessions)
      await pool.query("DELETE FROM sessions WHERE id=$1", [id]);
    await pool.query(
      "DELETE FROM payment_events WHERE order_id IN(SELECT id FROM payment_orders WHERE organization_id=$1)",
      [org],
    );
    await pool.query(
      "UPDATE organizations SET active_payment_order_id=NULL WHERE id=$1",
      [org],
    );
    await pool.query("DELETE FROM payment_orders WHERE organization_id=$1", [
      org,
    ]);
    await pool.query("DELETE FROM payment_products WHERE created_by=$1", [
      actor,
    ]);
    await pool.query("DELETE FROM payment_providers WHERE created_by=$1", [
      actor,
    ]);
    await pool.query(
      "DELETE FROM platform_audit_logs WHERE organization_id=ANY($1::uuid[]) OR actor_user_id=$2",
      [[org, other], actor],
    );
    await pool.query(
      "DELETE FROM organization_members WHERE organization_id=ANY($1::uuid[])",
      [[org, other]],
    );
    await pool.query("DELETE FROM organizations WHERE id=ANY($1::uuid[])", [
      [org, other],
    ]);
    await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [
      [actor, member, outsider],
    ]);
    await pool.end();
  }
});
