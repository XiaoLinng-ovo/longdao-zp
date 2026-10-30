import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import { createPostgresHealthPool } from "../src/recruiting/db-health.js";
import { PaymentService } from "../src/payments/service.js";
import type {
  PaymentProvider,
  PaymentEvidence,
  PaymentRequest,
} from "../src/payments/providers.js";
test("real-payment ledger serializes enterprise orders, settlement, expiry, pricing and refund races", async (t) => {
  assert.equal(process.env.PGPORT, "15433");
  assert.equal(process.env.PGDATABASE, "smartrecruit_test");
  const pool = createPostgresHealthPool(),
    org = randomUUID(),
    other = randomUUID(),
    actor = randomUUID(),
    member = randomUUID(),
    outsider = randomUUID(),
    viewer = randomUUID();
  const env = {
    PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    PAYMENT_PUBLIC_BASE_URL: "https://recruit.example.com",
  };
  let creates = 0,
    failCreate = false,
    failRefund = false,
    refunds = 0,
    refundReady = false,
    lastRequest: PaymentRequest | null = null;
  const evidence = new Map<string, PaymentEvidence>();
  const adapter: PaymentProvider = {
    create: async (r) => {
      creates++;
      lastRequest = r;
      if (failCreate) throw Error("timeout");
      return {
        payURL: r.mode === "redirect" ? "https://pay.example.com/order" : null,
        qrCode: r.mode === "qrcode" ? "https://pay.example.com/qr" : null,
      };
    },
    query: async (no) =>
      evidence.get(no) ?? {
        outTradeNo: no,
        transactionId: "",
        amountFen: 29900,
        currency: "CNY",
        paid: false,
      },
    notification: async () => null,
    close: async () => {},
    refund: async () => {
      refunds++;
      if (failRefund) throw Error("uncertain");
      return true;
    },
    queryRefund: async () => refundReady,
  };
  const service = new PaymentService(pool, () => adapter, env);
  let product: any, provider: any, first: any, newer: any;
  const create = (key = randomUUID(), patch: Record<string, unknown> = {}) =>
    service.create(
      actor,
      org,
      {
        productId: product.id,
        providerId: provider.id,
        method: "alipay",
        mode: "qrcode",
        expectedVersion: 1,
        ...patch,
      },
      key,
      "203.0.113.10",
    );
  const paid = (o: any, tx = "tx_" + o.id): PaymentEvidence => ({
    outTradeNo: o.outTradeNo,
    transactionId: tx,
    amountFen: o.amountFen,
    currency: "CNY",
    paid: true,
  });
  try {
    for (const id of [actor, member, outsider, viewer])
      await pool.query(
        "INSERT INTO users(id,email,display_name,is_active) VALUES($1,$2,'Payment fixture',true)",
        [id, id + "@example.invalid"],
      );
    await pool.query(
      "INSERT INTO platform_operators(user_id,role) VALUES($1,'admin'),($2,'viewer')",
      [actor, viewer],
    );
    await pool.query(
      "INSERT INTO organizations(id,name,kind) VALUES($1,'Payment fixture','test'),($2,'Payment outsider','test')",
      [org, other],
    );
    await pool.query(
      "INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$3,'owner'),($1,$4,'member'),($2,$5,'owner')",
      [org, other, actor, member, outsider],
    );
    product = await service.publishProduct(actor, {
      planVersionId: "00000000-0000-4000-8000-000000000053",
      name: "正式付款测试套餐",
      amountFen: 29900,
      durationDays: 30,
      reason: "隔离支付测试",
    });
    await service.toggleProduct(actor, product.id, {
      active: true,
      reason: "测试上架",
    });
    provider = await service.addProvider(actor, {
      name: "隔离支付渠道",
      kind: "easypay",
      config: {
        apiBase: "https://pay.example.com",
        pid: "fixture",
        pkey: "fixture-secret",
      },
      reason: "测试渠道",
    });
    await service.toggleProvider(actor, provider.id, {
      enabled: true,
      reason: "测试启用",
    });
    await t.test(
      "real role checks, integer prices, encrypted secrets, immutable products and cross-tenant reads",
      async () => {
        await assert.rejects(
          service.publishProduct(viewer, {
            planVersionId: product.planVersionId,
            name: "越权商品",
            amountFen: 100,
            durationDays: 30,
            reason: "越权测试",
          }),
          { code: "PLATFORM_PERMISSION_REQUIRED" },
        );
        await assert.rejects(service.checkout(member, org), {
          code: "WORKSPACE_ADMIN_REQUIRED",
        });
        await assert.rejects(service.checkout(actor, other), {
          code: "WORKSPACE_ADMIN_REQUIRED",
        });
        await assert.rejects(create(randomUUID(), { amountFen: 1 }), {
          code: "VALIDATION_ERROR",
        });
        await assert.rejects(
          pool.query("UPDATE payment_products SET amount_fen=1 WHERE id=$1", [
            product.id,
          ]),
        );
        const raw = (
          await pool.query(
            "SELECT config_ciphertext FROM payment_providers WHERE id=$1",
            [provider.id],
          )
        ).rows[0].config_ciphertext;
        assert(!raw.includes("fixture-secret"));
        assert(
          !JSON.stringify(await service.adminOverview(actor)).includes(
            "fixture-secret",
          ),
        );
      },
    );
    await t.test(
      "concurrent same-key creation invokes upstream once and snapshots canonical return URL",
      async () => {
        const key = randomUUID(),
          results = await Promise.all([create(key), create(key), create(key)]);
        assert.equal(new Set(results.map((r) => r.id)).size, 1);
        assert.equal(creates, 1);
        first = await service.read(actor, org, results[0]!.id);
        assert.equal(first.amountFen, 29900);
        assert.equal(first.status, "pending");
        assert.match(first.outTradeNo, /^sr[a-f0-9]{30}$/);
        assert(
          lastRequest!.returnURL.includes(
            "/enterprise/payments/" + first.id + "?workspace=" + org,
          ),
        );
        await assert.rejects(create(key, { mode: "redirect" }), {
          code: "ORDER_KEY_CONFLICT",
        });
        await assert.rejects(service.read(outsider, other, first.id), {
          code: "ORDER_NOT_FOUND",
        });
      },
    );
    await t.test(
      "forged amount, provider and transaction fail; duplicate concurrent paid notifications grant once",
      async () => {
        await assert.rejects(
          service.settle(
            provider.id,
            { ...paid(first), amountFen: 1 },
            "callback",
          ),
          { code: "PAYMENT_EVENT_MISMATCH" },
        );
        await assert.rejects(
          service.settle(randomUUID(), paid(first), "callback"),
          { code: "ORDER_NOT_FOUND" },
        );
        await Promise.all([
          service.settle(provider.id, paid(first), "callback"),
          service.settle(provider.id, paid(first), "query"),
        ]);
        assert.equal(
          (await service.read(actor, org, first.id)).status,
          "fulfilled",
        );
        const o = (
          await pool.query("SELECT * FROM organizations WHERE id=$1", [org])
        ).rows[0];
        assert.equal(o.entitlement_version, 2);
        assert.equal(o.plan_version_id, product.planVersionId);
        assert.equal(
          (
            await pool.query(
              "SELECT count(*)::int n FROM payment_events WHERE order_id=$1",
              [first.id],
            )
          ).rows[0].n,
          1,
        );
        await assert.rejects(
          service.settle(provider.id, paid(first, "changed-tx"), "callback"),
          { code: "PAYMENT_EVENT_MISMATCH" },
        );
      },
    );
    await t.test(
      "disabled channel still verifies historical orders; same-plan renewal extends expiry",
      async () => {
        newer = await create(randomUUID(), {
          expectedVersion: 2,
          mode: "redirect",
        });
        const before = (
          await pool.query(
            "SELECT paid_subscription_expires_at FROM organizations WHERE id=$1",
            [org],
          )
        ).rows[0].paid_subscription_expires_at;
        await service.toggleProvider(actor, provider.id, {
          enabled: false,
          reason: "测试停用",
        });
        await service.settle(provider.id, paid(newer), "callback");
        const after = (
          await pool.query(
            "SELECT paid_subscription_expires_at FROM organizations WHERE id=$1",
            [org],
          )
        ).rows[0].paid_subscription_expires_at;
        assert.equal(after.getTime() - before.getTime(), 30 * 86400000);
        await assert.rejects(create(randomUUID(), { expectedVersion: 3 }), {
          code: "PAYMENT_UNAVAILABLE",
        });
        await service.toggleProvider(actor, provider.id, {
          enabled: true,
          reason: "测试启用",
        });
      },
    );
    await t.test(
      "refund of old order preserves newer rights; refund of new order cannot resurrect refunded predecessor",
      async () => {
        await service.refund(actor, first.id, "测试旧订单退款");
        assert.equal(
          (await service.read(actor, org, first.id)).status,
          "refunded",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT entitlement_version FROM organizations WHERE id=$1",
              [org],
            )
          ).rows[0].entitlement_version,
          3,
        );
        await service.refund(actor, newer.id, "测试新订单退款");
        assert.equal(
          (await service.read(actor, org, newer.id)).status,
          "refunded",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT service_status FROM organizations WHERE id=$1",
              [org],
            )
          ).rows[0].service_status,
          "suspended",
        );
        await service.settle(provider.id, paid(newer), "callback");
        assert.equal(
          (await service.read(actor, org, newer.id)).status,
          "refunded",
        );
        await pool.query(
          "UPDATE organizations SET service_status='enabled',plan_version_id='00000000-0000-4000-8000-000000000051',active_payment_order_id=NULL,paid_subscription_expires_at=NULL WHERE id=$1",
          [org],
        );
      },
    );
    await t.test(
      "late or stale-entitlement success records review without overwriting rights",
      async () => {
        const expired = await create(randomUUID(), { expectedVersion: 3 });
        await pool.query(
          "UPDATE payment_orders SET expires_at=now()-interval '1 minute' WHERE id=$1",
          [expired.id],
        );
        await service.settle(provider.id, paid(expired), "callback");
        assert.equal(
          (await service.read(actor, org, expired.id)).status,
          "review",
        );
        const stale = await create(randomUUID(), { expectedVersion: 3 });
        await pool.query(
          "UPDATE organizations SET entitlement_version=entitlement_version+1 WHERE id=$1",
          [org],
        );
        await service.settle(provider.id, paid(stale), "callback");
        assert.equal(
          (await service.read(actor, org, stale.id)).status,
          "review",
        );
        await service.refund(actor, expired.id, "退款迟到付款");
        await service.refund(actor, stale.id, "退款权益冲突");
      },
    );
    await t.test(
      "create timeout remains uncertain and is recovered by query without creating another order",
      async () => {
        failCreate = true;
        const key = randomUUID(),
          order = await create(key, { expectedVersion: 4 });
        assert.equal(order.status, "uncertain");
        const count = creates;
        assert.equal((await create(key, { expectedVersion: 4 })).id, order.id);
        assert.equal(creates, count);
        failCreate = false;
        evidence.set(order.outTradeNo, paid(order));
        assert.equal(
          (await service.verify(actor, org, order.id)).status,
          "fulfilled",
        );
        failRefund = true;
        const result = await service.refund(actor, order.id, "不确定退款测试");
        assert.equal(result.status, "refund_pending");
        const countRefunds = refunds;
        await assert.rejects(service.refund(actor, order.id, "再次退款测试"), {
          code: "REFUND_PENDING",
        });
        assert.equal(refunds, countRefunds);
        await pool.query(
          "UPDATE payment_orders SET last_checked_at=now()-interval '1 minute' WHERE id=$1",
          [order.id],
        );
        refundReady = true;
        await service.adminVerify(actor, order.id);
        assert.equal(
          (await service.read(actor, org, order.id)).status,
          "refunded",
        );
        failRefund = false;
      },
    );
    await t.test(
      "event write fault atomically rolls back paid and entitlements, then retry recovers",
      async () => {
        const version = (
          await pool.query(
            "SELECT entitlement_version FROM organizations WHERE id=$1",
            [org],
          )
        ).rows[0].entitlement_version;
        const order = await create(randomUUID(), { expectedVersion: version }),
          constraint = "payment_fault_" + randomUUID().replaceAll("-", "");
        try {
          await pool.query(
            "ALTER TABLE payment_events ADD CONSTRAINT " +
              constraint +
              " CHECK(order_id <> '" +
              order.id +
              "'::uuid) NOT VALID",
          );
          await assert.rejects(
            service.settle(provider.id, paid(order), "callback"),
          );
          assert.equal((await service.read(actor, org, order.id)).paidAt, null);
          assert.equal(
            (
              await pool.query(
                "SELECT entitlement_version FROM organizations WHERE id=$1",
                [org],
              )
            ).rows[0].entitlement_version,
            version,
          );
        } finally {
          await pool.query(
            "ALTER TABLE payment_events DROP CONSTRAINT " + constraint,
          );
        }
        await service.settle(provider.id, paid(order), "callback");
        assert.equal(
          (await service.read(actor, org, order.id)).status,
          "fulfilled",
        );
      },
    );
    await t.test("calendar products preserve immutable snapshots and renew by Shanghai calendar month", async () => {
      const base = {
        planVersionId: product.planVersionId,
        name: "自然月正式套餐", amountFen: 25800, reason: "自然月套餐隔离验证",
      };
      for (const duration of [
        {}, { durationMonths: 0 }, { durationMonths: 121 }, { durationMonths: 1.5 },
        { durationDays: 30, durationMonths: 1 }, { durationMonths: 1, allModules: "true" },
      ]) await assert.rejects(service.publishProduct(actor, { ...base, ...duration }), { code: "VALIDATION_ERROR" });
      assert.equal(product.durationDays, 30);
      assert.equal(product.durationMonths, null);
      const monthly = await service.publishProduct(actor, { ...base, durationMonths: 1, allModules: true });
      assert.equal(monthly.durationDays, null);
      assert.equal(monthly.durationMonths, 1);
      assert.equal(monthly.allModules, true);
      await service.toggleProduct(actor, monthly.id, { active: true, reason: "测试上架" });
      await assert.rejects(pool.query("UPDATE payment_products SET duration_months=2 WHERE id=$1", [monthly.id]));
      await assert.rejects(pool.query("UPDATE payment_products SET all_modules=false WHERE id=$1", [monthly.id]));
      await assert.rejects(pool.query("UPDATE payment_products SET duration_days=30 WHERE id=$1", [monthly.id]));
      const originalExpiry = "2099-01-31T04:00:00.000Z";
      await pool.query("UPDATE organizations SET plan_version_id=$2, paid_subscription_expires_at=$3 WHERE id=$1", [org, monthly.planVersionId, originalExpiry]);
      const checkout = await service.checkout(actor, org);
      const visible = checkout.products.find((p) => p.id === monthly.id)!;
      assert.equal(visible.durationMonths, 1);
      assert.equal(visible.allModules, true);
      const order = await create(randomUUID(), { productId: monthly.id, expectedVersion: checkout.organization.entitlementVersion });
      assert.equal(order.durationDays, null);
      assert.equal(order.durationMonths, 1);
      assert.equal(order.allModules, true);
      await service.settle(provider.id, paid(order), "callback");
      assert.equal((await service.read(actor, org, order.id)).status, "fulfilled");
      const renewed = (await pool.query("SELECT paid_subscription_expires_at FROM organizations WHERE id=$1", [org])).rows[0];
      assert.equal(renewed.paid_subscription_expires_at.toISOString(), "2099-02-28T04:00:00.000Z");
      await service.refund(actor, order.id, "自然月退款回退验证");
      const restored = (await pool.query("SELECT paid_subscription_expires_at FROM organizations WHERE id=$1", [org])).rows[0];
      assert.equal(restored.paid_subscription_expires_at.toISOString(), originalExpiry);
      for (const [start, months, expected] of [
        ["2028-01-31T04:00:00Z", 1, "2028-02-29T04:00:00.000Z"],
        ["2028-08-31T04:00:00Z", 6, "2029-02-28T04:00:00.000Z"],
        ["2028-02-29T04:00:00Z", 12, "2029-02-28T04:00:00.000Z"],
      ] as const) {
        const result = await pool.query("SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai') + make_interval(months => $2::integer)) AT TIME ZONE 'Asia/Shanghai' AS expires", [start, months]);
        assert.equal(result.rows[0].expires.toISOString(), expected);
      }
    });
    await t.test(
      "expired subscriptions retain billing access without restoring recruitment access",
      async () => {
        await pool.query(
          "UPDATE organizations SET paid_subscription_expires_at=now()-interval '1 day' WHERE id=$1",
          [org],
        );
        assert.equal(
          (
            await pool.query("SELECT organization_service_available($1) a", [
              org,
            ])
          ).rows[0].a,
          false,
        );
        assert.equal((await service.checkout(actor, org)).canPurchase, true);
        await pool.query(
          "UPDATE organization_members SET role='member' WHERE organization_id=$1 AND user_id=$2",
          [org, actor],
        );
        await assert.rejects(service.checkout(actor, org), {
          code: "WORKSPACE_ADMIN_REQUIRED",
        });
      },
    );
  } finally {
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
      [actor, member, outsider, viewer],
    ]);
    await pool.end();
  }
});
