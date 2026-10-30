import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { HttpError } from "../http.js";
import { PlatformService } from "../platform/service.js";
import {
  createProvider,
  type PaymentProvider,
  type PaymentEvidence,
} from "./providers.js";
import {
  uuid,
  note,
  encryptConfig,
  decryptConfig,
  validateConfig,
  publicBase,
  type PaymentKind,
  type PaymentMethod,
  type PaymentMode,
  type MerchantConfig,
} from "./security.js";
type Row = Record<string, any>;
type Factory = (kind: PaymentKind, config: MerchantConfig) => PaymentProvider;
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const orderView = (r: Row) => ({
  id: r.id,
  outTradeNo: r.out_trade_no,
  organizationId: r.organization_id,
  name: r.product_name,
  amountFen: r.amount_fen,
  currency: r.currency,
  durationDays: r.duration_days,
  durationMonths: r.duration_months ?? null,
  allModules: r.all_modules ?? false,
  method: r.method,
  mode: r.mode,
  status: r.status,
  payURL: r.pay_url,
  qrCode: r.qr_code,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  paidAt: r.paid_at,
  refundedAt: r.refunded_at,
  reviewReason: r.review_reason,
});
const productView = (r: Row) => ({
  id: r.id,
  planVersionId: r.plan_version_id,
  name: r.name,
  amountFen: r.amount_fen,
  currency: r.currency,
  durationDays: r.duration_days,
  durationMonths: r.duration_months ?? null,
  allModules: r.all_modules ?? false,
  active: r.active,
  seatLimit: r.seat_limit,
  jobLimit: r.job_limit,
  createdAt: r.created_at,
});
export class PaymentService {
  private readonly access: PlatformService;
  constructor(
    private readonly pool: Pool,
    private readonly factory: Factory = createProvider,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.access = new PlatformService(pool);
  }
  private async tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const value = await fn(db);
      await db.query("COMMIT");
      return value;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  private async enterprise(
    db: PoolClient,
    actor: string,
    org: string,
  ): Promise<Row> {
    uuid(org);
    uuid(actor);
    const o = (
      await db.query(
        "SELECT * FROM organizations WHERE id=$1 FOR NO KEY UPDATE",
        [org],
      )
    ).rows[0];
    const member = (
      await db.query(
        "SELECT m.role FROM organization_members m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND u.is_active FOR SHARE OF m,u",
        [org, actor],
      )
    ).rows[0];
    if (!member || !["owner", "admin"].includes(member.role))
      throw new HttpError(
        403,
        "WORKSPACE_ADMIN_REQUIRED",
        "仅企业所有者或管理员可管理企业付款",
      );
    if (!o || o.status !== "active")
      throw new HttpError(403, "WORKSPACE_ARCHIVED", "归档企业不能付款");
    return o;
  }
  private async audit(
    db: PoolClient,
    actor: string | null,
    org: string | null,
    action: string,
    metadata: unknown,
  ) {
    await db.query(
      "INSERT INTO platform_audit_logs(actor_user_id,organization_id,action,metadata) VALUES($1,$2,$3,$4)",
      [actor, org, action, metadata],
    );
  }
  async adminOverview(actor: string) {
    await this.access.requireAccess(actor);
    const products = (
      await this.pool.query(
        "SELECT p.*,v.seat_limit,v.job_limit FROM payment_products p JOIN subscription_plan_versions v ON v.id=p.plan_version_id ORDER BY p.created_at DESC LIMIT 200",
      )
    ).rows.map(productView);
    const providers = (
      await this.pool.query(
        "SELECT id,name,kind,enabled,created_at FROM payment_providers ORDER BY created_at DESC LIMIT 100",
      )
    ).rows;
    const orders = (
      await this.pool.query(
        "SELECT p.*,o.name AS organization_name FROM payment_orders p JOIN organizations o ON o.id=p.organization_id ORDER BY p.created_at DESC LIMIT 100",
      )
    ).rows.map((r) => ({
      ...orderView(r),
      organizationName: r.organization_name,
      providerId: r.provider_id,
    }));
    return {
      products,
      providers,
      orders,
      keyConfigured: !!this.env.PAYMENT_ENCRYPTION_KEY,
      publicBaseURL: this.env.PAYMENT_PUBLIC_BASE_URL ?? null,
    };
  }
  async publishProduct(actor: string, input: Row) {
    const dayBased = Number.isSafeInteger(input.durationDays) &&
      input.durationDays >= 1 && input.durationDays <= 3660 &&
      input.durationMonths == null;
    const monthBased = Number.isSafeInteger(input.durationMonths) &&
      input.durationMonths >= 1 && input.durationMonths <= 120 &&
      input.durationDays == null;
    if (
      Object.keys(input).some(
        (k) =>
          ![
            "planVersionId",
            "name",
            "amountFen",
            "durationDays",
            "durationMonths",
            "allModules",
            "reason",
          ].includes(k),
      ) ||
      typeof input.name !== "string" ||
      input.name.trim().length < 2 ||
      input.name.trim().length > 80 ||
      !Number.isSafeInteger(input.amountFen) ||
      input.amountFen < 1 ||
      input.amountFen > 100000000 ||
      (!dayBased && !monthBased) ||
      (input.allModules !== undefined && typeof input.allModules !== "boolean")
    )
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "请填写有效商品名称、分单位售价，以及 1～3660 天或 1～120 个月期限（二选一）",
      );
    const plan = uuid(input.planVersionId),
      reason = note(input.reason);
    return this.tx(async (db) => {
      await this.access.requireAccess(actor, true, db, true);
      const p = (
        await db.query("SELECT * FROM subscription_plan_versions WHERE id=$1", [
          plan,
        ])
      ).rows[0];
      if (
        !p ||
        p.code === "legacy" ||
        p.seat_limit === null ||
        p.job_limit === null
      )
        throw new HttpError(400, "PLAN_INVALID", "请选择明确容量的已发布套餐");
      const r = (
        await db.query(
          "INSERT INTO payment_products(plan_version_id,name,amount_fen,duration_days,created_by,duration_months,all_modules) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [plan, input.name.trim(), input.amountFen, input.durationDays ?? null, actor, input.durationMonths ?? null, input.allModules ?? false],
        )
      ).rows[0];
      await this.audit(db, actor, null, "payment.product.publish", {
        productId: r.id,
        reason,
        amountFen: input.amountFen,
        durationDays: r.duration_days,
        durationMonths: r.duration_months,
        allModules: r.all_modules,
      });
      return productView({
        ...r,
        seat_limit: p.seat_limit,
        job_limit: p.job_limit,
      });
    });
  }
  async toggleProduct(actor: string, id: string, input: Row) {
    uuid(id);
    const reason = note(input.reason);
    if (typeof input.active !== "boolean")
      throw new HttpError(400, "VALIDATION_ERROR", "上下架状态无效");
    return this.tx(async (db) => {
      await this.access.requireAccess(actor, true, db, true);
      const r = (
        await db.query(
          "UPDATE payment_products SET active=$2 WHERE id=$1 RETURNING *",
          [id, input.active],
        )
      ).rows[0];
      if (!r) throw new HttpError(404, "NOT_FOUND", "商品不存在");
      await this.audit(db, actor, null, "payment.product.availability", {
        id,
        active: input.active,
        reason,
      });
      return productView(r);
    });
  }
  async addProvider(actor: string, input: Row) {
    const reason = note(input.reason);
    if (
      !["wxpay", "alipay", "easypay"].includes(input.kind) ||
      typeof input.name !== "string" ||
      input.name.trim().length < 2 ||
      input.name.length > 80
    )
      throw new HttpError(400, "VALIDATION_ERROR", "支付渠道无效");
    const cfg = validateConfig(input.kind, input.config),
      id = randomUUID(),
      encrypted = encryptConfig(cfg, id, this.env);
    return this.tx(async (db) => {
      await this.access.requireAccess(actor, true, db, true);
      const r = (
        await db.query(
          "INSERT INTO payment_providers(id,name,kind,config_ciphertext,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,kind,enabled",
          [id, input.name.trim(), input.kind, encrypted, actor],
        )
      ).rows[0];
      await this.audit(db, actor, null, "payment.provider.create", {
        id,
        kind: input.kind,
        reason,
      });
      return r;
    });
  }
  async toggleProvider(actor: string, id: string, input: Row) {
    uuid(id);
    const reason = note(input.reason);
    if (typeof input.enabled !== "boolean")
      throw new HttpError(400, "VALIDATION_ERROR", "渠道状态无效");
    if (input.enabled) publicBase(this.env);
    return this.tx(async (db) => {
      await this.access.requireAccess(actor, true, db, true);
      const p = (
        await db.query(
          "SELECT * FROM payment_providers WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!p) throw new HttpError(404, "NOT_FOUND", "渠道不存在");
      decryptConfig(p.config_ciphertext, id, this.env);
      await db.query("UPDATE payment_providers SET enabled=$2 WHERE id=$1", [
        id,
        input.enabled,
      ]);
      await this.audit(db, actor, null, "payment.provider.availability", {
        id,
        enabled: input.enabled,
        reason,
      });
      return { id, enabled: input.enabled };
    });
  }
  async checkout(actor: string, org: string) {
    return this.tx(async (db) => {
      const o = await this.enterprise(db, actor, org);
      const products = (
        await db.query(
          "SELECT p.*,v.seat_limit,v.job_limit FROM payment_products p JOIN subscription_plan_versions v ON v.id=p.plan_version_id WHERE p.active ORDER BY p.amount_fen,p.created_at",
        )
      ).rows.map(productView);
      const providers = (
        await db.query(
          "SELECT id,name,kind FROM payment_providers WHERE enabled ORDER BY created_at,id",
        )
      ).rows;
      const orders = (
        await db.query(
          "SELECT * FROM payment_orders WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50",
          [org],
        )
      ).rows.map(orderView);
      return {
        products,
        providers,
        orders,
        organization: {
          id: org,
          name: o.name,
          entitlementVersion: o.entitlement_version,
          expiresAt: o.paid_subscription_expires_at,
          seatUsage: o.seat_usage,
          jobUsage: o.job_usage,
        },
        canPurchase: o.service_status !== "suspended",
      };
    });
  }
  private async provider(id: string, db: Pool | PoolClient = this.pool) {
    const r = (
      await db.query("SELECT * FROM payment_providers WHERE id=$1", [uuid(id)])
    ).rows[0];
    if (!r)
      throw new HttpError(404, "PAYMENT_PROVIDER_NOT_FOUND", "支付渠道不存在");
    return {
      row: r,
      api: this.factory(
        r.kind,
        decryptConfig(r.config_ciphertext, r.id, this.env),
      ),
    };
  }
  async create(
    actor: string,
    org: string,
    input: Row,
    key: string,
    clientIP: string,
  ) {
    if (
      Object.keys(input).some(
        (k) =>
          ![
            "productId",
            "providerId",
            "method",
            "mode",
            "expectedVersion",
          ].includes(k),
      ) ||
      !["wxpay", "alipay"].includes(input.method) ||
      !["qrcode", "redirect"].includes(input.mode) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(key)
    )
      throw new HttpError(400, "VALIDATION_ERROR", "订单参数或幂等标识无效");
    uuid(input.productId);
    uuid(input.providerId);
    const fingerprint = digest(input),
      base = publicBase(this.env);
    const allocation = await this.tx(async (db) => {
      const orgRow = await this.enterprise(db, actor, org);
      const existing = (
        await db.query(
          "SELECT * FROM payment_orders WHERE organization_id=$1 AND actor_id=$2 AND idempotency_key=$3",
          [org, actor, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new HttpError(
            409,
            "ORDER_KEY_CONFLICT",
            "同一标识不能创建不同订单",
          );
        return { row: existing, fresh: false };
      }
      if (orgRow.service_status === "suspended")
        throw new HttpError(
          403,
          "WORKSPACE_SUSPENDED",
          "暂停企业请联系平台管理员",
        );
      if (orgRow.entitlement_version !== input.expectedVersion)
        throw new HttpError(
          409,
          "VERSION_CONFLICT",
          "企业套餐已变化，请刷新重试",
        );
      const product = (
        await db.query(
          "SELECT p.*,v.seat_limit,v.job_limit FROM payment_products p JOIN subscription_plan_versions v ON v.id=p.plan_version_id WHERE p.id=$1 AND p.active FOR SHARE OF p",
          [input.productId],
        )
      ).rows[0];
      const provider = (
        await db.query(
          "SELECT * FROM payment_providers WHERE id=$1 AND enabled FOR SHARE",
          [input.providerId],
        )
      ).rows[0];
      if (!product || !provider)
        throw new HttpError(
          409,
          "PAYMENT_UNAVAILABLE",
          "商品已下架或支付渠道已停用",
        );
      if (provider.kind !== "easypay" && provider.kind !== input.method)
        throw new HttpError(
          400,
          "PAYMENT_METHOD_MISMATCH",
          "支付方式与渠道不匹配",
        );
      if (
        orgRow.seat_usage > product.seat_limit ||
        orgRow.job_usage > product.job_limit
      )
        throw new HttpError(
          409,
          "PLAN_CAPACITY_BELOW_USAGE",
          "套餐容量低于当前使用量",
        );
      if (
        (
          await db.query(
            "SELECT count(*)::int n FROM payment_orders WHERE organization_id=$1 AND status IN ('creating','pending','uncertain') AND expires_at>now()",
            [org],
          )
        ).rows[0].n >= 5
      )
        throw new HttpError(
          429,
          "PAYMENT_PENDING_LIMIT",
          "请先完成或关闭已有待付款订单",
        );
      const id = randomUUID(),
        no = "sr" + randomBytes(15).toString("hex");
      const row = (
        await db.query(
          "INSERT INTO payment_orders(id,out_trade_no,organization_id,actor_id,product_id,provider_id,method,mode,amount_fen,currency,product_name,plan_version_id,duration_days,expected_version,idempotency_key,fingerprint,duration_months,all_modules) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *",
          [
            id,
            no,
            org,
            actor,
            product.id,
            provider.id,
            input.method,
            input.mode,
            product.amount_fen,
            "CNY",
            product.name,
            product.plan_version_id,
            product.duration_days,
            input.expectedVersion,
            key,
            fingerprint,
            product.duration_months,
            product.all_modules,
          ],
        )
      ).rows[0];
      await this.audit(db, actor, org, "payment.order.create", {
        orderId: id,
        amountFen: row.amount_fen,
      });
      return { row, fresh: true };
    });
    if (!allocation.fresh) return orderView(allocation.row);
    const r = allocation.row;
    try {
      const { api } = await this.provider(r.provider_id);
      const result = await api.create({
        outTradeNo: r.out_trade_no,
        amountFen: r.amount_fen,
        name: r.product_name,
        method: r.method as PaymentMethod,
        mode: r.mode as PaymentMode,
        notifyURL: base + "/api/v1/payments/webhook/" + r.provider_id,
        returnURL: base + "/enterprise/payments/" + r.id + "?workspace=" + org,
        clientIP,
        expiresAt: new Date(r.expires_at).toISOString(),
      });
      if (result.payURL) {
        const u = new URL(result.payURL);
        if (u.protocol !== "https:" || u.username || u.password)
          throw new Error("Invalid provider URL");
      }
      if (
        (!result.payURL && !result.qrCode) ||
        (result.qrCode?.length ?? 0) > 8192
      )
        throw new Error("Invalid payment result");
      await this.pool.query(
        "UPDATE payment_orders SET status=CASE WHEN status='creating' THEN 'pending' ELSE status END,pay_url=$2,qr_code=$3 WHERE id=$1",
        [r.id, result.payURL, result.qrCode],
      );
    } catch {
      await this.pool.query(
        "UPDATE payment_orders SET status='uncertain' WHERE id=$1 AND status='creating'",
        [r.id],
      );
    }
    return orderView(
      (
        await this.pool.query("SELECT * FROM payment_orders WHERE id=$1", [
          r.id,
        ])
      ).rows[0],
    );
  }
  async read(actor: string, org: string, id: string) {
    return this.tx(async (db) => {
      await this.enterprise(db, actor, org);
      const row = (
        await db.query(
          "SELECT * FROM payment_orders WHERE id=$1 AND organization_id=$2",
          [uuid(id), org],
        )
      ).rows[0];
      if (!row)
        throw new HttpError(404, "ORDER_NOT_FOUND", "当前企业订单不存在");
      return orderView(row);
    });
  }
  /** All callback and query evidence reaches the same atomic settlement transaction. */
  async settle(
    providerId: string,
    e: PaymentEvidence,
    source: "callback" | "query",
  ) {
    if (!e.paid) return;
    if (
      !e.transactionId ||
      e.transactionId.length > 200 ||
      !e.outTradeNo ||
      !Number.isSafeInteger(e.amountFen) ||
      e.amountFen < 1 ||
      e.currency !== "CNY"
    )
      throw new HttpError(400, "PAYMENT_EVENT_INVALID", "支付证据无效");
    return this.tx(async (db) => {
      const hint = (
        await db.query(
          "SELECT organization_id FROM payment_orders WHERE out_trade_no=$1 AND provider_id=$2",
          [e.outTradeNo, providerId],
        )
      ).rows[0];
      if (!hint) throw new HttpError(404, "ORDER_NOT_FOUND", "支付订单不存在");
      const o = (
        await db.query(
          "SELECT * FROM organizations WHERE id=$1 FOR NO KEY UPDATE",
          [hint.organization_id],
        )
      ).rows[0];
      const r = (
        await db.query(
          "SELECT * FROM payment_orders WHERE out_trade_no=$1 AND provider_id=$2 FOR UPDATE",
          [e.outTradeNo, providerId],
        )
      ).rows[0];
      if (
        r.amount_fen !== e.amountFen ||
        r.currency !== e.currency ||
        (r.transaction_id && r.transaction_id !== e.transactionId)
      )
        throw new HttpError(
          409,
          "PAYMENT_EVENT_MISMATCH",
          "支付金额、币种或交易号不匹配",
        );
      if (r.paid_at) return orderView(r);
      const eventKey = providerId + ":paid:" + e.transactionId;
      await db.query(
        "INSERT INTO payment_events(order_id,event_key,source,metadata) VALUES($1,$2,$3,$4)",
        [r.id, eventKey, source, e],
      );
      const plan = (
        await db.query("SELECT * FROM subscription_plan_versions WHERE id=$1", [
          r.plan_version_id,
        ])
      ).rows[0];
      let review: string | null = null;
      if (
        !["creating", "pending", "uncertain"].includes(r.status) ||
        new Date(r.expires_at).getTime() <= Date.now()
      )
        review = "迟到付款或订单已关闭，请核对后退款";
      else if (o.status !== "active" || o.service_status === "suspended")
        review = "企业已归档或被暂停";
      else if (o.entitlement_version !== r.expected_version)
        review = "企业权益已变更，请核对后退款";
      else if (o.seat_usage > plan.seat_limit || o.job_usage > plan.job_limit)
        review = "套餐容量低于当前使用量";
      if (!review) {
        const before = {
          planVersionId: o.plan_version_id,
          serviceStatus: o.service_status,
          trialEndsAt: o.trial_ends_at,
          expiresAt: o.paid_subscription_expires_at,
          activeOrderId: o.active_payment_order_id,
        };
        // Same-plan renewal extends from the current expiry; a plan switch starts today.
        const start =
          o.plan_version_id === r.plan_version_id &&
          o.paid_subscription_expires_at
            ? Math.max(
                Date.now(),
                new Date(o.paid_subscription_expires_at).getTime(),
              )
            : Date.now();
        const expires = r.duration_months == null
          ? new Date(start + r.duration_days * 86400000)
          : (await db.query(
              "SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai') + make_interval(months => $2::integer)) AT TIME ZONE 'Asia/Shanghai' AS expires",
              [new Date(start), r.duration_months],
            )).rows[0].expires;
        await db.query(
          "UPDATE organizations SET plan_version_id=$2,paid_subscription_expires_at=$3,entitlement_version=entitlement_version+1,service_status='enabled',trial_ends_at=NULL,service_version=service_version+1,active_payment_order_id=$4 WHERE id=$1",
          [o.id, r.plan_version_id, expires, r.id],
        );
        await db.query(
          "UPDATE payment_orders SET before_entitlements=$2,after_version=$3,fulfilled_at=now() WHERE id=$1",
          [r.id, before, o.entitlement_version + 1],
        );
      }
      const row = (
        await db.query(
          "UPDATE payment_orders SET status=$2,transaction_id=$3,paid_at=now(),review_reason=$4 WHERE id=$1 RETURNING *",
          [r.id, review ? "review" : "fulfilled", e.transactionId, review],
        )
      ).rows[0];
      await this.audit(
        db,
        null,
        o.id,
        review ? "payment.order.review" : "payment.order.fulfilled",
        { orderId: r.id, source, review },
      );
      return orderView(row);
    });
  }
  async webhook(
    providerId: string,
    raw: string,
    headers: Record<string, string>,
  ) {
    const { api, row } = await this.provider(providerId);
    const evidence = await api.notification(raw, headers);
    if (evidence?.paid) await this.settle(providerId, evidence, "callback");
    return row.kind as PaymentKind;
  }
  async verify(actor: string, org: string, id: string) {
    await this.read(actor, org, id);
    await this.reconcileOne(id);
    return this.read(actor, org, id);
  }
  private async reconcileOne(id: string) {
    const r = (
      await this.pool.query("SELECT * FROM payment_orders WHERE id=$1", [
        uuid(id),
      ])
    ).rows[0];
    if (!r || ["fulfilled", "refunded"].includes(r.status)) return;
    // Cross-instance claim also rate-limits customer polling and stale create recovery.
    const claim = await this.pool.query(
      "UPDATE payment_orders SET last_checked_at=now() WHERE id=$1 AND (last_checked_at IS NULL OR last_checked_at<now()-interval '15 seconds') AND (status<>'creating' OR created_at<now()-interval '30 seconds') RETURNING id",
      [id],
    );
    if (!claim.rowCount) return;
    const { api } = await this.provider(r.provider_id);
    if (r.status === "refund_pending") {
      if (await api.queryRefund(r.out_trade_no, r.refund_id, r.amount_fen))
        await this.finishRefund(r.id);
      return;
    }
    const e = await api.query(r.out_trade_no);
    if (e?.outTradeNo !== r.out_trade_no)
      throw new HttpError(409, "PAYMENT_EVENT_MISMATCH", "查单订单号不一致");
    if (e?.paid) {
      await this.settle(r.provider_id, e, "query");
      return;
    }
    if (
      new Date(r.expires_at).getTime() <= Date.now() &&
      ["creating", "pending", "uncertain"].includes(r.status)
    ) {
      await api.close(r.out_trade_no);
      await this.pool.query(
        "UPDATE payment_orders SET status='expired' WHERE id=$1 AND paid_at IS NULL AND status IN ('creating','pending','uncertain')",
        [id],
      );
    }
  }
  async cancel(actor: string, org: string, id: string) {
    await this.read(actor, org, id);
    const r = (
      await this.pool.query("SELECT * FROM payment_orders WHERE id=$1", [id])
    ).rows[0];
    if (r.status === "cancelled" || r.status === "expired") return orderView(r);
    if (!["pending", "uncertain"].includes(r.status))
      throw new HttpError(409, "ORDER_NOT_CANCELLABLE", "当前订单不可取消");
    const { api } = await this.provider(r.provider_id),
      e = await api.query(r.out_trade_no);
    if (e?.outTradeNo !== r.out_trade_no)
      throw new HttpError(409, "PAYMENT_EVENT_MISMATCH", "查单订单号不一致");
    if (e?.paid) {
      await this.settle(r.provider_id, e, "query");
      return this.read(actor, org, id);
    }
    await api.close(r.out_trade_no);
    return this.tx(async (db) => {
      await this.enterprise(db, actor, org);
      await db.query(
        "UPDATE payment_orders SET status='cancelled' WHERE id=$1 AND organization_id=$2 AND paid_at IS NULL AND status IN ('pending','uncertain')",
        [id, org],
      );
      const row = (
        await db.query("SELECT * FROM payment_orders WHERE id=$1", [id])
      ).rows[0];
      await this.audit(db, actor, org, "payment.order.cancel", { orderId: id });
      return orderView(row);
    });
  }
  async refund(actor: string, id: string, reasonValue: unknown) {
    uuid(id);
    const reason = note(reasonValue);
    const r = await this.tx(async (db) => {
      await this.access.requireAccess(actor, true, db, true);
      const hint = (
        await db.query(
          "SELECT organization_id FROM payment_orders WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!hint) throw new HttpError(404, "ORDER_NOT_FOUND", "订单不存在");
      await db.query(
        "SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE",
        [hint.organization_id],
      );
      const order = (
        await db.query("SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (order.status === "refunded") return order;
      if (!["fulfilled", "review", "refund_pending"].includes(order.status))
        throw new HttpError(
          409,
          "ORDER_NOT_REFUNDABLE",
          "只有已付款订单可以退款",
        );
      if (order.status === "refund_pending")
        throw new HttpError(
          409,
          "REFUND_PENDING",
          "退款处理中，请查单核对，勿重复发起",
        );
      const r = (
        await db.query(
          "UPDATE payment_orders SET status='refund_pending',refund_id=$2,refund_reason=$3,refund_actor_id=$4,last_checked_at=now() WHERE id=$1 RETURNING *",
          [id, "rf_" + randomBytesId(), reason, actor],
        )
      ).rows[0];
      await this.audit(db, actor, r.organization_id, "payment.refund.request", {
        orderId: id,
        reason,
      });
      return r;
    });
    if (r.status === "refunded") return orderView(r);
    try {
      const { api } = await this.provider(r.provider_id);
      if (
        await api.refund(
          r.out_trade_no,
          r.refund_id,
          r.amount_fen,
          r.refund_reason,
        )
      )
        await this.finishRefund(id);
    } catch {
      /* Preserve uncertain refund; query the same refund ID, never create a second one. */
    }
    return orderView(
      (await this.pool.query("SELECT * FROM payment_orders WHERE id=$1", [id]))
        .rows[0],
    );
  }
  private async finishRefund(id: string) {
    return this.tx(async (db) => {
      const hint = (
        await db.query(
          "SELECT organization_id FROM payment_orders WHERE id=$1",
          [id],
        )
      ).rows[0];
      const o = (
        await db.query(
          "SELECT * FROM organizations WHERE id=$1 FOR NO KEY UPDATE",
          [hint.organization_id],
        )
      ).rows[0];
      const r = (
        await db.query("SELECT * FROM payment_orders WHERE id=$1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (r.status !== "refund_pending") return;
      let review: string | null = null;
      if (r.fulfilled_at && o.entitlement_version === r.after_version) {
        const b = r.before_entitlements,
          p = (
            await db.query(
              "SELECT * FROM subscription_plan_versions WHERE id=$1",
              [b.planVersionId],
            )
          ).rows[0];
        const previousOrder = b.activeOrderId
          ? (
              await db.query("SELECT status FROM payment_orders WHERE id=$1", [
                b.activeOrderId,
              ])
            ).rows[0]
          : null;
        if (
          (previousOrder &&
            ["refund_pending", "refunded"].includes(previousOrder.status)) ||
          (p.seat_limit !== null && o.seat_usage > p.seat_limit) ||
          (p.job_limit !== null && o.job_usage > p.job_limit)
        ) {
          review =
            "款项已退；原套餐已退款或容量不足，企业服务已暂停，请人工调整权益";
          await db.query(
            "UPDATE organizations SET service_status='suspended',service_version=service_version+1 WHERE id=$1",
            [o.id],
          );
        } else
          await db.query(
            "UPDATE organizations SET plan_version_id=$2,paid_subscription_expires_at=$3,service_status=$4,trial_ends_at=$5,entitlement_version=entitlement_version+1,service_version=service_version+1,active_payment_order_id=$6 WHERE id=$1",
            [
              o.id,
              b.planVersionId,
              b.expiresAt,
              b.serviceStatus,
              b.trialEndsAt,
              b.activeOrderId,
            ],
          );
      } else if (r.fulfilled_at)
        review = "款项已退；企业权益已被其他订单或管理员变更，请人工核对";
      await db.query(
        "UPDATE payment_orders SET status='refunded',refunded_at=now(),review_reason=$2 WHERE id=$1",
        [id, review],
      );
      await db.query(
        "INSERT INTO payment_events(order_id,event_key,source,metadata) VALUES($1,$2,'refund',$3) ON CONFLICT DO NOTHING",
        [id, r.refund_id, { amountFen: r.amount_fen, review }],
      );
      await this.audit(
        db,
        r.refund_actor_id,
        o.id,
        "payment.refund.completed",
        { orderId: id, review },
      );
    });
  }
  async adminVerify(actor: string, id: string) {
    await this.access.requireAccess(actor, true);
    await this.reconcileOne(uuid(id));
    return orderView(
      (await this.pool.query("SELECT * FROM payment_orders WHERE id=$1", [id]))
        .rows[0] ?? {},
    );
  }
  async reconcile() {
    const rows = (
      await this.pool.query(
        "SELECT id FROM payment_orders WHERE status IN ('creating','pending','uncertain','refund_pending','cancelled','expired') AND created_at>now()-interval '7 days' AND (last_checked_at IS NULL OR last_checked_at<now()-interval '1 minute') ORDER BY last_checked_at NULLS FIRST LIMIT 20",
      )
    ).rows;
    for (const r of rows) {
      try {
        await this.reconcileOne(r.id);
      } catch {
        /* Next sweep retries; no paid state is inferred from an error. */
      }
    }
  }
}
function randomBytesId() {
  return randomUUID().replaceAll("-", "");
}
