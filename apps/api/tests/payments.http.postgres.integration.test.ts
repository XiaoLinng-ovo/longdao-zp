import { assertDisposableTestDatabase } from './helpers/disposable-database.js'
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
  assertDisposableTestDatabase();
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
  const previousSystemAdmin = process.env.SYSTEM_ADMIN_USER_NO;
  const env: NodeJS.ProcessEnv = {
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
          payURL: "https://pay.example.com/order",
          qrCode: null,
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
      [outsider],
    );
    env.SYSTEM_ADMIN_USER_NO = (await pool.query("SELECT user_no FROM users WHERE id=$1", [actor])).rows[0].user_no;
    process.env.SYSTEM_ADMIN_USER_NO = env.SYSTEM_ADMIN_USER_NO;
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
      "anonymous is rejected, ordinary member can view billing; writes require trusted origin and CSRF",
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
          200,
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
    await t.test('商品版本接口验证登录态、权限、CSRF、历史恢复及归并',async()=>{
      const path='/platform/payments/products/'+product.id;
      assert.equal((await request(path+'/history')).status,401);
      assert.equal((await request(path+'/history','GET',undefined,memberHeaders)).status,403);
      const h=await request(path+'/history','GET',undefined,headers);assert.equal(h.status,200);assert.equal(((await h.json()) as any).data.versions.length,1);
      const input={name:'HTTP 版本测试独立商品',seatLimit:10,jobLimit:100,amountFen:100,durationDays:30,reason:'验证版本接口',requestId:randomUUID()};
      const created=await request('/platform/payments/products','POST',input,headers);assert.equal(created.status,201);const a=((await created.json()) as any).data;
      const revision={...input,name:'HTTP 修改后的商品',expectedVersionId:a.id,requestId:randomUUID()};
      const revise='/platform/payments/products/'+a.id+'/revisions';
      assert.equal((await request(revise,'POST',revision,memberHeaders)).status,403);
      assert.equal((await request(revise,'POST',revision,{...headers,'x-csrf-token':'bad'})).status,403);
      assert.equal((await request(revise,'POST',revision,{...headers,origin:'https://evil.example.com'})).status,403);
      const changed=await request(revise,'POST',revision,headers);assert.equal(changed.status,201);const b=((await changed.json()) as any).data;assert.equal(b.catalogId,a.catalogId);assert.equal(b.active,true);
      const replay=await request(revise,'POST',revision,headers);assert.equal(replay.status,201);assert.equal(((await replay.json()) as any).data.id,b.id);
      assert.equal((await request(revise,'POST',{...revision,requestId:randomUUID()},headers)).status,409);
      assert.equal((await request('/platform/payments/products/'+a.id,'PATCH',{active:true,reason:'历史不能上架'},headers)).status,409);
      const another=await request('/platform/payments/products','POST',{...input,requestId:randomUUID()},headers);const c=((await another.json()) as any).data;
      const merge={versionIds:[b.id,c.id],keepVersionId:b.id,active:true,reason:'确认归并接口验证',requestId:randomUUID()};
      assert.equal((await request('/platform/payments/products/merge','POST',merge,memberHeaders)).status,403);
      assert.equal((await request('/platform/payments/products/merge','POST',merge,{...headers,'x-csrf-token':'bad'})).status,403);
      assert.equal((await request('/platform/payments/products/merge','POST',merge,{...headers,origin:'https://evil.example.com'})).status,403);
      assert.equal((await request('/platform/payments/products/merge','POST',merge,headers)).status,200);
      const history=await request('/platform/payments/products/'+c.id+'/history','GET',undefined,headers);assert.equal(((await history.json()) as any).data.versions.length,3);
    });
    await t.test('historical credit conversion requires a live system administrator, trusted origin and CSRF',async()=>{
      const missing=randomUUID(),path='/platform/payments/credit-conversions';
      assert.equal((await request(path+'/'+missing)).status,401);
      assert.equal((await request(path+'/'+missing,'GET',undefined,memberHeaders)).status,403);
      assert.equal((await request(path+'/'+missing,'GET',undefined,headers)).status,404);
      const input={orderId:missing,expectedDigest:'fixture',reason:'转换接口权限验证'};
      assert.equal((await request(path,'POST',input,memberHeaders)).status,403);
      assert.equal((await request(path,'POST',input,{...headers,'x-csrf-token':'bad'})).status,403);
      assert.equal((await request(path,'POST',input,{...headers,origin:'https://evil.example.com'})).status,403);
      assert.equal((await request(path,'POST',input,headers)).status,404);
    });
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
          mode: "redirect",
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
        for (const mode of ["qrcode", "wap"]) {
          const rejected = await request(
            "/payments/workspaces/" + org + "/orders",
            "POST",
            { ...input, mode },
            { ...memberHeaders, "idempotency-key": randomUUID() },
          );
          assert.equal(rejected.status, 400);
          assert.equal(((await rejected.json()) as any).error.code, "PAYMENT_MODE_MISMATCH");
        }
        const r = await request(
          "/payments/workspaces/" + org + "/orders",
          "POST",
          input,
          { ...memberHeaders, "idempotency-key": randomUUID() },
        );
        assert.equal(r.status, 201);
        order = ((await r.json()) as any).data;
        assert.equal(order.amountFen, 19900);
        assert.equal(order.mode, "redirect");
        assert.equal(order.payURL, "https://pay.example.com/order");
        assert.equal(order.qrCode, null);
        const duplicate = await request("/payments/workspaces/" + org + "/orders", "POST", input, { ...headers, "idempotency-key": randomUUID() });
        assert.equal(duplicate.status, 409);
        assert.equal(((await duplicate.json()) as any).error.code, "PAYMENT_ORDER_ALREADY_PENDING");
        const checkout = ((await (await request("/payments/workspaces/" + org, "GET", undefined, headers)).json()) as any).data;
        assert.equal(checkout.pendingOrder.id, order.id);
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
    await t.test("official bill reports require a system administrator and bill execution requires CSRF",async()=>{
      assert.equal((await request('/platform/payments/bills','GET',undefined,memberHeaders)).status,403);
      assert.equal((await request('/platform/payments/bills','GET',undefined,headers)).status,200);
      const noCsrf={...headers};delete noCsrf['x-csrf-token'];
      assert.equal((await request('/platform/payments/bills','POST',{providerId:provider.id,billDate:'2026-11-09',reason:'核对昨日'},noCsrf)).status,403);
    });
    await t.test("enterprise members can query and cancel each other's orders but cannot use system payment management", async () => {
      const path = "/payments/workspaces/" + org + "/orders/" + order.id;
      assert.equal((await request(path + "/verify", "POST", {}, headers)).status, 200);
      const cancelled = await request(path + "/cancel", "POST", {}, headers);
      assert.equal(cancelled.status, 200);
      assert.equal(((await cancelled.json()) as any).data.status, "cancelled");
      for (const h of [memberHeaders, outsiderHeaders]) {
        assert.equal((await request("/platform/payments", "GET", undefined, h)).status, 403);
        for (const endpoint of ["bills", "products", "providers", "orders/" + order.id + "/refund", "orders/" + order.id + "/verify"])
          assert.equal((await request("/platform/payments/" + endpoint, "POST", { reason: "越权测试" }, h)).status, 403);
      }
      const r = await request("/payments/workspaces/" + org + "/orders", "POST", { productId: product.id, providerId: provider.id, method: "alipay", mode: "redirect", expectedVersion: 1 }, { ...memberHeaders, "idempotency-key": randomUUID() });
      assert.equal(r.status, 201);
      order = ((await r.json()) as any).data;
    });
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
    await t.test('expired live sessions retain service reads, export and contact while recruiting writes stay blocked', async () => {
      await pool.query("UPDATE organizations SET paid_subscription_expires_at=now()-interval '1 day' WHERE id=$1", [org]);
      const path = '/payments/workspaces/' + org + '/service';
      assert.equal((await request(path, 'GET', undefined, memberHeaders)).status, 200);
      assert.equal((await request(path + '/export', 'POST', {}, memberHeaders)).status, 200);
      const upload = {filename:'续费问题.txt',base64:Buffer.alloc(1100*1024,65).toString('base64')};
      const created = await request(path + '/requests', 'POST', {message:'请协助企业续费',attachments:[upload]}, memberHeaders);
      assert.equal(created.status,200);
      const ticketId = ((await created.json()) as any).data.request.id;
      const threadPath = path + '/requests/' + ticketId;
      const detail = await request(threadPath,'GET',undefined,memberHeaders);
      assert.equal(detail.status,200);
      const thread = ((await detail.json()) as any).data;
      const fileId = thread.messages[0].attachments[0].id;
      const downloaded = await request(threadPath+'/attachments/'+fileId,'GET',undefined,memberHeaders);
      assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('cache-control'),'no-store');
      assert.equal(((await downloaded.json()) as any).data.base64,upload.base64);
      assert.equal((await request(threadPath+'/attachments/'+fileId,'GET',undefined,{...outsiderHeaders,'x-workspace-id':org})).status,403);
      assert.equal((await request(threadPath+'/messages','POST',{message:'继续补充',attachments:[upload]},memberHeaders)).status,200);
      const missingCsrf={...memberHeaders};delete missingCsrf['x-csrf-token'];
      assert.equal((await request(threadPath+'/messages','POST',{message:'缺少验证'},missingCsrf)).status,403);
      assert.equal((await request('/platform/payments/service-requests/'+ticketId+'/messages','POST',{message:'普通成员假装回复'},memberHeaders)).status,403);
      assert.equal((await request('/platform/payments/service-requests/'+ticketId+'/messages','POST',{message:'管理员继续回复',resolve:false},headers)).status,200);
      assert.equal((await request('/platform/payments/service-requests/'+ticketId,'GET',undefined,headers)).status,200);
      assert.equal((await request('/platform/payments/service-requests/'+ticketId+'/attachments/'+fileId,'GET',undefined,headers)).status,200);
      assert.equal((await request(threadPath,'GET',undefined,{...memberHeaders,'x-workspace-id':other})).status,409);
      assert.equal((await request(threadPath+'/messages','POST',{message:'超大文件',attachments:[{filename:'超大.txt',base64:Buffer.alloc(2*1024*1024+1,65).toString('base64')}]},memberHeaders)).status,413);
      const noCsrf = {...memberHeaders}; delete noCsrf['x-csrf-token'];
      assert.equal((await request(path + '/requests', 'POST', {message:'CSRF 校验'}, noCsrf)).status, 403);
      for (const route of ['/jobs','/resumes','/interviews']) {
        const result = await request(route, 'POST', {}, memberHeaders);
        const code=((await result.json()) as any).error.code;
        // Expiry also removes the selected workspace from live sessions. Test mode permits
        // no-workspace routes, so the stale workspace assertion can reject before the entitlement guard.
        assert.ok((result.status===403 && code==='WORKSPACE_SERVICE_UNAVAILABLE') || (result.status===409 && code==='WORKSPACE_CONTEXT_CHANGED'));

      }
      await pool.query("UPDATE organizations SET paid_subscription_expires_at=now()+interval '30 days' WHERE id=$1", [org]);
      await pool.query('DELETE FROM enterprise_service_requests WHERE organization_id=$1', [org]);
    });
    await t.test(
      "ordinary membership keeps billing access; removing membership revokes unchanged live sessions",
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
          200,
        );
        await pool.query("UPDATE users SET is_active=false WHERE id=$1", [member]);
        assert.equal((await request("/payments/workspaces/" + org, "GET", undefined, memberHeaders)).status, 401);
        await pool.query("UPDATE users SET is_active=true WHERE id=$1", [member]);
        await pool.query("DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2", [org, member]);
        assert.equal((await request("/payments/workspaces/" + org + "/orders/" + order.id, "GET", undefined, memberHeaders)).status, 403);
      },
    );
  } finally {
    if (previousSystemAdmin === undefined) delete process.env.SYSTEM_ADMIN_USER_NO;
    else process.env.SYSTEM_ADMIN_USER_NO = previousSystemAdmin;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of sessions)
      await pool.query("DELETE FROM sessions WHERE id=$1", [id]);
    await pool.query('DELETE FROM enterprise_service_requests WHERE organization_id=$1', [org]);
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
