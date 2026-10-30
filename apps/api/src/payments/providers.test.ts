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
