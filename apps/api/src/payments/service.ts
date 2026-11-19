import { AlipayBills } from "./bills.js";
import { refundCheckDelaySeconds } from './reconciliation-backoff.js';
import { cancellationFailure, cancellationMessage } from "./cancellation.js";
import { PaymentNotCreatedError, creationMessage } from "./creation.js";
import { isSubscriptionRenewal } from './subscription-renewal.js';
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { BillingStore, BILLING_RESOURCES, validateBillingPolicy, validateBillingEntitlements, readExecutionStatus } from '@smartrecruit-pro/enterprise-ai';
import { HttpError } from "../http.js";
import { continuityCsv, readContinuityData, serviceRequestView } from './continuity.js';
import { supportInput, insertSupportMessage, readSupportThread } from './support.js';
import {
  createProvider,
  downloadAlipayBill,
  hasBoundedAlipayPagePay,
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
const alipayHandoff = "(p.method='alipay' AND p.mode IN ('redirect','wap') AND p.pay_url IS NOT NULL AND EXISTS (SELECT 1 FROM payment_providers v WHERE v.id=p.provider_id AND v.kind='alipay'))";
const pendingCondition = `((p.status IN ('creating','pending','uncertain') AND (p.expires_at>clock_timestamp() OR p.cancel_requested_at IS NOT NULL OR ${alipayHandoff})) OR (p.status IN ('cancelled','expired') AND p.channel_close_pending AND ${alipayHandoff}))`;
const pendingOrderSql = `SELECT p.*, (p.expires_at<=clock_timestamp() AND ${alipayHandoff}) AS awaiting_expiry_close FROM payment_orders p WHERE p.organization_id=$1 AND ${pendingCondition} ORDER BY p.created_at,p.id LIMIT 1`;
export const orderView = (r: Row) => ({
  id: r.id,
  outTradeNo: r.out_trade_no,
  organizationId: r.organization_id,
  name: r.product_name,
  description: r.product_description ?? '',
  amountFen: r.amount_fen,
  currency: r.currency,
  durationDays: r.duration_days,
  durationMonths: r.duration_months ?? null,
  allModules: r.all_modules ?? false,
  billingKind: r.billing_kind ?? 'subscription',
  billingEntitlements: r.billing_entitlements ?? {},
  method: r.method,
  mode: r.mode,
  environment: r.environment ?? "production",
  status: r.status,
  creationOutcome: r.creation_outcome ?? "unknown",
  creationMessage: creationMessage(r.creation_outcome, r.creation_error_code),
  channelClosePending: Boolean(r.channel_close_pending || r.awaiting_expiry_close),
  payURL: !r.cancel_requested_at && ['pending', 'uncertain'].includes(r.status) && new Date(r.expires_at).getTime() > Date.now() ? r.pay_url : null,
  qrCode: !r.cancel_requested_at && ['pending', 'uncertain'].includes(r.status) && new Date(r.expires_at).getTime() > Date.now() ? r.qr_code : null,
  cancelRequestedAt: r.cancel_requested_at ?? null,
  cancellationMessage: ((r.cancel_requested_at && ["pending", "uncertain"].includes(r.status)) || r.channel_close_pending)
    ? cancellationMessage(r.cancel_error_code) : null,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  paidAt: r.paid_at,
  refundedAt: r.refunded_at,
  reviewReason: r.review_reason,
});
const productView = (r: Row) => ({
  id: r.id,
  catalogId: r.catalog_id,
  versionNumber: r.version_number,
  versionReason: r.version_reason,
  createdBy: r.created_by,
  sourceVersionId: r.source_version_id,
  planVersionId: r.plan_version_id,
  name: r.name,
  description: r.description ?? '',
  sortOrder: r.sort_order ?? 0,
  amountFen: r.amount_fen,
  currency: r.currency,
  durationDays: r.duration_days,
  durationMonths: r.duration_months ?? null,
  allModules: r.all_modules ?? false,
  billingKind: r.billing_kind ?? 'subscription',
  billingEntitlements: r.billing_entitlements ?? {},
  active: r.active,
  seatLimit: r.seat_limit,
  jobLimit: r.job_limit,
  createdAt: r.created_at,
});
export class PaymentService {
  constructor(
    private readonly pool: Pool,
    private readonly factory: Factory = createProvider,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly billDownload: (url: string) => Promise<Buffer> = downloadAlipayBill,
  ) {}
  private async requireAdmin(actor: string, db: Pool | PoolClient = this.pool, lock = false) {
    const account = this.env.SYSTEM_ADMIN_USER_NO?.trim();
    if (!account || !/^USR-[A-F0-9]{10}$/.test(account))
      throw new HttpError(403, "SYSTEM_ADMIN_REQUIRED", "仅系统管理员可以管理支付");
    const result = await db.query(
      `SELECT id FROM users WHERE id=$1 AND user_no=$2 AND is_active ${lock ? "FOR SHARE" : ""}`,
      [uuid(actor), account],
    );
    if (!result.rows[0])
      throw new HttpError(403, "SYSTEM_ADMIN_REQUIRED", "仅系统管理员可以管理支付");
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
    if (!member)
      throw new HttpError(
        403,
        "WORKSPACE_MEMBER_REQUIRED",
        "仅有效企业成员可查看和操作本企业付款",
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
    await this.requireAdmin(actor);
    const duplicatePendingOrders = (await this.pool.query(`SELECT o.id AS organization_id,o.name AS organization_name,
      jsonb_agg(to_jsonb(p) ORDER BY p.created_at,p.id) AS orders
      FROM payment_orders p JOIN organizations o ON o.id=p.organization_id
      WHERE ${pendingCondition}
      GROUP BY o.id,o.name HAVING count(*)>1 ORDER BY o.id LIMIT 100`)).rows.map(r => ({
        organizationId: r.organization_id, organizationName: r.organization_name, orders: r.orders.map(orderView),
      }));
    const serviceRequests = (await this.pool.query(`SELECT r.*,o.name AS organization_name
      FROM public.enterprise_service_requests r JOIN public.organizations o ON o.id=r.organization_id
      ORDER BY (r.status='open') DESC,r.updated_at DESC LIMIT 100`)).rows.map(serviceRequestView);
    const plans = (await this.pool.query(
      "SELECT id,code,version,name,seat_limit,job_limit FROM subscription_plan_versions WHERE code<>'legacy' ORDER BY code,version DESC",
    )).rows.map((r) => ({
      id: r.id, code: r.code, version: r.version, name: r.name,
      seatLimit: r.seat_limit, jobLimit: r.job_limit,
    }));
    const products = (
      await this.pool.query(
        "SELECT p.*,v.seat_limit,v.job_limit FROM payment_catalog_products c JOIN payment_products p ON p.id=c.current_version_id JOIN subscription_plan_versions v ON v.id=p.plan_version_id WHERE NOT c.archived ORDER BY p.created_at DESC,p.id LIMIT 200",
      )
    ).rows.map(productView);
    const providers = (
      await this.pool.query(
        "SELECT id,name,kind,enabled,environment,created_at FROM payment_providers ORDER BY created_at DESC LIMIT 100",
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
      productVersioning: true,
      duplicatePendingOrders,
      serviceRequests,
      plans,
      products,
      providers,
      orders,
      keyConfigured: !!this.env.PAYMENT_ENCRYPTION_KEY,
      publicBaseURL: this.env.PAYMENT_PUBLIC_BASE_URL ?? null,
    };
  }
  async billingOverview(actor: string) {
    await this.requireAdmin(actor);
    const store = new BillingStore(this.pool);
    return { ...(await store.policy()), tasks: (await this.pool.query("SELECT t.id,t.organization_id AS \"organizationId\",o.name AS \"organizationName\",t.operation,t.resource,t.units::text,t.state,t.policy_version::text AS \"policyVersion\",t.created_at AS \"createdAt\" FROM public.billing_tasks t JOIN public.organizations o ON o.id=t.organization_id WHERE t.state='uncertain' OR (t.state='reserved' AND t.created_at<now()-interval '15 minutes') ORDER BY t.created_at LIMIT 100")).rows, history: (await this.pool.query('SELECT id::text AS version,reason,created_at FROM public.billing_policy_versions ORDER BY id DESC LIMIT 20')).rows };
  }
  async publishBillingPolicy(actor: string, input: Row) {
    if (Object.keys(input).some(k => !['config','expectedVersion','reason'].includes(k))) throw new HttpError(400,'VALIDATION_ERROR','计费配置参数无效');
    const config = validateBillingPolicy(input.config), reason = note(input.reason);
    return this.tx(async db => {
      await this.requireAdmin(actor, db, true);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('platform.billing.policy'))");
      const current = await new BillingStore(this.pool).policy(db);
      if (current.version !== input.expectedVersion) throw new HttpError(409,'VERSION_CONFLICT','规则已被修改，请刷新后再保存');
      const row = (await db.query('INSERT INTO public.billing_policy_versions(config,created_by,reason) VALUES($1,$2,$3) RETURNING id::text AS version,config,created_at AS "createdAt"',[JSON.stringify(config),actor,reason])).rows[0];
      await this.audit(db,actor,null,'billing.policy.publish',{version:row.version,previousVersion:current.version,reason});
      return row;
    });
  }
  async enterpriseBilling(actor: string, org: string) {
    return this.tx(async db => {
      await this.enterprise(db,actor,org);
      const store = new BillingStore(this.pool), policy = await store.policy(db);
      await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR NO KEY UPDATE',[org]);
      await store.ensureTrialGrants(org,db,policy);
      const serviceAvailable = (await db.query('SELECT public.organization_service_available($1) AS available',[org])).rows[0].available;
      return { enabled: policy.config.enabled, serviceAvailable, rules: policy.config.rules,
        execution: await readExecutionStatus(db,org,policy.config.limits.maxConcurrent), ...(await store.balance(org,db)) };
    });
  }
  async grantBillingQuota(actor: string, input: Row) {
    const org = uuid(input.organizationId), key = uuid(input.key), reason = note(input.reason);
    const expires = input.expiresAt === null ? null : typeof input.expiresAt === 'string' ? new Date(input.expiresAt) : new Date(NaN);
    if (Object.keys(input).some(k => !['organizationId','key','resource','units','expiresAt','reason'].includes(k)) || !BILLING_RESOURCES.includes(input.resource) || !Number.isSafeInteger(input.units) || input.units<1 || input.units>1000000000000 || (expires !== null && (!Number.isFinite(expires.getTime()) || expires.getTime()<=Date.now()))) throw new HttpError(400,'VALIDATION_ERROR','请填写有效企业、额度、有效期和原因');
    return this.tx(async db => {
      await this.requireAdmin(actor,db,true);
      if (!(await db.query('SELECT id FROM public.organizations WHERE id=$1 AND status=\'active\' FOR NO KEY UPDATE',[org])).rows[0]) throw new HttpError(404,'NOT_FOUND','企业不存在或已归档');
      const source = 'admin:'+key;
      const existing = (await db.query('SELECT * FROM public.billing_grants WHERE organization_id=$1 AND source_key=$2 AND resource=$3',[org,source,input.resource])).rows[0];
      if (existing) {
        if (Number(existing.total)!==input.units || (existing.expires_at == null ? null : new Date(existing.expires_at).getTime())!==(expires?.getTime() ?? null)) throw new HttpError(409,'BILLING_KEY_CONFLICT','同一发放标识不能用于不同额度');
        return {id:existing.id,replayed:true};
      }
      const row = (await db.query('INSERT INTO public.billing_grants(organization_id,resource,total,remaining,expires_at,source_key) VALUES($1,$2,$3,$3,$4,$5) RETURNING id',[org,input.resource,input.units,expires,source])).rows[0];
      await this.audit(db,actor,org,'billing.quota.grant',{...input,reason,grantId:row.id});
      return {id:row.id,replayed:false};
    });
  }
  async resolveBillingTask(actor: string, id: string, input: Row) {
    uuid(id); const reason=note(input.reason);
    if (Object.keys(input).some(k=>!['state','reason'].includes(k)) || !['settled','released'].includes(input.state)) throw new HttpError(400,'VALIDATION_ERROR','请选择确认扣除或退回额度');
    return this.tx(async db => {
      await this.requireAdmin(actor,db,true);
      const hint=(await db.query('SELECT organization_id FROM public.billing_tasks WHERE id=$1',[id])).rows[0];
      if (!hint) throw new HttpError(404,'NOT_FOUND','计费任务不存在');
      await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR NO KEY UPDATE',[hint.organization_id]);
      const task=(await db.query('SELECT * FROM public.billing_tasks WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (task.state===input.state) return {id,state:input.state,replayed:true};
      if (task.state!=='uncertain' && !(task.state==='reserved' && Date.now()-new Date(task.created_at).getTime()>15*60*1000)) throw new HttpError(409,'BILLING_SETTLEMENT_CONFLICT','仅结果不确定或超过15分钟未结束的任务可以人工核对');
      if (input.state==='released') for (const a of task.allocations) await db.query('UPDATE public.billing_grants SET remaining=remaining+$2 WHERE id=$1',[a.id,a.units]);
      await db.query('UPDATE public.billing_tasks SET state=$2,finished_at=now() WHERE id=$1',[id,input.state]);
      await this.audit(db,actor,hint.organization_id,'billing.task.resolve',{id,state:input.state,reason});
      return {id,state:input.state};
    });
  }
  private async conversionPreview(db: PoolClient, id: string) {
    const order = (await db.query('SELECT id,status,billing_kind,environment FROM public.payment_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if (!order) throw new HttpError(404,'ORDER_NOT_FOUND','订单不存在');
    const rows = (await db.query(`SELECT g.id,g.resource,g.total::text,g.remaining::text,g.expires_at,
      EXISTS(SELECT 1 FROM public.billing_tasks t CROSS JOIN LATERAL jsonb_array_elements(t.allocations) a
        WHERE t.organization_id=g.organization_id AND t.state IN ('reserved','uncertain') AND a->>'id'=g.id::text) AS held,
      g.revoked_at,g.valid_from>now() AS future,g.expires_at<=now() AS expired,
      EXISTS(SELECT 1 FROM public.billing_grant_conversions c WHERE c.grant_id=g.id) AS converted
      FROM public.billing_grants g WHERE g.order_id=$1 ORDER BY g.id FOR UPDATE`,[id])).rows;
    const grants = rows.map(g=>({...g,blockedReason: order.billing_kind!=='addon' ? '不是付费增购订单'
      : order.status!=='fulfilled' || order.environment!=='production' ? '订单未正常到账、退款中或非正式付款'
      : g.converted ? '已完成转换' : g.revoked_at ? '额度已冻结或核销' : !g.expires_at ? '已是长期额度'
      : g.expired ? '额度已过期，需单独核对' : g.future ? '尚未到账' : Number(g.remaining)<=0 ? '没有剩余额度'
      : g.held ? '存在预占或结果待核对的任务' : null}));
    return {orderId:id,digest:digest({order,grants}),grants};
  }
  async previewCreditConversion(actor: string, id: string) {
    uuid(id);
    return this.tx(async db=>{
      await this.requireAdmin(actor,db,true);
      const hint=(await db.query('SELECT organization_id FROM public.payment_orders WHERE id=$1',[id])).rows[0];
      if (!hint) throw new HttpError(404,'ORDER_NOT_FOUND','订单不存在');
      await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR NO KEY UPDATE',[hint.organization_id]);
      return this.conversionPreview(db,id);
    });
  }
  async convertCredits(actor: string, input: Row) {
    const id=uuid(input.orderId),reason=note(input.reason);
    if (Object.keys(input).some(k=>!['orderId','expectedDigest','reason'].includes(k)) || typeof input.expectedDigest!=='string') throw new HttpError(400,'VALIDATION_ERROR','请先预览转换结果');
    return this.tx(async db=>{
      await this.requireAdmin(actor,db,true);
      const hint=(await db.query('SELECT organization_id FROM public.payment_orders WHERE id=$1',[id])).rows[0];
      if (!hint) throw new HttpError(404,'ORDER_NOT_FOUND','订单不存在');
      await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR NO KEY UPDATE',[hint.organization_id]);
      const preview=await this.conversionPreview(db,id);
      if (preview.digest!==input.expectedDigest) throw new HttpError(409,'VERSION_CONFLICT','余额或订单状态已变化，请重新预览');
      const eligible=preview.grants.filter(g=>!g.blockedReason);
      if (!eligible.length) throw new HttpError(409,'NO_CONVERTIBLE_CREDITS','没有可安全转换的剩余额度');
      for (const g of eligible) {
        await db.query('INSERT INTO public.billing_grant_conversions(grant_id,order_id,previous_expires_at,remaining_at_conversion,converted_by,reason) VALUES($1,$2,$3,$4,$5,$6)',[g.id,id,g.expires_at,g.remaining,actor,reason]);
        await db.query('UPDATE public.billing_grants SET expires_at=NULL WHERE id=$1',[g.id]);
      }
      await this.audit(db,actor,hint.organization_id,'billing.credits.convert',{orderId:id,grants:eligible.map(g=>({id:g.id,remaining:g.remaining,previousExpiresAt:g.expires_at})),reason});
      return {converted:eligible.length};
    });
  }
  async publishProduct(actor: string, input: Row, editingId?: string) {
    if (editingId) { uuid(editingId); uuid(input.expectedVersionId); }
    if (input.requestId !== undefined) uuid(input.requestId);
    const permanent = input.billingKind === 'addon' && input.durationDays == null && input.durationMonths == null;
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
            "seatLimit",
            "jobLimit",
            "billingKind",
            "billingEntitlements",
            "name",
            "description",
            "sortOrder",
            "amountFen",
            "durationDays",
            "durationMonths",
            "allModules",
            "reason",
            "expectedVersionId",
            "requestId",
          ].includes(k),
      ) ||
      typeof input.name !== "string" ||
      input.name.trim().length < 2 ||
      input.name.trim().length > 80 ||
      !Number.isSafeInteger(input.amountFen) ||
      input.amountFen < 1 ||
      input.amountFen > 100000000 ||
      (!dayBased && !monthBased && !permanent) ||
      (input.description !== undefined && (typeof input.description !== 'string' || input.description.length>500)) ||
      (input.sortOrder !== undefined && (!Number.isSafeInteger(input.sortOrder) || input.sortOrder<0 || input.sortOrder>1000000)) ||
      (input.allModules !== undefined && typeof input.allModules !== "boolean")
    )
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "请填写有效商品名称和售价；订阅需指定期限，增购包可选择长期有效",
      );
    const custom = input.planVersionId == null;
    const addon = input.billingKind === 'addon';
    if ((input.billingKind !== undefined && !['subscription','addon'].includes(input.billingKind)) ||
      (custom && !addon && (![input.seatLimit,input.jobLimit].every(v => Number.isSafeInteger(v) && v>=1 && v<=1000000))) ||
      (!custom && (input.seatLimit!==undefined || input.jobLimit!==undefined))) throw new HttpError(400,'VALIDATION_ERROR','请填写有效席位数、岗位数和商品类型');
    const entitlements: { quotas: Record<string, number>; grantPeriod: 'once' | 'monthly'; rollover: boolean } | Record<string, never> = input.billingEntitlements === undefined ? {} : validateBillingEntitlements(input.billingEntitlements) as { quotas: Record<string, number>; grantPeriod: 'once' | 'monthly'; rollover: boolean };
    if (addon && (!('quotas' in entitlements) || !Object.values(entitlements.quotas).some(v => Number(v)>0) || entitlements.grantPeriod!=='once' || entitlements.rollover || input.seatLimit!==undefined || input.jobLimit!==undefined || input.allModules===true)) throw new HttpError(400,'VALIDATION_ERROR','增购包只包含一次到账的额度，不设置席位、岗位、模块或按月结转');
    const reason = note(input.reason);
    return this.tx(async (db) => {
      await this.requireAdmin(actor, db, true);
      const fingerprint = digest({editingId: editingId ?? null, input});
      if (input.requestId) {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor+':'+input.requestId]);
        const replay=(await db.query('SELECT * FROM payment_product_operations WHERE actor_id=$1 AND request_id=$2',[actor,input.requestId])).rows[0];
        if (replay) {
          if (replay.fingerprint!==fingerprint) throw new HttpError(409,'IDEMPOTENCY_CONFLICT','同一提交标识不能用于不同商品内容');
          return productView((await db.query('SELECT p.*,v.seat_limit,v.job_limit FROM payment_products p JOIN subscription_plan_versions v ON v.id=p.plan_version_id WHERE p.id=$1',[replay.product_id])).rows[0]);
        }
      }
      let current: Row | undefined;
      if (editingId) {
        current=(await db.query('SELECT p.*,c.archived,c.current_version_id FROM payment_products p JOIN payment_catalog_products c ON c.id=p.catalog_id WHERE p.id=$1 FOR UPDATE OF c',[editingId])).rows[0];
        if (!current) throw new HttpError(404,'NOT_FOUND','商品不存在');
        if (current.archived || current.current_version_id!==editingId || editingId!==input.expectedVersionId) throw new HttpError(409,'VERSION_CONFLICT','商品已有新版本或已归并，请刷新后重新编辑');
        if (current.billing_kind!==(addon?'addon':'subscription')) throw new HttpError(400,'PRODUCT_KIND_MISMATCH','编辑不能更改商品类型，请复制为新商品');
        await db.query('UPDATE payment_products SET active=false WHERE catalog_id=$1 AND active',[current.catalog_id]);
      } else if (input.expectedVersionId !== undefined) throw new HttpError(400,'VALIDATION_ERROR','新建商品不能指定待替换版本');
      let plan: string;
      if (addon) plan = (await db.query("SELECT id FROM subscription_plan_versions WHERE code='legacy' ORDER BY version DESC LIMIT 1")).rows[0].id;
      else if (custom) {
        plan = (await db.query('INSERT INTO subscription_plan_versions(code,version,name,seat_limit,job_limit) VALUES($1,1,$2,$3,$4) RETURNING id', ['p_'+randomUUID().replaceAll('-',''),input.name.trim(),input.seatLimit,input.jobLimit])).rows[0].id;
      } else plan=uuid(input.planVersionId);
      const p = (
        await db.query("SELECT * FROM subscription_plan_versions WHERE id=$1", [
          plan,
        ])
      ).rows[0];
      if (
        !p ||
        (!addon && (p.code === "legacy" || p.seat_limit === null || p.job_limit === null))
      )
        throw new HttpError(400, "PLAN_INVALID", "请选择明确容量的已发布套餐");
      const r = (
        await db.query(
          "INSERT INTO payment_products(plan_version_id,name,amount_fen,duration_days,created_by,duration_months,all_modules,billing_kind,billing_entitlements,description,sort_order,catalog_id,version_number,version_reason,source_version_id,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *",
          [plan, input.name.trim(), input.amountFen, input.durationDays ?? null, actor, input.durationMonths ?? null, addon ? false : input.allModules ?? false, addon ? 'addon' : 'subscription',JSON.stringify(entitlements),input.description?.trim() ?? '',input.sortOrder ?? 0,current?.catalog_id ?? null,current ? current.version_number+1 : 1,reason,current?.id ?? null,!!current],
        )
      ).rows[0];
      if (current) await db.query('UPDATE payment_catalog_products SET current_version_id=$2 WHERE id=$1',[current.catalog_id,r.id]);
      if (input.requestId) await db.query('INSERT INTO payment_product_operations(actor_id,request_id,fingerprint,product_id) VALUES($1,$2,$3,$4)',[actor,input.requestId,fingerprint,r.id]);
      await this.audit(db, actor, null, "payment.product.publish", {
        productId: r.id,
        catalogId: r.catalog_id,
        previousVersionId: current?.id ?? null,
        versionNumber: r.version_number,
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
  async productHistory(actor: string, id: string) {
    uuid(id);
    await this.requireAdmin(actor);
    return this.tx(async db => {
      const row=(await db.query('SELECT c.* FROM payment_catalog_products c JOIN payment_products p ON p.catalog_id=c.id WHERE p.id=$1 FOR SHARE OF c',[id])).rows[0];
      if (!row) throw new HttpError(404,'NOT_FOUND','商品不存在');
      const versions=(await db.query('SELECT p.*,v.seat_limit,v.job_limit,u.display_name AS operator_name FROM payment_products p JOIN subscription_plan_versions v ON v.id=p.plan_version_id LEFT JOIN users u ON u.id=p.created_by WHERE p.catalog_id=$1 ORDER BY p.version_number DESC',[row.id])).rows;
      return {catalogId:row.id,currentVersionId:row.current_version_id,versions:versions.map(v=>({...productView(v),operatorName:v.operator_name ?? '历史记录'}))};
    });
  }
  async mergeProducts(actor: string, input: Row) {
    const reason=note(input.reason);
    if (!Array.isArray(input.versionIds) || input.versionIds.length<2 || input.versionIds.length>20 || new Set(input.versionIds).size!==input.versionIds.length) throw new HttpError(400,'VALIDATION_ERROR','请选择 2 至 20 个独立商品进行归并');
    const ids=input.versionIds.map((id:unknown)=>uuid(id));
    const keep=uuid(input.keepVersionId), requestId=uuid(input.requestId);
    if (!ids.includes(keep)) throw new HttpError(400,'VALIDATION_ERROR','请明确选择归并后保留的当前版本');
    if (typeof input.active!=='boolean') throw new HttpError(400,'VALIDATION_ERROR','请明确指定归并后的销售状态');
    const fingerprint=digest({merge:input});
    return this.tx(async db=>{
      await this.requireAdmin(actor,db,true);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor+':'+requestId]);
      const replay=(await db.query('SELECT * FROM payment_product_operations WHERE actor_id=$1 AND request_id=$2',[actor,requestId])).rows[0];
      if (replay) {
        if (replay.fingerprint!==fingerprint) throw new HttpError(409,'IDEMPOTENCY_CONFLICT','同一提交标识不能用于不同归并内容');
        return productView((await db.query('SELECT p.*,v.seat_limit,v.job_limit FROM payment_products p JOIN subscription_plan_versions v ON v.id=p.plan_version_id WHERE p.id=$1',[replay.product_id])).rows[0]);
      }
      const catalogs=(await db.query('SELECT c.* FROM payment_catalog_products c WHERE c.id IN (SELECT catalog_id FROM payment_products WHERE id=ANY($1::uuid[])) ORDER BY c.id FOR UPDATE',[ids])).rows;
      if (catalogs.length!==ids.length || catalogs.some(c=>c.archived || !ids.includes(c.current_version_id))) throw new HttpError(409,'VERSION_CONFLICT','所选商品已经更新或归并，请刷新后重新选择');
      const versions=(await db.query('SELECT p.* FROM payment_products p WHERE catalog_id=ANY($1::uuid[]) ORDER BY created_at,id FOR UPDATE',[catalogs.map(c=>c.id)])).rows;
      if (new Set(versions.map(p=>p.billing_kind)).size!==1) throw new HttpError(400,'PRODUCT_KIND_MISMATCH','订阅套餐和算力增购包不能归并');
      const target=versions.find(p=>p.id===keep)!;
      const ordered=[...versions.filter(p=>p.id!==keep),target];
      await db.query('UPDATE payment_products SET active=false WHERE catalog_id=ANY($1::uuid[]) AND active',[catalogs.map(c=>c.id)]);
      for (let i=0;i<ordered.length;i++) await db.query('UPDATE payment_products SET catalog_id=$2,version_number=$3 WHERE id=$1',[ordered[i]!.id,target.catalog_id,i+1]);
      await db.query('UPDATE payment_catalog_products SET archived=true,current_version_id=NULL WHERE id=ANY($1::uuid[]) AND id<>$2',[catalogs.map(c=>c.id),target.catalog_id]);
      await db.query('UPDATE payment_products SET active=$2 WHERE id=$1',[keep,input.active]);
      await db.query('INSERT INTO payment_product_operations(actor_id,request_id,fingerprint,product_id) VALUES($1,$2,$3,$4)',[actor,requestId,fingerprint,keep]);
      await this.audit(db,actor,null,'payment.product.merge',{catalogId:target.catalog_id,previousCatalogs:catalogs,versions:versions.map(p=>({id:p.id,catalogId:p.catalog_id,versionNumber:p.version_number,active:p.active})),keepVersionId:keep,active:input.active,reason});
      return productView((await db.query('SELECT p.*,v.seat_limit,v.job_limit FROM payment_products p JOIN subscription_plan_versions v ON v.id=p.plan_version_id WHERE p.id=$1',[keep])).rows[0]);
    });
  }
  async toggleProduct(actor: string, id: string, input: Row) {
    uuid(id);
    const reason = note(input.reason);
    if (typeof input.active !== "boolean")
      throw new HttpError(400, "VALIDATION_ERROR", "上下架状态无效");
    return this.tx(async (db) => {
      await this.requireAdmin(actor, db, true);
      const current=(await db.query('SELECT c.* FROM payment_catalog_products c JOIN payment_products p ON p.catalog_id=c.id WHERE p.id=$1 FOR UPDATE OF c',[id])).rows[0];
      if (!current) throw new HttpError(404,'NOT_FOUND','商品不存在');
      if (current.archived || current.current_version_id!==id) throw new HttpError(409,'VERSION_CONFLICT','历史版本不能直接上下架，请以此版本恢复并发布新版本');
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
      await this.requireAdmin(actor, db, true);
      const r = (
        await db.query(
          "INSERT INTO payment_providers(id,name,kind,config_ciphertext,created_by,environment) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,kind,enabled,environment",
          [id, input.name.trim(), input.kind, encrypted, actor, cfg.environment ?? "production"],
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
      await this.requireAdmin(actor, db, true);
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
      const currentSubscription = await this.currentSubscription(db, o);
      const products = (
        await db.query(
          "SELECT p.*,v.seat_limit,v.job_limit FROM payment_products p JOIN subscription_plan_versions v ON v.id=p.plan_version_id WHERE p.active ORDER BY p.sort_order,p.amount_fen,p.created_at,p.id",
        )
      ).rows.map(r => ({ ...productView(r), subscriptionRenewal: isSubscriptionRenewal(currentSubscription, r, o.plan_version_id) }));
      const providers = (
        await db.query(
          "SELECT id,name,kind,environment FROM payment_providers WHERE enabled ORDER BY created_at,id",
        )
      ).rows;
      const orders = (
        await db.query(
          "SELECT * FROM payment_orders WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50",
          [org],
        )
      ).rows.map(orderView);
      const pending = (await db.query(pendingOrderSql, [org])).rows[0];
      const plan = (await db.query('SELECT name,seat_limit,job_limit FROM subscription_plan_versions WHERE id=$1',[o.plan_version_id])).rows[0];
      const serviceAvailable = (await db.query('SELECT public.organization_service_available($1) AS available',[org])).rows[0].available;
      const store = new BillingStore(this.pool), policy = await store.policy(db);
      await store.ensureTrialGrants(org,db,policy);
      return {
        billing: { enabled: policy.config.enabled, serviceAvailable, rules: policy.config.rules, ...(await store.balance(org,db)) },
        products,
        providers,
        orders,
        pendingOrder: pending ? orderView(pending) : null,
        organization: {
          id: org,
          name: o.name,
          entitlementVersion: o.entitlement_version,
          expiresAt: o.paid_subscription_expires_at,
          seatUsage: o.seat_usage,
          jobUsage: o.job_usage,
          planVersionId: o.plan_version_id,
          planName: plan?.name,
          seatLimit: plan?.seat_limit,
          jobLimit: plan?.job_limit,
          serviceAvailable,
          serviceStatus: o.service_status,
          trialEndsAt: o.trial_ends_at,
        },
        canPurchase: o.service_status !== "suspended",
      };
    });
  }
  private async currentSubscription(db: PoolClient, organization: Row): Promise<Row | undefined> {
    if (!organization.active_payment_order_id) return undefined;
    return (await db.query(
      "SELECT a.*,p.catalog_id,v.seat_limit,v.job_limit FROM payment_orders a JOIN payment_products p ON p.id=a.product_id JOIN subscription_plan_versions v ON v.id=a.plan_version_id WHERE a.id=$1 AND a.organization_id=$2 AND a.plan_version_id=$3 AND a.status='fulfilled'",
      [organization.active_payment_order_id, organization.id, organization.plan_version_id])).rows[0];
  }
  async continuity(actor: string, org: string) {
    return this.tx(async db => {
      const organization = await this.enterprise(db, actor, org);
      const requests = (await db.query('SELECT * FROM public.enterprise_service_requests WHERE organization_id=$1 ORDER BY updated_at DESC,id LIMIT 20', [org])).rows.map(serviceRequestView);
      const dataRestricted = organization.service_status === 'suspended';
      let data = null, dataUnavailable = false;
      if (!dataRestricted) {
        try { data = await readContinuityData(db, org, 100, this.env); }
        catch (error) {
          if (!(error instanceof HttpError) || error.code !== 'WORKSPACE_SCHEMA_UNAVAILABLE') throw error;
          dataUnavailable = true;
        }
      }
      return { dataRestricted, dataUnavailable, data, requests };
    });
  }
  async exportContinuity(actor: string, org: string) {
    return this.tx(async db => {
      const organization = await this.enterprise(db, actor, org);
      if (organization.service_status === 'suspended')
        throw new HttpError(403, 'WORKSPACE_SERVICE_SUSPENDED', '企业服务已暂停，请联系系统管理员');
      const data = await readContinuityData(db, org, 1000, this.env);
      await this.audit(db, actor, org, 'enterprise.data.export', { scope: 'job-summary', rows: data.jobs.length, truncated: data.truncated });
      return { filename: `enterprise-jobs-${org}.csv`, csv: continuityCsv(data.jobs), rows: data.jobs.length, truncated: data.truncated, limit: 1000 };
    });
  }
  async contactAdministrator(actor: string, org: string, input: Row) {
    const content = supportInput(input);
    return this.tx(async db => {
      await this.enterprise(db, actor, org);
      const existing = (await db.query("SELECT * FROM public.enterprise_service_requests WHERE organization_id=$1 AND status='open'", [org])).rows[0];
      if (existing) return { request: serviceRequestView(existing), existing: true };
      const row = (await db.query('INSERT INTO public.enterprise_service_requests(organization_id,created_by,message) VALUES($1,$2,$3) RETURNING *', [org, actor, content.message])).rows[0];
      await insertSupportMessage(db, row.id, actor, 'member', content);
      await this.audit(db, actor, org, 'enterprise.service.request', { requestId: row.id, attachments: content.attachments.length });
      return { request: serviceRequestView(row), existing: false };
    });
  }
  private async supportAccess(db: PoolClient, actor: string, id: string, org?: string) {
    uuid(id);
    const hint = (await db.query('SELECT organization_id FROM public.enterprise_service_requests WHERE id=$1', [id])).rows[0];
    if (org) {
      await this.enterprise(db, actor, org);
      if (!hint || hint.organization_id !== org) throw new HttpError(404, 'SERVICE_REQUEST_NOT_FOUND', '工单不存在');
    } else {
      await this.requireAdmin(actor, db, true);
      if (!hint) throw new HttpError(404, 'SERVICE_REQUEST_NOT_FOUND', '工单不存在');
      await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR NO KEY UPDATE', [hint.organization_id]);
    }
    return (await db.query('SELECT * FROM public.enterprise_service_requests WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }
  async serviceThread(actor: string, id: string, org?: string, before?: string) {
    if (before) uuid(before);
    return this.tx(async db => readSupportThread(db, await this.supportAccess(db, actor, id, org), before));
  }
  async replyServiceRequest(actor: string, id: string, input: Row, org?: string) {
    const content = supportInput(input);
    if (input.resolve !== undefined && typeof input.resolve !== 'boolean') throw new HttpError(400, 'VALIDATION_ERROR', '完成状态无效');
    if (org && input.resolve === true) throw new HttpError(403, 'SYSTEM_ADMIN_REQUIRED', '仅系统管理员可以完成工单');
    return this.tx(async db => {
      const request = await this.supportAccess(db, actor, id, org);
      if (request.status === 'resolved') {
        const other = (await db.query("SELECT id FROM public.enterprise_service_requests WHERE organization_id=$1 AND status='open' AND id<>$2", [request.organization_id,id])).rows[0];
        if (other) throw new HttpError(409, 'SERVICE_REQUEST_ALREADY_OPEN', '企业已有另一张待处理工单，请在该工单继续沟通');
      }
      await insertSupportMessage(db, id, actor, org ? 'member' : 'administrator', content);
      const resolve = !org && input.resolve === true;
      const row = (await db.query(
        "UPDATE public.enterprise_service_requests SET status=$2,response=$3,resolved_by=$4,resolved_at=CASE WHEN $2='resolved' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
        [id,resolve ? 'resolved' : 'open',resolve ? content.message : null,resolve ? actor : null])).rows[0];
      await this.audit(db, actor, request.organization_id, resolve ? 'enterprise.service.resolve' : 'enterprise.service.reply', {requestId:id,attachments:content.attachments.length});
      return readSupportThread(db,row);
    });
  }
  async serviceAttachment(actor: string, requestId: string, attachmentId: string, org?: string) {
    uuid(attachmentId);
    return this.tx(async db => {
      const request = await this.supportAccess(db, actor, requestId, org);
      const file = (await db.query('SELECT a.* FROM public.enterprise_service_attachments a JOIN public.enterprise_service_messages m ON m.id=a.message_id WHERE a.id=$1 AND m.request_id=$2', [attachmentId,requestId])).rows[0];
      if (!file) throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', '附件不存在');
      await this.audit(db, actor, request.organization_id, 'enterprise.service.attachment.download', {requestId,attachmentId});
      return {filename:file.filename,mimeType:file.mime_type,sizeBytes:file.size_bytes,base64:file.content.toString('base64')};
    });
  }
  async resolveServiceRequest(actor: string, id: string, input: Row) {
    // Retain the original endpoint for existing clients; conversations use /messages.
    return this.tx(async db => {
      const request = await this.supportAccess(db, actor, id);
      if (request.status !== 'open') throw new HttpError(409, 'SERVICE_REQUEST_CLOSED', '工单已处理，请刷新或在会话中继续回复');
      const content = supportInput({...input,message:input.response});
      await insertSupportMessage(db,id,actor,'administrator',content);
      const row = (await db.query("UPDATE public.enterprise_service_requests SET status='resolved',response=$2,resolved_by=$3,resolved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [id,content.message,actor])).rows[0];
      await this.audit(db,actor,request.organization_id,'enterprise.service.resolve',{requestId:id,attachments:content.attachments.length});
      return serviceRequestView(row);
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
      !["qrcode", "redirect", "wap"].includes(input.mode) ||
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
      if (input.method === "alipay" && input.mode !== "redirect")
        throw new HttpError(400, "PAYMENT_MODE_MISMATCH", "支付宝新订单仅支持跳转支付，请刷新页面后重试");
      if (input.mode === "wap")
        throw new HttpError(400, "PAYMENT_MODE_MISMATCH", "当前不支持手机网站支付");
      // enterprise() holds the organization lock through allocation, including across actors.
      const pending = (await db.query(pendingOrderSql, [org])).rows[0];
      if (pending)
        throw new HttpError(
          409,
          "PAYMENT_ORDER_ALREADY_PENDING",
          pending.cancel_requested_at || pending.awaiting_expiry_close ? "企业订单关单待确认，请等待渠道结果，勿重复付款" : "企业已有待支付订单，请继续支付或取消后重新购买",
          { orderId: pending.id },
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
      if (product.billing_kind === 'addon' && !(await db.query('SELECT public.organization_service_available($1) AS available',[org])).rows[0].available) throw new HttpError(409,'WORKSPACE_SERVICE_UNAVAILABLE','请先开通或续费企业服务，再购买增购包');
      if (provider.kind !== "easypay" && provider.kind !== input.method)
        throw new HttpError(
          400,
          "PAYMENT_METHOD_MISMATCH",
          "支付方式与渠道不匹配",
        );
      if (
        product.billing_kind !== 'addon' && (orgRow.seat_usage > product.seat_limit ||
        orgRow.job_usage > product.job_limit)
      )
        throw new HttpError(
          409,
          "PLAN_CAPACITY_BELOW_USAGE",
          "套餐容量低于当前使用量",
        );
      const id = randomUUID(),
        no = "sr" + randomBytes(15).toString("hex");
      const row = (
        await db.query(
          "INSERT INTO payment_orders(id,out_trade_no,organization_id,actor_id,product_id,provider_id,method,mode,amount_fen,currency,product_name,plan_version_id,duration_days,expected_version,idempotency_key,fingerprint,duration_months,all_modules,billing_kind,billing_entitlements,environment,product_description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *",
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
            product.billing_kind,
            product.billing_entitlements,
            provider.environment ?? "production",
            product.description ?? '',
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
        "UPDATE payment_orders SET status='pending',pay_url=$2,qr_code=$3,creation_outcome='created',creation_error_code=NULL WHERE id=$1 AND status='creating' AND expires_at>clock_timestamp()",
        [r.id, result.payURL, result.qrCode],
      );
    } catch (error) {
      const code = error instanceof HttpError && [
        "PAYMENT_APPLICATION_NOT_ONLINE",
        "PAYMENT_UPSTREAM_UNCERTAIN",
        "PAYMENT_ENDPOINT_BLOCKED",
        "PAYMENT_DNS_LOOKUP_FAILED",
      ].includes(error.code) ? error.code : "PAYMENT_CREATE_FAILED";
      console.warn("[payments] order creation failed", { orderId: r.id, code });
      await this.pool.query(
        "UPDATE payment_orders SET status='uncertain',creation_outcome=$2,creation_error_code=$3 WHERE id=$1 AND status='creating' AND paid_at IS NULL",
        [r.id, error instanceof PaymentNotCreatedError ? 'not_created' : 'unknown', code],
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
    if(e.paidAt && (!Number.isFinite(Date.parse(e.paidAt)) || Date.parse(e.paidAt)>Date.now()+300000))
      throw new HttpError(400,"PAYMENT_EVENT_INVALID","支付时间无效");
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
          "SELECT p.*,v.kind AS provider_kind FROM payment_orders p JOIN payment_providers v ON v.id=p.provider_id WHERE p.out_trade_no=$1 AND p.provider_id=$2 FOR UPDATE OF p",
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
      // Alipay timestamps have second precision; equal timestamps do not establish ordering.
      const alipayCancellationRace = r.provider_kind === 'alipay' && r.cancel_requested_at &&
        (!e.paidAt || Date.parse(e.paidAt) >= Math.floor(new Date(r.cancel_requested_at).getTime() / 1000) * 1000);
      if (
        alipayCancellationRace || e.closed || !["creating", "pending", "uncertain"].includes(r.status) ||
        new Date(r.expires_at).getTime() <= Date.now()
      )
        review = e.closed ? "支付宝交易已关闭但存在历史付款，请核对退款与企业权益" : "取消或超时期间发现付款，请核对渠道到账及退款状态";
      else if (o.status !== "active" || o.service_status === "suspended")
        review = "企业已归档或被暂停";
      else if (o.entitlement_version !== r.expected_version)
        review = "企业权益已变更，请核对后退款";
      else if (r.billing_kind !== 'addon' && (o.seat_usage > plan.seat_limit || o.job_usage > plan.job_limit))
        review = "套餐容量低于当前使用量";
      if (r.environment === "sandbox") review = "支付宝沙箱测试付款，不发放正式套餐权益";
      if (!review) {
        const before = {
          planVersionId: o.plan_version_id,
          serviceStatus: o.service_status,
          trialEndsAt: o.trial_ends_at,
          expiresAt: o.paid_subscription_expires_at,
          activeOrderId: o.active_payment_order_id,
        };
        const currentSubscription = await this.currentSubscription(db, o);
        const product = (await db.query('SELECT catalog_id FROM payment_products WHERE id=$1', [r.product_id])).rows[0];
        const renewal = isSubscriptionRenewal(currentSubscription, { ...r, ...product, seat_limit: plan.seat_limit, job_limit: plan.job_limit }, o.plan_version_id);
        const start =
          renewal &&
          o.paid_subscription_expires_at
            ? Math.max(
                Date.now(),
                new Date(o.paid_subscription_expires_at).getTime(),
              )
            : Date.now();
        const expires = r.billing_kind === 'addon' && r.duration_months == null && r.duration_days == null ? null : r.duration_months == null
          ? new Date(start + r.duration_days * 86400000)
          : (await db.query(
              "SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai') + make_interval(months => $2::integer)) AT TIME ZONE 'Asia/Shanghai' AS expires",
              [new Date(start), r.duration_months],
            )).rows[0].expires;
        if (r.billing_kind !== 'addon') await db.query(
          "UPDATE organizations SET plan_version_id=$2,paid_subscription_expires_at=$3,entitlement_version=entitlement_version+1,service_status='enabled',trial_ends_at=NULL,service_version=service_version+1,active_payment_order_id=$4 WHERE id=$1",
          [o.id, r.plan_version_id, expires, r.id],
        );
        await db.query(
          "UPDATE payment_orders SET before_entitlements=$2,after_version=$3,fulfilled_at=now() WHERE id=$1",
          [r.id, before, o.entitlement_version + (r.billing_kind === 'addon' ? 0 : 1)],
        );
        await this.grantOrderQuotas(db,r,new Date(start),expires === null ? null : new Date(expires));
      }
      const row = (
        await db.query(
          "UPDATE payment_orders SET status=$2,transaction_id=$3,paid_at=COALESCE($5::timestamptz,now()),review_reason=$4,channel_close_pending=false,cancel_error_code=NULL WHERE id=$1 RETURNING *",
          [r.id, review ? "review" : "fulfilled", e.transactionId, review, e.paidAt ?? null],
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
  private async grantOrderQuotas(db: PoolClient, order: Row, start: Date, expires: Date | null) {
    if (!order.billing_entitlements?.quotas) return;
    const rights=validateBillingEntitlements(order.billing_entitlements);
    for (const resource of BILLING_RESOURCES) {
      const units=rights.quotas[resource];
      if (!units) continue;
      if (expires === null) {
        if (order.billing_kind !== 'addon' || rights.grantPeriod !== 'once') throw new HttpError(409,'BILLING_ENTITLEMENTS_INVALID','长期额度只能用于一次到账的增购包');
        await db.query("INSERT INTO public.billing_grants(organization_id,resource,total,remaining,valid_from,expires_at,order_id,source_key) VALUES($1,$2,$3,$3,$4,NULL,$5::uuid,$5::text||':0') ON CONFLICT DO NOTHING",[order.organization_id,resource,units,start,order.id]);
        continue;
      }
      await db.query(
        "INSERT INTO public.billing_grants(organization_id,resource,total,remaining,valid_from,expires_at,order_id,source_key) SELECT $1,$2,$3,$3,anchor,CASE WHEN $6::boolean THEN $5::timestamptz ELSE least(next_anchor,$5::timestamptz) END,$7::uuid,$7::text||':'||n::text FROM (SELECT n,(($4::timestamptz AT TIME ZONE 'Asia/Shanghai')+make_interval(months=>n)) AT TIME ZONE 'Asia/Shanghai' AS anchor,(($4::timestamptz AT TIME ZONE 'Asia/Shanghai')+make_interval(months=>n+1)) AT TIME ZONE 'Asia/Shanghai' AS next_anchor FROM generate_series(0,$8::integer) n) periods WHERE anchor<$5::timestamptz ON CONFLICT DO NOTHING",
        [order.organization_id,resource,units,start,expires,rights.grantPeriod==='once' || rights.rollover,order.id,rights.grantPeriod==='once'?0:131]);
    }
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
      "UPDATE payment_orders SET last_checked_at=now() WHERE id=$1 AND (last_checked_at IS NULL OR last_checked_at<now()-interval '15 seconds') AND (status<>'creating' OR created_at<now()-interval '30 seconds') AND (status<>'refund_pending' OR refund_next_check_at IS NULL OR refund_next_check_at<=now()) RETURNING id",
      [id],
    );
    if (!claim.rowCount) return;
    if (r.creation_outcome === 'not_created' && !r.paid_at && !r.pay_url && !r.qr_code && ['cancelled','expired'].includes(r.status)) return;
    if (r.cancel_requested_at && (["pending", "uncertain"].includes(r.status) || (r.status === 'cancelled' && r.channel_close_pending))) {
      await this.completeCancellation(r);
      return;
    }
    if (r.creation_outcome === 'not_created' && !r.paid_at && !r.pay_url && !r.qr_code && ['pending','uncertain'].includes(r.status)) {
      await this.pool.query("UPDATE payment_orders SET status='expired' WHERE id=$1 AND status IN ('pending','uncertain') AND paid_at IS NULL AND expires_at<=clock_timestamp()", [id]);
      return;
    }
    if (r.status === "refund_pending") {
      let failure: unknown;
      try {
        const { api } = await this.provider(r.provider_id);
        if (await api.queryRefund(r.out_trade_no,r.refund_id,r.amount_fen)) {
          await this.finishRefund(r.id);
          await this.pool.query('UPDATE payment_orders SET refund_check_error=NULL,refund_next_check_at=NULL WHERE id=$1',[r.id]);
          return;
        }
      } catch (error) { failure=error; }
      await this.pool.query("UPDATE payment_orders SET refund_check_attempts=refund_check_attempts+1,refund_next_check_at=now()+$2*interval '1 second',refund_check_error=$3 WHERE id=$1 AND status='refund_pending'",[r.id,refundCheckDelaySeconds(Number(r.refund_check_attempts ?? 0)+1),failure ? '退款查单失败，已退避等待核对' : '渠道尚未确认退款，持续查单中']);
      if (failure) throw failure;
      return;
    }
    const channel = await this.provider(r.provider_id), { api, row: provider } = channel;
    const queryStartedAt = Date.now(), e = await api.query(r.out_trade_no);
    this.checkCloseEvidence(r, e, provider.kind === 'alipay');
    if (e?.paid) {
      await this.settle(r.provider_id, e, "query");
      return;
    }
    if (provider.kind === 'alipay') {
      if (e?.closed) {
        await this.finishClosure(r, 'closed');
      } else if (['cancelled', 'expired'].includes(r.status) ? e || r.channel_close_pending : new Date(r.expires_at).getTime() <= Date.now()) {
        await this.completeCancellation(r, { channel, evidence: e, queryStartedAt });
      }
      return;
    }
    if (
      new Date(r.expires_at).getTime() <= Date.now() &&
      ["creating", "pending", "uncertain"].includes(r.status)
    ) {
      await api.close(r.out_trade_no);
      await this.pool.query(
        "UPDATE payment_orders SET status='expired' WHERE id=$1 AND paid_at IS NULL AND cancel_requested_at IS NULL AND status IN ('creating','pending','uncertain')",
        [id],
      );
    }
  }
  async cancel(actor: string, org: string, id: string) {
    await this.read(actor, org, id);
    return this.cancelOrder(actor, org, id);
  }
  async adminCancel(actor: string, id: string, reasonValue: unknown) {
    await this.requireAdmin(actor);
    const reason = note(reasonValue);
    const row = (await this.pool.query('SELECT organization_id FROM payment_orders WHERE id=$1', [uuid(id)])).rows[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND', '订单不存在');
    return this.cancelOrder(actor, row.organization_id, id, reason);
  }
  private async cancelOrder(actor: string, org: string, id: string, adminReason?: string) {
    const r = await this.tx(async (db) => {
      if (adminReason) {
        await this.requireAdmin(actor, db, true);
        await db.query('SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE', [org]);
      } else await this.enterprise(db, actor, org);
      const row = (await db.query('SELECT * FROM payment_orders WHERE id=$1 AND organization_id=$2 FOR UPDATE', [id,org])).rows[0];
      if (!row) throw new HttpError(404, 'ORDER_NOT_FOUND', '当前企业订单不存在');
      if (["cancelled", "expired"].includes(row.status)) return row;
      if (!["pending", "uncertain"].includes(row.status) || row.paid_at)
        throw new HttpError(409, "ORDER_NOT_CANCELLABLE", "当前订单不可取消");
      if (row.cancel_requested_at) return row;
      const requested = (await db.query(
        'UPDATE payment_orders SET cancel_requested_at=now(),cancel_error_code=NULL WHERE id=$1 RETURNING *', [id],
      )).rows[0];
      await this.audit(db, actor, org, adminReason ? 'payment.order.admin-cancel-request' : 'payment.order.cancel-request', { orderId: id, reason: adminReason });
      return requested;
    });
    if (["pending", "uncertain"].includes(r.status)) await this.completeCancellation(r);
    return orderView((await this.pool.query('SELECT * FROM payment_orders WHERE id=$1', [id])).rows[0]);
  }
  private checkCloseEvidence(r: Row, evidence: PaymentEvidence | null, alipay: boolean) {
    if (evidence && (evidence.outTradeNo !== r.out_trade_no || (alipay &&
      (evidence.amountFen !== r.amount_fen || evidence.currency !== r.currency ||
       (r.transaction_id && r.transaction_id !== evidence.transactionId)))))
      throw new HttpError(409, 'PAYMENT_EVENT_MISMATCH', '查单订单号、金额、币种或交易号不一致');
  }
  private async completeCancellation(r: Row, checked?: {
    channel: Awaited<ReturnType<PaymentService['provider']>>;
    evidence: PaymentEvidence | null;
    queryStartedAt: number;
  }) {
    let outcome: 'closed' | 'not_found' | 'not_created' = 'closed';
    let repairedTerminal = false;
    try {
      if (r.creation_outcome === 'not_created' && !r.pay_url && !r.qr_code && !r.paid_at) {
        outcome = 'not_created';
      } else {
        const { api, row: provider } = checked?.channel ?? await this.provider(r.provider_id);
        const queryStartedAt = checked?.queryStartedAt ?? Date.now();
        const evidence = checked ? checked.evidence : await api.query(r.out_trade_no);
        const alipay = provider.kind === 'alipay';
        this.checkCloseEvidence(r, evidence, alipay);
        if (evidence?.paid) {
          await this.settle(r.provider_id, evidence, 'query');
          return;
        }
        if (!evidence?.closed) {
          outcome = (await api.close(r.out_trade_no)) ?? 'closed';
          repairedTerminal = Boolean(evidence && outcome === 'closed' && ['cancelled','expired'].includes(r.status));
        }
        if (alipay && outcome === 'not_found') {
          if (evidence) throw new HttpError(409, 'PAYMENT_UPSTREAM_UNCERTAIN', '支付宝查单与关单结果不一致');
          // A gateway miss does not invalidate a browser-held signed payment request.
          if (r.pay_url && ['redirect', 'wap'].includes(r.mode)) {
            const expiresAt = new Date(r.expires_at).toISOString();
            if (!hasBoundedAlipayPagePay(r.pay_url, r.out_trade_no, expiresAt))
              throw new HttpError(409, 'PAYMENT_ALIPAY_LEGACY_HANDOFF', '旧支付宝链接没有可核实的绝对截止时间');
            if (queryStartedAt < Date.parse(expiresAt) + 60_000)
              throw new HttpError(409, 'PAYMENT_ALIPAY_HANDOFF_ACTIVE', '支付宝付款链接尚未确认失效');
          }
        }
      }
    } catch (error) {
      const code = cancellationFailure(error);
      if (!code) throw error;
      await this.tx(async db => {
        await db.query('SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE', [r.organization_id]);
        // An expired QR attempt with no issued payment entry may be abandoned locally.
        // This is NOT proof of channel closure: keep querying and review any late payment.
        const abandoned = await db.query(
          "UPDATE payment_orders SET status='cancelled',channel_close_pending=true,cancel_error_code=$2 WHERE id=$1 AND paid_at IS NULL AND cancel_requested_at IS NOT NULL AND status IN ('pending','uncertain') AND expires_at<=clock_timestamp() AND mode='qrcode' AND pay_url IS NULL AND qr_code IS NULL RETURNING id",
          [r.id,code],
        );
        if (abandoned.rowCount) await this.audit(db, null, r.organization_id, 'payment.order.cancel-local', { orderId:r.id, channelConfirmed:false, code });
        else await db.query(
          "UPDATE payment_orders SET cancel_error_code=$2,channel_close_pending=(status IN ('cancelled','expired') OR channel_close_pending) WHERE id=$1 AND paid_at IS NULL AND status IN ('creating','pending','uncertain','cancelled','expired')", [r.id,code]);
      });
      return;
    }
    await this.finishClosure(r, outcome, repairedTerminal);
  }
  private async finishClosure(r: Row, outcome: 'closed' | 'not_found' | 'not_created', repairedTerminal = false) {
    await this.tx(async db => {
      await db.query('SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE', [r.organization_id]);
      const updated = await db.query(
        `UPDATE payment_orders SET status=CASE
          WHEN status IN ('cancelled','expired') THEN status
          WHEN cancel_requested_at IS NOT NULL OR expires_at>clock_timestamp() THEN 'cancelled' ELSE 'expired' END,
          cancel_error_code=NULL,channel_close_pending=false
          WHERE id=$1 AND paid_at IS NULL AND
            (status IN ('creating','pending','uncertain') OR (status IN ('cancelled','expired') AND ($2 OR channel_close_pending)))
            AND ($3 <> 'not_created' OR (creation_outcome='not_created' AND pay_url IS NULL AND qr_code IS NULL))
            AND ($3 <> 'not_found' OR pay_url IS NOT DISTINCT FROM $4)
          RETURNING status`,
        [r.id, repairedTerminal,outcome,r.pay_url],
      );
      if (updated.rowCount) await this.audit(db, null, r.organization_id,
        updated.rows[0].status === 'cancelled' ? 'payment.order.cancel' : 'payment.order.expire',
        { orderId: r.id, creationOutcome:r.creation_outcome, channelConfirmed:outcome === 'closed', channelOutcome:outcome });
    });
  }
  async refund(actor: string, id: string, reasonValue: unknown) {
    uuid(id);
    const reason = note(reasonValue);
    const r = await this.tx(async (db) => {
      await this.requireAdmin(actor, db, true);
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
      const used=(await db.query('SELECT 1 FROM public.billing_grants WHERE order_id=$1 AND remaining<total LIMIT 1',[id])).rows[0];
      if (used) throw new HttpError(409,'BILLING_QUOTA_ALREADY_USED','此订单额度已使用或已预占，不能直接全额退款，请先核对用量');
      await db.query('UPDATE public.billing_grants SET revoked_at=now() WHERE order_id=$1 AND revoked_at IS NULL',[id]);
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
      if (r.billing_kind === 'addon') {
        await db.query('UPDATE public.billing_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE order_id=$1',[id]);
      } else if (r.fulfilled_at && o.entitlement_version === r.after_version) {
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
    await this.requireAdmin(actor);
    await this.reconcileOne(uuid(id));
    return orderView(
      (await this.pool.query("SELECT * FROM payment_orders WHERE id=$1", [id]))
        .rows[0] ?? {},
    );
  }
  async billReports(actor: string) {
    await this.requireAdmin(actor);
    return new AlipayBills(this.pool,this.env,this.factory,this.billDownload).list();
  }
  async reconcileBill(actor: string, input: Row) {
    await this.requireAdmin(actor);
    const id = uuid(input.providerId), reason = note(input.reason);
    await this.tx(async db => {
      await this.requireAdmin(actor,db,true);
      await this.audit(db,actor,null,"payment.bill.reconcile",{providerId:id,billDate:input.billDate,reason});
    });
    await new AlipayBills(this.pool,this.env,this.factory,this.billDownload).run(id,input.billDate,true);
    return this.billReports(actor);
  }
  async reconcile() {
    const rows = (
      await this.pool.query(
        `SELECT id FROM payment_orders p WHERE status IN ('creating','pending','uncertain','refund_pending','cancelled','expired') AND (status='refund_pending' OR created_at>now()-interval '7 days' OR (status IN ('creating','pending','uncertain') AND (cancel_requested_at IS NOT NULL OR ${alipayHandoff})) OR channel_close_pending) AND (status<>'refund_pending' OR refund_next_check_at IS NULL OR refund_next_check_at<=now()) AND (last_checked_at IS NULL OR last_checked_at<now()-interval '1 minute') ORDER BY last_checked_at NULLS FIRST,id LIMIT 20`,
      )
    ).rows;
    for (const r of rows) {
      try {
        await this.reconcileOne(r.id);
      } catch {
        /* Next sweep retries; no paid state is inferred from an error. */
      }
    }
    await new AlipayBills(this.pool,this.env,this.factory,this.billDownload).sweep();
  }
}
function randomBytesId() {
  return randomUUID().replaceAll("-", "");
}
