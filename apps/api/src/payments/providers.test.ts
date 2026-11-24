import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateKeyPairSync,
  sign,
  verify,
  createCipheriv,
  randomBytes,
} from "node:crypto";
import { createProvider, easySign, signedJsonObject } from "./providers.js";
import { PaymentNotCreatedError } from "./creation.js";
import {
  amountFen,
  encryptConfig,
  decryptConfig,
  validateConfig,
  httpsURL,
  paymentClientIP,
} from "./security.js";
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
test("payment configuration is authenticated ciphertext bound to its provider; amounts use exact integer fen", () => {
  const env = { PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
    cfg = { pkey: "merchant-secret" },
    value = encryptConfig(cfg, "instance-a", env);
  assert(!value.includes("merchant-secret"));
  assert.deepEqual(decryptConfig(value, "instance-a", env), cfg);
  assert.throws(() => decryptConfig(value, "instance-b", env));
  assert.throws(() =>
    decryptConfig(value, "instance-a", {
      PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    }),
  );
  assert.equal(amountFen("299.01"), 29901);
  assert.equal(amountFen("0.01"), 1);
  for (const v of [
    "0",
    "-1",
    "1.001",
    "NaN",
    "Infinity",
    "1e2",
    " 1",
    "1000001",
  ])
    assert.throws(() => amountFen(v));
  for (const u of [
    "http://pay.example.com",
    "https://127.0.0.1",
    "https://localhost",
    "https://user:pass@pay.example.com",
    "https://pay.example.com?trade_status=SUCCESS",
  ])
    assert.throws(() => httpsURL(u));
  assert.throws(() =>
    validateConfig("easypay", { apiBase: "https://pay.example.com", pid: "1" }),
  );
});
test("Alipay requires signed success status, exact amount, app and seller identity; browser status is never evidence", async () => {
  const api = createProvider("alipay", {
    appId: "app",
    sellerId: "seller",
    ...keys,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
  });
  const fields: Record<string, string> = {
    app_id: "app",
    seller_id: "seller",
    out_trade_no: "sr_order",
    trade_no: "ali_tx",
    total_amount: "299.01",
    trade_status: "TRADE_SUCCESS",
    sign_type: "RSA2",
  };
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(
      Object.keys(fields)
        .filter((k) => k !== "sign_type")
        .sort()
        .map((k) => k + "=" + fields[k])
        .join("&"),
    ),
    keys.privateKey,
  ).toString("base64");
  const raw = new URLSearchParams({ ...fields, sign: signature }).toString();
  assert.equal((await api.notification(raw, {}))?.amountFen, 29901);
  for (const patch of [
    { total_amount: "0.01" },
    { seller_id: "other" },
    { app_id: "other" },
    { trade_status: "TRADE_FINISHED" },
  ])
    await assert.rejects(
      api.notification(
        new URLSearchParams({
          ...fields,
          ...patch,
          sign: signature,
        }).toString(),
        {},
      ),
    );
  await assert.rejects(api.notification(raw + "&total_amount=0.01", {}));
  await assert.rejects(
    api.notification("status=success&out_trade_no=sr_order", {}),
  );
});
test("WeChat verifies raw bytes, timestamp and public key ID before AES-GCM decryption and merchant binding", async () => {
  const config = {
    appId: "wx_app",
    mchId: "mch",
    apiV3Key: "12345678901234567890123456789012",
    publicKeyId: "PUB_KEY_ID",
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    certSerial: "serial",
  };
  const api = createProvider("wxpay", config);
  function notification(patch: Record<string, unknown> = {}) {
    const data = {
      appid: config.appId,
      mchid: config.mchId,
      out_trade_no: "sr_order",
      transaction_id: "wx_tx",
      trade_state: "SUCCESS",
      amount: { total: 29901, currency: "CNY" },
      ...patch,
    };
    const nonce = "nonce1234567",
      aad = "transaction",
      cipher = createCipheriv(
        "aes-256-gcm",
        Buffer.from(config.apiV3Key),
        Buffer.from(nonce),
      );
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(data)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
    const raw = JSON.stringify({
      event_type: "TRANSACTION.SUCCESS",
      resource: {
        algorithm: "AEAD_AES_256_GCM",
        ciphertext,
        nonce,
        associated_data: aad,
      },
    });
    const time = String(Math.floor(Date.now() / 1000)),
      h = {
        "wechatpay-timestamp": time,
        "wechatpay-nonce": "header_nonce",
        "wechatpay-serial": config.publicKeyId,
        "wechatpay-signature": sign(
          "RSA-SHA256",
          Buffer.from(time + "\nheader_nonce\n" + raw + "\n"),
          keys.privateKey,
        ).toString("base64"),
      };
    return { raw, h };
  }
  const { raw, h } = notification();
  assert.equal((await api.notification(raw, h))?.transactionId, "wx_tx");
  await assert.rejects(api.notification(raw + " ", h));
  await assert.rejects(
    api.notification(raw, { ...h, "wechatpay-serial": "other" }),
  );
  await assert.rejects(
    api.notification(raw, {
      ...h,
      "wechatpay-timestamp": String(Math.floor(Date.now() / 1000) - 301),
    }),
  );
  for (const patch of [
    { mchid: "other" },
    { appid: "other" },
    { amount: { total: 29901, currency: "USD" } },
  ]) {
    const n = notification(patch);
    await assert.rejects(api.notification(n.raw, n.h));
  }
});
test("EasyPay rejects forged, duplicated and creation-only callback fields without contacting upstream", async () => {
  const api = createProvider("easypay", {
    apiBase: "https://pay.example.com",
    pid: "pid",
    pkey: "secret",
  });
  const p = {
    pid: "pid",
    out_trade_no: "sr_order",
    trade_no: "tx",
    money: "299.01",
    trade_status: "TRADE_SUCCESS",
    type: "alipay",
    sign_type: "MD5",
  };
  const s = easySign(p, "secret"),
    raw = new URLSearchParams({ ...p, sign: s }).toString();
  await assert.rejects(
    api.notification(raw + "&return_url=https://example.com", {}),
  );
  await assert.rejects(api.notification(raw + "&money=0.01", {}));
  await assert.rejects(
    api.notification(
      new URLSearchParams({ ...p, money: "0.01", sign: s }).toString(),
      {},
    ),
  );
  await assert.rejects(
    api.notification(
      new URLSearchParams({ ...p, pid: "other", sign: s }).toString(),
      {},
    ),
  );
  const waiting = { ...p, trade_status: "WAIT_BUYER_PAY" };
  assert.equal(
    await api.notification(
      new URLSearchParams({
        ...waiting,
        sign: easySign(waiting, "secret"),
      }).toString(),
      {},
    ),
    null,
  );
});
test("signed Alipay response extraction preserves exact bytes including escaped braces and nested objects", () => {
  const raw =
    '{"alipay_trade_query_response": {"a":"}\\\"","n":{"x":2}},"sign":"sig"}';
  assert.equal(
    signedJsonObject(raw, "alipay_trade_query_response"),
    '{"a":"}\\\"","n":{"x":2}}',
  );
  assert.throws(() => signedJsonObject('{"response":null}', "response"));
});
test("H5 client IP ignores forged proxy headers and uses the nearest untrusted hop", () => {
  assert.equal(paymentClientIP("203.0.113.5", "1.2.3.4", {}), "203.0.113.5");
  assert.equal(
    paymentClientIP("127.0.0.1", "1.2.3.4, 203.0.113.5", {
      PAYMENT_TRUSTED_PROXY_IPS: "127.0.0.1",
    }),
    "203.0.113.5",
  );
  assert.equal(
    paymentClientIP("::ffff:127.0.0.1", "not-an-ip", {
      PAYMENT_TRUSTED_PROXY_IPS: "127.0.0.1",
    }),
    "127.0.0.1",
  );
});
const request = {
  outTradeNo: "sr" + "a".repeat(30),
  amountFen: 29901,
  name: "企业招聘套餐".repeat(12),
  method: "alipay" as const,
  mode: "qrcode" as const,
  notifyURL: "https://recruit.example.com/api/v1/payments/webhook/provider",
  returnURL:
    "https://recruit.example.com/enterprise/payments/order?workspace=org",
  clientIP: "1.2.3.4",
  expiresAt: new Date(Date.now() + 1800000).toISOString(),
};
test("Alipay real adapter emits RSA2 precreate and page-pay requests and verifies exact signed response bytes", async () => {
  let calls = 0;
  const adapter = createProvider(
    "alipay",
    {
      appId: "app",
      sellerId: "seller",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    },
    async (url, method, body) => {
      assert.equal(url, "https://openapi.alipay.com/gateway.do");
      assert.equal(method, "POST");
      calls++;
      const p = Object.fromEntries(new URLSearchParams(body)),
        signature = p.sign!,
        text = Object.keys(p)
          .filter((k) => k !== "sign")
          .sort()
          .map((k) => k + "=" + p[k])
          .join("&");
      assert(
        verify(
          "RSA-SHA256",
          Buffer.from(text),
          keys.publicKey,
          Buffer.from(signature, "base64"),
        ),
      );
      assert.equal(p.method, "alipay.trade.precreate");
      assert.equal(p.notify_url, request.notifyURL);
      const biz = JSON.parse(p.biz_content!);
      assert.equal(biz.total_amount, "299.01");
      assert.equal(biz.out_trade_no, request.outTradeNo);
      const response = JSON.stringify({
        code: "10000",
        qr_code: "https://qr.alipay.com/fixture",
      });
      return {
        text:
          '{"alipay_trade_precreate_response":' +
          response +
          ',"sign":"' +
          sign("RSA-SHA256", Buffer.from(response), keys.privateKey).toString(
            "base64",
          ) +
          '"}',
        headers: {},
      };
    },
  );
  assert.equal(
    (await adapter.create(request)).qrCode,
    "https://qr.alipay.com/fixture",
  );
  const result = await adapter.create({ ...request, mode: "redirect" }),
    p = Object.fromEntries(new URL(result.payURL!).searchParams);
  assert.equal(p.method, "alipay.trade.page.pay");
  assert.equal(p.return_url, request.returnURL);
  const redirectBiz = JSON.parse(p.biz_content!);
  assert.equal(redirectBiz.time_expire, new Date(Date.parse(request.expiresAt) + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '));
  assert.equal(redirectBiz.timeout_express, undefined);
  assert.equal(calls, 1);
  assert(
    verify(
      "RSA-SHA256",
      Buffer.from(
        Object.keys(p)
          .filter((k) => k !== "sign")
          .sort()
          .map((k) => k + "=" + p[k])
          .join("&"),
      ),
      keys.publicKey,
      Buffer.from(p.sign!, "base64"),
    ),
  );
  const tampered = createProvider(
    "alipay",
    { appId: "app", privateKey: keys.privateKey, publicKey: keys.publicKey },
    async () => ({
      text: '{"alipay_trade_precreate_response":{"code":"10000","qr_code":"fake"},"sign":"invalid"}',
      headers: {},
    }),
  );
  await assert.rejects(tampered.create(request));
});
test("Alipay reports offline applications only for authenticated responses without exposing gateway details", async () => {
  for (const operation of ["create", "query", "close"] as const) {
    for (const signature of ["valid", "invalid", "missing"]) {
      const adapter = createProvider("alipay", {
        appId: "app", privateKey: keys.privateKey, publicKey: keys.publicKey,
      }, async () => {
        const data = JSON.stringify({
          code: "40003", sub_code: "isv.not-online-app",
          sub_msg: "fixture-sensitive-upstream-message",
        });
        const key = operation === "create" ? "alipay_trade_precreate_response" : `alipay_trade_${operation}_response`;
        const value = signature === "valid"
          ? sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64")
          : "invalid";
        return {
          text: '{"' + key + '":' + data + (signature === "missing" ? "" : ',"sign":"' + value + '"') + "}",
          headers: {},
        };
      });
      await assert.rejects(operation === "create" ? adapter.create(request) : adapter[operation](request.outTradeNo), (error: any) => {
        assert.equal(error.code, signature === "valid" ? "PAYMENT_APPLICATION_NOT_ONLINE" : "PAYMENT_UPSTREAM_UNCERTAIN");
        assert.equal(error instanceof PaymentNotCreatedError, operation === 'create' && signature === 'valid');
        assert(!JSON.stringify(error).includes("fixture-sensitive"));
        assert(!error.message.includes("fixture-sensitive"));
        return true;
      });
    }
  }
});
test("Alipay accepts trade-not-found only for signed query/close responses, never as creation success", async () => {
  for (const signature of ["valid", "invalid", "missing"]) {
    const adapter = createProvider("alipay", { appId: "app", ...keys }, async (_url, _method, body) => {
      const method = new URLSearchParams(body).get("method")!;
      const key = method.replaceAll(".", "_") + "_response";
      const data = JSON.stringify({ code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" });
      const value = signature === "valid" ? sign("RSA-SHA256", Buffer.from(data), keys.privateKey).toString("base64") : "invalid";
      return { text: '{"' + key + '":' + data + (signature === "missing" ? "" : ',"sign":"' + value + '"') + "}", headers: {} };
    });
    if (signature === "valid") {
      assert.equal(await adapter.query("missing"), null);
      assert.equal(await adapter.close("missing"), "not_found");
    } else {
      await assert.rejects(adapter.query("missing"), { code: "PAYMENT_UPSTREAM_UNCERTAIN" });
      await assert.rejects(adapter.close("missing"), { code: "PAYMENT_UPSTREAM_UNCERTAIN" });
    }
    await assert.rejects(adapter.create(request), { code: "PAYMENT_UPSTREAM_UNCERTAIN" });
  }
});
test('Alipay verifies close acknowledgements and distinguishes closed query evidence from waiting and paid', async () => {
  let tradeStatus = 'WAIT_BUYER_PAY', closedOrderNo = 'order', paidAt: string | undefined;
  const adapter = createProvider('alipay', {appId:'app', ...keys}, async (_url, _method, body) => {
    const method = new URLSearchParams(body).get('method')!;
    const key = method.replaceAll('.', '_') + '_response';
    const data = JSON.stringify(method === 'alipay.trade.close' ? {code:'10000',out_trade_no:closedOrderNo}
      : {code:'10000',out_trade_no:'order',trade_no:'trade',total_amount:'1.00',trade_status:tradeStatus,send_pay_date:paidAt});
    return {text:`{"${key}":${data},"sign":"${sign('RSA-SHA256',Buffer.from(data),keys.privateKey).toString('base64')}"}`,headers:{}};
  });
  assert.equal((await adapter.query('order'))?.closed,undefined);
  tradeStatus = 'TRADE_CLOSED';
  assert.equal((await adapter.query('order'))?.closed,true);
  assert.equal((await adapter.query('order'))?.paid,false);
  paidAt = '2025-01-01 10:00:00';
  assert.equal((await adapter.query('order'))?.paid,true);
  assert.equal(await adapter.close('order'),'closed');
  closedOrderNo = 'another-order';
  await assert.rejects(adapter.close('order'),{code:'PAYMENT_UPSTREAM_UNCERTAIN'});
});
test("WeChat real adapter signs Native/H5 wire requests and verifies signed platform responses", async () => {
  const platform = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const c = {
    appId: "wxapp",
    mchId: "mch",
    certSerial: "cert",
    privateKey: keys.privateKey,
    publicKey: platform.publicKey,
    publicKeyId: "PUB",
    apiV3Key: "12345678901234567890123456789012",
  };
  const adapter = createProvider(
    "wxpay",
    c,
    async (url, method, body = "", headers = {}) => {
      const auth = Object.fromEntries(
          [...headers.authorization!.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [
            m[1],
            m[2],
          ]),
        ),
        u = new URL(url);
      assert(
        verify(
          "RSA-SHA256",
          Buffer.from(
            method +
              "\n" +
              u.pathname +
              u.search +
              "\n" +
              auth.timestamp +
              "\n" +
              auth.nonce_str +
              "\n" +
              body +
              "\n",
          ),
          keys.publicKey,
          Buffer.from(auth.signature!, "base64"),
        ),
      );
      const data = JSON.parse(body);
      assert.equal(data.amount.total, 29901);
      assert.equal(data.out_trade_no.length, 32);
      assert(Buffer.byteLength(data.description) <= 127);
      assert(!data.time_expire.includes("."));
      const native = u.pathname.endsWith("/native");
      if (!native) assert.equal(data.scene_info.payer_client_ip, "1.2.3.4");
      const text = JSON.stringify(
          native
            ? { code_url: "weixin://wxpay/fixture" }
            : { h5_url: "https://wx.tenpay.com/fixture" },
        ),
        timestamp = String(Math.floor(Date.now() / 1000)),
        nonce = "response_nonce";
      return {
        text,
        headers: {
          "wechatpay-timestamp": timestamp,
          "wechatpay-nonce": nonce,
          "wechatpay-serial": "PUB",
          "wechatpay-signature": sign(
            "RSA-SHA256",
            Buffer.from(timestamp + "\n" + nonce + "\n" + text + "\n"),
            platform.privateKey,
          ).toString("base64"),
        },
      };
    },
  );
  assert.equal(
    (await adapter.create({ ...request, method: "wxpay" })).qrCode,
    "weixin://wxpay/fixture",
  );
  const h5 = await adapter.create({
    ...request,
    method: "wxpay",
    mode: "redirect",
  });
  assert.equal(
    new URL(h5.payURL!).searchParams.get("redirect_url"),
    request.returnURL,
  );
});
test("EasyPay real adapter separates submit redirect from mapi QR and corroborates valid callbacks by authenticated query", async () => {
  let calls = 0;
  const c = {
    apiBase: "https://pay.example.com",
    pid: "merchant",
    pkey: "secret",
  };
  const adapter = createProvider("easypay", c, async (url, _method, body) => {
    calls++;
    const p = Object.fromEntries(new URLSearchParams(body));
    if (url.endsWith("mapi.php")) {
      assert.equal(p.money, "299.01");
      assert.equal(p.sign, easySign(p, "secret"));
      return {
        text: JSON.stringify({ code: 1, qrcode: "https://pay.example.com/qr" }),
        headers: {},
      };
    }
    assert(url.endsWith("api.php"));
    assert.equal(p.key, "secret");
    assert.equal(p.act, "order");
    return {
      text: JSON.stringify({
        code: 1,
        pid: "merchant",
        out_trade_no: request.outTradeNo,
        trade_no: "tx",
        money: "299.01",
        status: 1,
      }),
      headers: {},
    };
  });
  assert.equal(
    (await adapter.create(request)).qrCode,
    "https://pay.example.com/qr",
  );
  assert(
    new URL(
      (await adapter.create({ ...request, mode: "redirect" })).payURL!,
    ).pathname.endsWith("submit.php"),
  );
  assert.equal(calls, 1);
  const p = {
    pid: "merchant",
    out_trade_no: request.outTradeNo,
    trade_no: "tx",
    money: "299.01",
    type: "alipay",
    trade_status: "TRADE_SUCCESS",
    sign_type: "MD5",
  };
  const e = await adapter.notification(
    new URLSearchParams({ ...p, sign: easySign(p, "secret") }).toString(),
    {},
  );
  assert.equal(e?.amountFen, 29901);
  assert.equal(calls, 2);
});

test("Alipay WAP uses the immutable sandbox gateway and RSA2 QUICK_WAP_WAY request",async()=>{
  const adapter=createProvider("alipay",{appId:"app",sellerId:"seller",...keys,environment:"sandbox"},async()=>{throw Error("WAP must not create a QR transaction");});
  const r=await adapter.create({...request,mode:"wap"});
  const url=new URL(r.payURL!), params=Object.fromEntries(url.searchParams), biz=JSON.parse(params.biz_content!);
  assert.equal(url.origin,"https://openapi-sandbox.dl.alipaydev.com");
  assert.equal(params.method,"alipay.trade.wap.pay");assert.equal(biz.product_code,"QUICK_WAP_WAY");
  assert.equal(biz.quit_url,request.returnURL);assert.equal(params.notify_url,request.notifyURL);
  assert.equal(biz.total_amount,"299.01");
  assert(verify("RSA-SHA256",Buffer.from(Object.keys(params).filter(k=>k!=="sign").sort().map(k=>k+"="+params[k]).join("&")),keys.publicKey,Buffer.from(params.sign!,"base64")));
  assert.equal(validateConfig("alipay",{appId:"app",sellerId:"seller",...keys}).environment,"production");
  assert.throws(()=>validateConfig("alipay",{appId:"app",sellerId:"seller",...keys,environment:"other"}));
});
test("Alipay bill API verifies the exact response, treats a missing bill as retryable and binds requests to the selected gateway",async()=>{
  let data:Record<string,unknown>={code:"10000",bill_download_url:"http://dwbillcenter.alipay.com/downloadBillFile.resource?token=fixture"}, tamper=false;
  const adapter=createProvider("alipay",{appId:"app",...keys,environment:"sandbox"},async(url,method,body)=>{
    assert.equal(url,"https://openapi-sandbox.dl.alipaydev.com/gateway.do");
    const p=new URLSearchParams(body);assert.equal(p.get("method"),"alipay.data.dataservice.bill.downloadurl.query");
    assert.deepEqual(JSON.parse(p.get("biz_content")!),{bill_type:"trade",bill_date:"2026-11-09"});
    const raw=JSON.stringify(data), signature=sign("RSA-SHA256",Buffer.from(raw),keys.privateKey).toString("base64");
    return {text:JSON.stringify({alipay_data_dataservice_bill_downloadurl_query_response:tamper?{...data,code:"10000"}:data,sign:tamper?"invalid":signature}),headers:{}};
  });
  assert.equal(await adapter.billURL!("2026-11-09"),"https://dwbillcenter.alipay.com/downloadBillFile.resource?token=fixture");
  data={code:"40004",sub_code:"BILL_NOT_EXIST"};
  await assert.rejects(adapter.billURL!("2026-11-09"),(e:any)=>e.code==="PAYMENT_BILL_NOT_READY");
  tamper=true;await assert.rejects(adapter.billURL!("2026-11-09"),(e:any)=>e.code!=="PAYMENT_BILL_NOT_READY");
});
test("Alipay refund requires fund_change Y and never infers success from code 10000",async()=>{
  let change: string|undefined="N";
  const adapter=createProvider("alipay",{appId:"app",...keys},async(_url,_method,body)=>{
    const params=new URLSearchParams(body), biz=JSON.parse(params.get("biz_content")!);
    assert.equal(biz.out_request_no,"stable-refund");
    const data={code:"10000",out_trade_no:"order",refund_fee:"1.00",...(change?{fund_change:change}:{})},raw=JSON.stringify(data);
    return {text:JSON.stringify({alipay_trade_refund_response:data,sign:sign("RSA-SHA256",Buffer.from(raw),keys.privateKey).toString("base64")}),headers:{}};
  });
  assert.equal(await adapter.refund("order","stable-refund",100,"fixture"),false);
  change=undefined;assert.equal(await adapter.refund("order","stable-refund",100,"fixture"),false);
  change="Y";assert.equal(await adapter.refund("order","stable-refund",100,"fixture"),true);
  assert.equal(await adapter.refund("order","stable-refund",101,"fixture"),false);
});


test("invalid merchant keys return an actionable message without exposing key content", () => {
  assert.throws(() => validateConfig("alipay", {appId:"test",sellerId:"test",privateKey:"invalid-private-fixture",publicKey:"invalid-public-fixture"}), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, "「应用 RSA 私钥」格式无效，请粘贴完整 PEM 密钥并保留起止标记");
    assert(!error.message.includes("invalid-private-fixture"));
    return true;
  });
});

test("payment configuration validation names the missing or malformed field without echoing values", () => {
  assert.throws(() => validateConfig("alipay", {appId:"app-fixture",sellerId:"seller-fixture",privateKey:keys.privateKey}), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, "请填写「支付宝公钥」");
    assert(!error.message.includes("app-fixture"));
    return true;
  });
  assert.throws(() => validateConfig("alipay", {appId:"bad value",sellerId:"seller-fixture",...keys}), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, "「应用 App ID」格式无效，仅支持字母、数字、下划线和连字符");
    assert(!error.message.includes("bad value"));
    return true;
  });
  assert.throws(() => validateConfig("wxpay", {appId:"app",mchId:"mch",privateKey:keys.privateKey,certSerial:"serial",apiV3Key:"short",publicKey:keys.publicKey,publicKeyId:"key-id"}), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal(error.message, "微信支付 API v3 Key 长度必须为 32 字节");
    return true;
  });
});
