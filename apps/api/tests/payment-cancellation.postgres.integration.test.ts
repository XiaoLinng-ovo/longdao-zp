import { assertDisposableTestDatabase } from './helpers/disposable-database.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDatabasePool } from '../src/db/connection.js';
import { HttpError } from '../src/http.js';
import { PaymentNotCreatedError } from '../src/payments/creation.js';
import { PaymentService } from '../src/payments/service.js';
import { encryptConfig } from '../src/payments/security.js';
import { alipayTime, type PaymentEvidence, type PaymentProvider } from '../src/payments/providers.js';

// All test data, DDL and service transactions are nested inside one rollback-only schema.
test('cancellation persists intent and safely recovers channel failures in PostgreSQL', {
  skip: process.env.PAYMENT_MIGRATION_PROBE !== 'true',
}, async t => {
  assertDisposableTestDatabase();
  const pool = createDatabasePool(), db = await pool.connect();
  const schema = 'payment_cancel_' + randomUUID().replaceAll('-', '');
  const actor = randomUUID(), org = randomUUID(), provider = randomUUID(), plan = randomUUID();
  const env = { PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString('base64'), SYSTEM_ADMIN_USER_NO: 'USR-ABCDEF1234', PAYMENT_PUBLIC_BASE_URL: 'https://recruit.example.com', PAYMENT_BILL_AUTO_ENABLED:'false' };
  let queryError: unknown = null, closeError: unknown = null, createError: unknown = null, closes = 0, queries = 0, creates = 0;
  let evidence: PaymentEvidence | null = null, duringClose: (() => Promise<void>) | null = null, duringQuery: (() => Promise<void>) | null = null;
  let closeOutcome: 'closed' | 'not_found' = 'closed';
  const adapter: PaymentProvider = {
    create: async () => { creates++; if (createError) throw createError; return {payURL:'https://pay.example.com/order',qrCode:null}; },
    query: async () => { queries++; await duringQuery?.(); if (queryError) throw queryError; return evidence; },
    close: async () => { closes++; if (closeError) throw closeError; await duringClose?.(); return closeOutcome; },
    notification: async () => null,
    refund: async () => { throw Error('No refunds may be initiated'); },
    queryRefund: async () => false,
  };
  let sequence = 0;
  const savepoints: string[] = [];
  const query = async (sql: string, values?: unknown[]) => {
    if (sql === 'BEGIN') {
      const name = 'service_tx_' + sequence++;
      savepoints.push(name);
      return db.query('SAVEPOINT ' + name);
    }
    if (sql === 'COMMIT') return db.query('RELEASE SAVEPOINT ' + savepoints.pop()!);
    if (sql === 'ROLLBACK') {
      const name = savepoints.pop()!;
      await db.query('ROLLBACK TO SAVEPOINT ' + name);
      return db.query('RELEASE SAVEPOINT ' + name);
    }
    assert(!sql.includes('public.'), 'Service queries must not access real business tables');
    return db.query(sql, values);
  };
  const isolatedPool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const service = new PaymentService(isolatedPool, () => adapter, env);
  async function fixture(status = 'uncertain', expired = false) {
    queryError = closeError = createError = evidence = duringClose = duringQuery = null;
    closes = queries = creates = 0;
    closeOutcome = 'closed';
    await db.query('TRUNCATE payment_orders, platform_audit_logs, payment_events');
    const id = randomUUID();
    await db.query(`INSERT INTO payment_orders
      (id,out_trade_no,organization_id,actor_id,product_id,provider_id,method,mode,amount_fen,currency,
       product_name,plan_version_id,duration_days,expected_version,idempotency_key,fingerprint,status,expires_at,pay_url,qr_code)
      VALUES($1::uuid,($1::uuid)::text,$2,$3,$4,$5,'alipay','qrcode',25800,'CNY','fixture',$6,30,1,($1::uuid)::text,'fixture',$7,$8,'https://pay.example.com','fixture-qr')`,
    [id, org, actor, randomUUID(), provider, plan, status, new Date(Date.now() + (expired ? -60000 : 1800000))]);
    return id;
  }
  const row = async (id: string) => (await db.query('SELECT * FROM payment_orders WHERE id=$1', [id])).rows[0];
  async function handoff(id: string, remainingMs: number, bounded = true) {
    const expiresAt = new Date(Date.now() + remainingMs);
    const params = new URLSearchParams({method:'alipay.trade.page.pay',biz_content:JSON.stringify({out_trade_no:id,
      ...(bounded ? {time_expire:alipayTime(expiresAt.toISOString())} : {timeout_express:'30m'})})});
    await db.query("UPDATE payment_orders SET mode='redirect',qr_code=NULL,pay_url=$2,expires_at=$3 WHERE id=$1",
      [id,`https://openapi.alipay.com/gateway.do?${params}`,expiresAt]);
  }
  const waiting = (id: string): PaymentEvidence => ({ outTradeNo:id,transactionId:'fixture-trade',amountFen:25800,currency:'CNY',paid:false });
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout = '3s'");
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET LOCAL search_path TO ${schema}, pg_catalog`);
    await db.query('CREATE TABLE users (id uuid PRIMARY KEY,user_no text,is_active boolean)');
    await db.query('CREATE TABLE organizations (id uuid PRIMARY KEY,status text,service_status text,entitlement_version integer,seat_usage integer,job_usage integer)');
    await db.query('CREATE TABLE organization_members (organization_id uuid,user_id uuid,role text)');
    await db.query('CREATE TABLE payment_orders (LIKE public.payment_orders INCLUDING ALL)');
    // Exercise the actual additive migration, including rerun safety and preservation of existing rows.
    await db.query('ALTER TABLE payment_orders DROP COLUMN IF EXISTS cancel_requested_at, DROP COLUMN IF EXISTS cancel_error_code');
    const migration = (await readFile(new URL('../../../../db/migrations/0088_payment_cancellation_requests.sql', import.meta.url), 'utf8')).replaceAll('public.', schema + '.');
    await db.query(migration);
    await db.query(migration);
    await db.query('ALTER TABLE payment_orders DROP COLUMN IF EXISTS creation_outcome, DROP COLUMN IF EXISTS creation_error_code, DROP COLUMN IF EXISTS channel_close_pending');
    const creationMigration = (await readFile(new URL('../../../../db/migrations/0089_payment_creation_outcomes.sql', import.meta.url), 'utf8')).replaceAll('public.', schema + '.');
    await db.query(creationMigration);
    await db.query(creationMigration);
    await db.query('CREATE TABLE payment_products (id uuid PRIMARY KEY,plan_version_id uuid,active boolean,amount_fen integer,name text,duration_days integer,duration_months integer,all_modules boolean,billing_kind text,billing_entitlements jsonb)');
    await db.query('CREATE TABLE payment_providers (id uuid PRIMARY KEY,kind text,config_ciphertext text,enabled boolean DEFAULT true,environment text DEFAULT \'production\')');
    await db.query('CREATE TABLE platform_audit_logs (actor_user_id uuid,organization_id uuid,action text,metadata jsonb)');
    await db.query('CREATE TABLE payment_events (order_id uuid,event_key text UNIQUE,source text,metadata jsonb)');
    await db.query('CREATE TABLE subscription_plan_versions (id uuid PRIMARY KEY,seat_limit integer DEFAULT 20,job_limit integer DEFAULT 200)');
    await db.query('INSERT INTO users VALUES($1,$2,true)', [actor, env.SYSTEM_ADMIN_USER_NO]);
    await db.query("INSERT INTO organizations VALUES($1,'active','enabled',1,0,0)", [org]);
    await db.query("INSERT INTO organization_members VALUES($1,$2,'member')", [org,actor]);
    await db.query("INSERT INTO payment_providers(id,kind,config_ciphertext) VALUES($1,'alipay',$2)", [provider, encryptConfig({}, provider, env)]);
    await db.query('INSERT INTO subscription_plan_versions(id) VALUES($1)', [plan]);
    t.beforeEach(async () => { await db.query('SAVEPOINT subtest'); });
    t.afterEach(async () => {
      await db.query('ROLLBACK TO SAVEPOINT subtest');
      await db.query('RELEASE SAVEPOINT subtest');
    });

    await t.test('creation persists trusted rejection separately from timeout and idempotent retry never resubmits', async () => {
      for (const failure of [new PaymentNotCreatedError(502,'PAYMENT_APPLICATION_NOT_ONLINE','fixture'), new HttpError(502,'PAYMENT_UPSTREAM_UNCERTAIN','fixture'), null]) {
        await fixture();
        await db.query('TRUNCATE payment_orders');
        const product = randomUUID(), key = randomUUID();
        await db.query("INSERT INTO payment_products VALUES($1,$2,true,25800,'fixture',30,NULL,false,'subscription','{}')",[product,plan]);
        createError = failure;
        const input = {productId:product,providerId:provider,method:'alipay',mode:'redirect',expectedVersion:1};
        const result = await service.create(actor,org,input,key,'203.0.113.10');
        assert.equal(result.creationOutcome, failure instanceof PaymentNotCreatedError ? 'not_created' : failure ? 'unknown' : 'created');
        assert.equal((await row(result.id)).creation_outcome,result.creationOutcome);
        assert.equal((await service.create(actor,org,input,key,'203.0.113.10')).id,result.id);
        assert.equal(creates,1);
        if (failure instanceof PaymentNotCreatedError) {
          queryError = new HttpError(502,'PAYMENT_APPLICATION_NOT_ONLINE','fixture');
          const cancelled = await service.cancel(actor,org,result.id);
          assert.equal(cancelled.status,'cancelled');
          assert.equal(cancelled.channelClosePending,false);
          assert.equal(queries,0);
          assert.equal(closes,0);
        }
      }
    });
    await t.test('expired historical attempt without payment entry can be locally cancelled and releases the order slot', async () => {
      const id = await fixture('uncertain',true);
      await db.query('UPDATE payment_orders SET pay_url=NULL,qr_code=NULL WHERE id=$1',[id]);
      queryError = new HttpError(502,'PAYMENT_APPLICATION_NOT_ONLINE','fixture');
      const result = await service.cancel(actor,org,id);
      assert.equal(result.status,'cancelled');
      assert.equal(result.creationOutcome,'unknown');
      assert.equal(result.channelClosePending,true);
      assert.equal(closes,0);
      await assert.rejects(service.create(actor,org,{productId:randomUUID(),providerId:provider,method:'alipay',mode:'redirect',expectedVersion:1},randomUUID(),'203.0.113.10'),{code:'PAYMENT_UNAVAILABLE'});
      assert.equal((await db.query("SELECT count(*)::int n FROM platform_audit_logs WHERE action='payment.order.cancel-local'")).rows[0].n,1);
      await service.verify(actor,org,id);
      assert.equal((await row(id)).channel_close_pending,true);
      queryError = null;
      await db.query('UPDATE payment_orders SET last_checked_at=NULL WHERE id=$1',[id]);
      const confirmed = await service.verify(actor,org,id);
      assert.equal(confirmed.status,'cancelled');
      assert.equal(confirmed.channelClosePending,false);
      assert.equal(closes,1);
    });
    await t.test('unexpired unknown attempt or an issued payment entry must not be silently abandoned', async () => {
      for (const [expired, credentials, mode] of [[false,false,'qrcode'],[true,true,'qrcode'],[true,false,'redirect']] as const) {
        const id = await fixture('uncertain',expired);
        if (!credentials) await db.query('UPDATE payment_orders SET pay_url=NULL,qr_code=NULL WHERE id=$1',[id]);
        await db.query('UPDATE payment_orders SET mode=$2 WHERE id=$1',[id,mode]);
        queryError = new HttpError(502,'PAYMENT_APPLICATION_NOT_ONLINE','fixture');
        const result = await service.cancel(actor,org,id);
        assert.equal(result.status,'uncertain');
        assert.equal(result.channelClosePending,false);
      }
    });
    await t.test('late payment after local cancellation is recorded for review, never silently fulfilled', async () => {
      const id = await fixture('uncertain',true);
      await db.query('UPDATE payment_orders SET pay_url=NULL,qr_code=NULL WHERE id=$1',[id]);
      queryError = new HttpError(502,'PAYMENT_APPLICATION_NOT_ONLINE','fixture');
      await service.cancel(actor,org,id);
      queryError = null;
      evidence = {outTradeNo:id,transactionId:'late-fixture',amountFen:25800,currency:'CNY',paid:true};
      const result = await service.verify(actor,org,id);
      assert.equal(result.status,'review');
      assert(result.paidAt);
      assert.equal(result.channelClosePending,false);
      assert.equal(closes,0);
      assert.equal((await db.query('SELECT entitlement_version FROM organizations WHERE id=$1',[org])).rows[0].entitlement_version,1);
    });
    await t.test('a paid callback racing failed channel verification cannot be overwritten by local cancellation', async () => {
      const id = await fixture('uncertain',true);
      await db.query('UPDATE payment_orders SET pay_url=NULL,qr_code=NULL WHERE id=$1',[id]);
      queryError = new HttpError(502,'PAYMENT_APPLICATION_NOT_ONLINE','fixture');
      duringQuery = async () => { await service.settle(provider,{outTradeNo:id,transactionId:'local-race-fixture',amountFen:25800,currency:'CNY',paid:true},'callback'); };
      const result = await service.cancel(actor,org,id);
      assert.equal(result.status,'review');
      assert(result.paidAt);
      assert.equal(result.channelClosePending,false);
      assert.equal((await db.query("SELECT count(*)::int n FROM platform_audit_logs WHERE action='payment.order.cancel-local'")).rows[0].n,0);
    });

    await t.test('channel errors persist intent once and remove payment entries without claiming cancellation', async () => {
      for (const code of ['PAYMENT_ENDPOINT_BLOCKED','PAYMENT_APPLICATION_NOT_ONLINE','PAYMENT_UPSTREAM_UNCERTAIN']) {
        const id = await fixture();
        queryError = new HttpError(502, code, 'sensitive-fixture');
        const result = await service.cancel(actor,org,id);
        assert.equal(result.status,'uncertain');
        assert(result.cancelRequestedAt);
        assert.equal(result.payURL,null);
        assert.equal(result.qrCode,null);
        assert(!result.cancellationMessage!.includes('sensitive-fixture'));
        assert.equal((await row(id)).cancel_error_code,code);
        assert.equal(closes,0);
        await service.cancel(actor,org,id);
        assert.equal((await db.query("SELECT count(*)::int n FROM platform_audit_logs WHERE action='payment.order.cancel-request'")).rows[0].n,1);
      }
    });
    await t.test('background verification retries cancellation even after expiry', async () => {
      const id = await fixture('pending',true);
      closeError = new HttpError(502,'PAYMENT_UPSTREAM_UNCERTAIN','timeout');
      assert.equal((await service.cancel(actor,org,id)).status,'pending');
      await assert.rejects(service.create(actor,org,{productId:randomUUID(),providerId:provider,method:'alipay',mode:'redirect',expectedVersion:1},randomUUID(),'203.0.113.10'),{code:'PAYMENT_ORDER_ALREADY_PENDING'});
      closeError = null;
      const result = await service.verify(actor,org,id);
      assert.equal(result.status,'cancelled');
      assert.equal((await row(id)).cancel_error_code,null);
      assert.equal(closes,2);
      await service.cancel(actor,org,id);
      assert.equal(closes,2);
      assert.equal((await db.query("SELECT count(*)::int n FROM platform_audit_logs WHERE action='payment.order.cancel'")).rows[0].n,1);
    });
    await t.test('a confirmed missing transaction no longer fails an order-number comparison', async () => {
      const id = await fixture();
      closeOutcome = 'not_found';
      assert.equal((await service.cancel(actor,org,id)).status,'cancelled');
      assert.equal(closes,1);
      const audit = (await db.query("SELECT metadata FROM platform_audit_logs WHERE action='payment.order.cancel'")).rows[0];
      assert.equal(audit.metadata.channelConfirmed,false);
      assert.equal(audit.metadata.channelOutcome,'not_found');
    });
    await t.test('an issued browser handoff may create a trade after a missing result; cancellation waits and then closes it', async () => {
      const id = await fixture('pending');
      await handoff(id,60000);
      closeOutcome = 'not_found';
      const requested = await service.cancel(actor,org,id);
      assert.equal(requested.status,'pending');
      assert.equal(requested.payURL,null);
      assert.equal((await row(id)).cancel_error_code,'PAYMENT_ALIPAY_HANDOFF_ACTIVE');
      evidence = waiting(id);
      closeOutcome = 'closed';
      await service.reconcile();
      assert.equal((await row(id)).status,'cancelled');
      assert.equal(closes,2);
    });
    await t.test('expiry retains the enterprise slot until a bounded handoff is expired and the gateway still finds no trade', async () => {
      const id = await fixture('pending');
      await handoff(id,-10_000);
      closeOutcome = 'not_found';
      assert.equal((await service.verify(actor,org,id)).status,'pending');
      const input = {productId:randomUUID(),providerId:provider,method:'alipay',mode:'redirect',expectedVersion:1};
      await assert.rejects(service.create(actor,org,input,randomUUID(),'203.0.113.10'),{code:'PAYMENT_ORDER_ALREADY_PENDING'});
      await handoff(id,-80_000);
      await db.query('UPDATE payment_orders SET last_checked_at=NULL WHERE id=$1',[id]);
      assert.equal((await service.verify(actor,org,id)).status,'expired');
      await assert.rejects(service.create(actor,org,input,randomUUID(),'203.0.113.10'),{code:'PAYMENT_UNAVAILABLE'});
    });
    await t.test('legacy relative timeouts never imply missing trade closure, but signed closed evidence resolves it', async () => {
      const id = await fixture('pending');
      await handoff(id,-120_000,false);
      closeOutcome = 'not_found';
      assert.equal((await service.cancel(actor,org,id)).status,'pending');
      assert.equal((await row(id)).cancel_error_code,'PAYMENT_ALIPAY_LEGACY_HANDOFF');
      evidence = {...waiting(id),closed:true};
      assert.equal((await service.verify(actor,org,id)).status,'cancelled');
      assert.equal(closes,1);
    });
    await t.test('reconciliation retries an older locally cancelled trade still payable at Alipay', async () => {
      const id = await fixture('cancelled',true);
      await handoff(id,-120_000,false);
      evidence = waiting(id);
      closeError = new HttpError(502,'PAYMENT_UPSTREAM_UNCERTAIN','timeout');
      assert.equal((await service.verify(actor,org,id)).channelClosePending,true);
      await db.query("UPDATE payment_orders SET last_checked_at=NULL,created_at=now()-interval '8 days' WHERE id=$1",[id]);
      closeError = null;
      await service.reconcile();
      assert.equal((await row(id)).channel_close_pending,false);
      assert.equal(closes,2);
    });
    await t.test('a channel-closed trade without payment is no longer payable locally before its original deadline', async () => {
      const id = await fixture('pending');
      evidence = {...waiting(id),closed:true};
      const result = await service.verify(actor,org,id);
      assert.equal(result.status,'cancelled');
      assert.equal(result.payURL,null);
      assert.equal(result.qrCode,null);
      assert.equal(closes,0);
    });
    await t.test('a channel-closed trade with historical payment is kept for review rather than granting a package', async () => {
      const id = await fixture('pending');
      evidence = {...waiting(id),closed:true,paid:true,paidAt:new Date(Date.now()-1000).toISOString()};
      const result = await service.verify(actor,org,id);
      assert.equal(result.status,'review');
      assert(result.paidAt);
      assert.match(result.reviewReason,/历史付款/);
      assert.equal(closes,0);
    });
    await t.test('mismatched evidence and database errors are never swallowed as a successful cancellation', async () => {
      let id = await fixture();
      evidence = { outTradeNo:'different-order',transactionId:'',amountFen:25800,currency:'CNY',paid:false };
      await assert.rejects(service.cancel(actor,org,id),{code:'PAYMENT_EVENT_MISMATCH'});
      assert.equal((await row(id)).status,'uncertain');
      assert.equal(closes,0);
      id = await fixture();
      queryError = new Error('unexpected error');
      await assert.rejects(service.cancel(actor,org,id),/unexpected error/);
      assert.equal((await row(id)).status,'uncertain');
    });
    await t.test('an authenticated paid result is settled for review, not cancelled or closed', async () => {
      const id = await fixture('uncertain',true);
      evidence = { outTradeNo:id,transactionId:'paid-fixture',amountFen:25800,currency:'CNY',paid:true };
      const result = await service.cancel(actor,org,id);
      assert.equal(result.status,'review');
      assert(result.paidAt);
      assert.equal(closes,0);
      assert.equal((await db.query('SELECT count(*)::int n FROM payment_events')).rows[0].n,1);
    });
    await t.test('a settlement racing a channel close cannot be overwritten as cancelled', async () => {
      const id = await fixture('pending');
      duringClose = async () => {
        await service.settle(provider,{outTradeNo:id,transactionId:'race-fixture',amountFen:25800,currency:'CNY',paid:true},'callback');
      };
      assert.equal((await service.cancel(actor,org,id)).status,'review');
      assert.equal((await db.query("SELECT count(*)::int n FROM platform_audit_logs WHERE action='payment.order.cancel'")).rows[0].n,0);
    });
    await t.test('membership and tenant checks run before any cancellation request', async () => {
      const id = await fixture();
      await assert.rejects(service.cancel(randomUUID(),org,id),{code:'WORKSPACE_MEMBER_REQUIRED'});
      await db.query('UPDATE payment_orders SET organization_id=$2 WHERE id=$1',[id,randomUUID()]);
      await assert.rejects(service.cancel(actor,org,id),{code:'ORDER_NOT_FOUND'});
      assert.equal((await row(id)).cancel_requested_at,null);
      assert.equal(closes,0);
    });
    await t.test('administrator cancellation retains operator and reason in the audit trail', async () => {
      const id = await fixture();
      assert.equal((await service.adminCancel(actor,id,'fixture reason')).status,'cancelled');
      const audit = (await db.query("SELECT * FROM platform_audit_logs WHERE action='payment.order.admin-cancel-request'")).rows[0];
      assert.equal(audit.actor_user_id,actor);
      assert.equal(audit.metadata.reason,'fixture reason');
    });
  } finally {
    await db.query('ROLLBACK');
    db.release();
    await pool.end();
  }
});
