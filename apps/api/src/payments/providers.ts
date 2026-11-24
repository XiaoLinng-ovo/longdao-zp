import {
  createHash,
  randomBytes,
  sign,
  verify,
  timingSafeEqual,
  createDecipheriv,
} from "node:crypto";
import { request } from "node:https";
import { resolvePaymentAddresses } from "./network.js";
import { HttpError } from "../http.js";
import { PaymentNotCreatedError } from "./creation.js";
import {
  amountFen,
  money,
  httpsURL,
  type MerchantConfig,
  type PaymentKind,
  type PaymentMethod,
  type PaymentMode,
} from "./security.js";
export interface PaymentRequest {
  outTradeNo: string;
  amountFen: number;
  name: string;
  method: PaymentMethod;
  mode: PaymentMode;
  notifyURL: string;
  returnURL: string;
  clientIP: string;
  expiresAt: string;
}
export interface PaymentResult {
  payURL: string | null;
  qrCode: string | null;
}
export interface PaymentEvidence {
  outTradeNo: string;
  transactionId: string;
  amountFen: number;
  currency: string;
  paid: boolean;
  closed?: boolean;
  paidAt?: string;
}
export type PaymentTransport = (
  url: string,
  method: string,
  body?: string,
  headers?: Record<string, string>,
) => Promise<{ text: string; headers: Record<string, string> }>;
export interface PaymentProvider {
  billURL?(date: string): Promise<string>;
  create(req: PaymentRequest): Promise<PaymentResult>;
  query(outTradeNo: string): Promise<PaymentEvidence | null>;
  notification(
    raw: string,
    headers: Record<string, string>,
  ): Promise<PaymentEvidence | null>;
  close(outTradeNo: string): Promise<void | "closed" | "not_found">;
  refund(
    outTradeNo: string,
    refundId: string,
    fen: number,
    reason: string,
  ): Promise<boolean>;
  queryRefund(
    outTradeNo: string,
    refundId: string,
    fen: number,
  ): Promise<boolean>;
}
const bad = (message = "支付通知校验失败") =>
  new HttpError(400, "PAYMENT_VERIFY_FAILED", message);
const upstream = () =>
  new HttpError(
    502,
    "PAYMENT_UPSTREAM_UNCERTAIN",
    "支付渠道暂时无法确认，请查询订单，勿重复付款",
  );
// Only call after response signature verification; never expose upstream messages.
function alipayFailure(data: any, method?: string): never {
  if (data?.code === "40004" && data?.sub_code === "ACQ.TRADE_NOT_EXIST" &&
      ["alipay.trade.query", "alipay.trade.close"].includes(method ?? ""))
    throw new HttpError(409, "PAYMENT_TRADE_NOT_FOUND", "支付渠道确认交易不存在");
  if (data?.code === "40003" && data?.sub_code === "isv.not-online-app")
    throw new (method === "alipay.trade.precreate" ? PaymentNotCreatedError : HttpError)(
      502,
      "PAYMENT_APPLICATION_NOT_ONLINE",
      "支付宝应用尚未上线，请在支付宝开放平台完成应用上线后再试",
    );
  if (method === "alipay.data.dataservice.bill.downloadurl.query" && data?.sub_code === "BILL_NOT_EXIST")
    throw new HttpError(409, "PAYMENT_BILL_NOT_READY", "支付宝账单尚未生成或当天无交易，稍后重试");
  throw upstream();
}

export function alipayTime(iso: string): string {
  return new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
}

// Old relative-timeout links do not prove when a first submission stops being accepted.
export function hasBoundedAlipayPagePay(url: string, no: string, expiresAt: string): boolean {
  try {
    const params = new URL(url).searchParams;
    const biz = JSON.parse(params.get("biz_content") ?? "null");
    return params.get("method") === "alipay.trade.page.pay" && biz?.out_trade_no === no &&
      biz.time_expire === alipayTime(expiresAt) && !Object.hasOwn(biz, "timeout_express");
  } catch {
    return false;
  }
}
function form(raw: string) {
  const entries = new URLSearchParams(raw),
    values: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k in values) throw bad();
    values[k] = v;
  }
  return values;
}
export function easySign(values: Record<string, string>, key: string) {
  const text = Object.keys(values)
    .filter((k) => !["sign", "sign_type"].includes(k) && values[k] !== "")
    .sort()
    .map((k) => k + "=" + values[k])
    .join("&");
  return createHash("md5")
    .update(text + key)
    .digest("hex");
}
function safeEqual(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
/** Pin a validated public DNS answer into the TLS request. No redirects or private network access. */
async function httpBytes(
  urlText: string,
  method: string,
  body = "",
  headers: Record<string, string> = {},
  limit = 1024 * 1024,
): Promise<{ bytes: Buffer; headers: Record<string, string> }> {
  const url = new URL(urlText);
  let addresses;
  try {
    httpsURL(url.origin);
    addresses = await resolvePaymentAddresses(url.hostname);
  } catch (error) {
    // No HTTPS payment request exists yet; never classify socket timeouts this way.
    const code = error instanceof HttpError ? error.code : "PAYMENT_DNS_LOOKUP_FAILED";
    throw new PaymentNotCreatedError(502, code, "连接支付渠道前网络检查失败");
  }
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method,
        family: address.family,
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(body)),
        },
        lookup: (_h, _o, cb) => cb(null, address.address, address.family),
        timeout: 15000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            res.destroy();
            reject(upstream());
          } else chunks.push(chunk);
        });
        res.on("error", () => reject(upstream()));
        res.on("end", () => {
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            reject(upstream());
            return;
          }
          resolve({
            bytes: Buffer.concat(chunks),
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(",") : (v ?? ""),
              ]),
            ),
          });
        });
      },
    );
    req.on("timeout", () => req.destroy());
    const deadline = setTimeout(() => req.destroy(upstream()), 30000);
    req.once("close", () => clearTimeout(deadline));
    req.on("error", () => reject(upstream()));
    req.end(body);
  });
}
async function http(url: string, method: string, body = "", headers: Record<string,string> = {}) {
  const response = await httpBytes(url, method, body, headers);
  return { text: response.bytes.toString("utf8"), headers: response.headers };
}
/** Download only the authenticated bill URL; preserve query bytes and require TLS. */
export async function downloadAlipayBill(value: string): Promise<Buffer> {
  const url = alipayBillURL(value);
  return (await httpBytes(url, "GET", "", {}, 20 * 1024 * 1024)).bytes;
}
export function alipayBillURL(value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw upstream(); }
  if (!["http:", "https:"].includes(u.protocol) || u.hostname !== "dwbillcenter.alipay.com" ||
      u.username || u.password || u.hash || u.port || u.pathname !== "/downloadBillFile.resource")
    throw new HttpError(502,"PAYMENT_BILL_URL_INVALID","支付宝账单下载地址不在受信任范围内");
  // Legacy API examples return HTTP. Upgrade the same official URL, never downgrade TLS.
  u.protocol = "https:";
  return u.toString();
}
function json(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw upstream();
  }
}
/** Extract the exact signed JSON response object rather than reserializing signed bytes. */
export function signedJsonObject(raw: string, key: string): string {
  const start = raw.indexOf('"' + key + '"');
  if (start < 0) throw upstream();
  const colon = raw.indexOf(":", start + key.length + 2);
  let i = colon + 1;
  while (/\s/.test(raw[i] ?? "")) i++;
  const begin = i;
  if (raw[i] !== "{") throw upstream();
  let depth = 0,
    quoted = false,
    escaped = false;
  for (; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return raw.slice(begin, i + 1);
  }
  throw upstream();
}
class Alipay implements PaymentProvider {
  constructor(
    private readonly c: MerchantConfig,
    private readonly transport: PaymentTransport = http,
  ) {}
  private get gateway() {
    if (this.c.environment && !["sandbox","production"].includes(this.c.environment)) throw upstream();
    return this.c.environment === "sandbox" ? "https://openapi-sandbox.dl.alipaydev.com/gateway.do" : "https://openapi.alipay.com/gateway.do";
  }
  private params(method: string, biz: any) {
    const timestamp = new Date(Date.now() + 8 * 3600000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const p: Record<string, string> = {
      app_id: this.c.appId!,
      method,
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp,
      version: "1.0",
      biz_content: JSON.stringify(biz),
    };
    return p;
  }
  private signed(p: Record<string, string>) {
    const message = Object.keys(p)
      .filter((k) => k !== "sign" && p[k] !== "")
      .sort()
      .map((k) => k + "=" + p[k])
      .join("&");
    return {
      ...p,
      sign: sign(
        "RSA-SHA256",
        Buffer.from(message),
        this.c.privateKey!,
      ).toString("base64"),
    };
  }
  private async api(method: string, biz: any) {
    const response = await this.transport(
      this.gateway,
      "POST",
      new URLSearchParams(this.signed(this.params(method, biz))).toString(),
      { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    );
    const raw = json(response.text),
      key = method.replaceAll(".", "_") + "_response";
    if (
      typeof raw.sign !== "string" ||
      !verify(
        "RSA-SHA256",
        Buffer.from(signedJsonObject(response.text, key)),
        this.c.publicKey!,
        Buffer.from(raw.sign, "base64"),
      )
    )
      throw upstream();
    const data = raw[key];
    if (data?.code !== "10000") alipayFailure(data, method);
    return data;
  }
  async create(r: PaymentRequest): Promise<PaymentResult> {
    const biz = {
      out_trade_no: r.outTradeNo,
      total_amount: money(r.amountFen),
      subject: r.name,
      ...(r.mode === "redirect" ? { time_expire: alipayTime(r.expiresAt) } : { timeout_express: "30m" }),
    };
    if (r.mode === "qrcode") {
      const p = this.params("alipay.trade.precreate", biz);
      p.notify_url = r.notifyURL;
      const result = await this.apiWithParams(
        p,
        "alipay_trade_precreate_response",
      );
      return { payURL: null, qrCode: String(result.qr_code) };
    }
    const p = this.params(r.mode === "wap" ? "alipay.trade.wap.pay" : "alipay.trade.page.pay", {
      ...biz,
      product_code: r.mode === "wap" ? "QUICK_WAP_WAY" : "FAST_INSTANT_TRADE_PAY",
      ...(r.mode === "wap" ? { quit_url: r.returnURL } : {}),
    });
    p.notify_url = r.notifyURL;
    p.return_url = r.returnURL;
    return {
      payURL:
        this.gateway + "?" +
        new URLSearchParams(this.signed(p)),
      qrCode: null,
    };
  }
  private async apiWithParams(p: Record<string, string>, key: string) {
    const r = await this.transport(
      this.gateway,
      "POST",
      new URLSearchParams(this.signed(p)).toString(),
      { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    );
    const raw = json(r.text);
    if (
      typeof raw.sign !== "string" ||
      !verify(
        "RSA-SHA256",
        Buffer.from(signedJsonObject(r.text, key)),
        this.c.publicKey!,
        Buffer.from(raw.sign, "base64"),
      )
    )
      throw upstream();
    if (raw[key]?.code !== "10000") alipayFailure(raw[key], p.method);
    return raw[key];
  }
  async query(no: string) {
    try {
      const d = await this.api("alipay.trade.query", { out_trade_no: no });
      if (!["WAIT_BUYER_PAY", "TRADE_CLOSED", "TRADE_SUCCESS", "TRADE_FINISHED"].includes(d.trade_status)) throw upstream();
      return this.evidence(d);
    } catch (error) {
      if (error instanceof HttpError && error.code === "PAYMENT_TRADE_NOT_FOUND") return null;
      throw error;
    }
  }
  private evidence(d: any): PaymentEvidence {
    const date = d.send_pay_date ?? d.gmt_payment;
    let paidAt: string | undefined;
    if (date != null && date !== "") {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) throw upstream();
      paidAt = date.replace(" ","T")+"+08:00";
      if (!Number.isFinite(Date.parse(paidAt))) throw upstream();
    }
    return {
      ...(paidAt ? { paidAt } : {}),
      outTradeNo: String(d.out_trade_no ?? ""),
      transactionId: String(d.trade_no ?? ""),
      amountFen: amountFen(d.total_amount),
      currency: "CNY",
      ...(d.trade_status === "TRADE_CLOSED" ? { closed: true } : {}),
      paid: ["TRADE_SUCCESS", "TRADE_FINISHED"].includes(d.trade_status) || (d.trade_status === "TRADE_CLOSED" && Boolean(paidAt)),
    };
  }
  async notification(raw: string) {
    const p = form(raw);
    if (
      p.sign_type !== "RSA2" ||
      !p.sign ||
      p.app_id !== this.c.appId ||
      p.seller_id !== this.c.sellerId
    )
      throw bad();
    const message = Object.keys(p)
      .filter((k) => !["sign", "sign_type"].includes(k) && p[k] !== "")
      .sort()
      .map((k) => k + "=" + p[k])
      .join("&");
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(message),
        this.c.publicKey!,
        Buffer.from(p.sign, "base64"),
      )
    )
      throw bad();
    if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(p.trade_status ?? ""))
      return null;
    return this.evidence(p);
  }
  async billURL(date: string) {
    const d = await this.api("alipay.data.dataservice.bill.downloadurl.query", { bill_type: "trade", bill_date: date });
    if (typeof d.bill_download_url !== "string") throw upstream();
    return alipayBillURL(d.bill_download_url);
  }
  async close(no: string) {
    try {
      const d = await this.api("alipay.trade.close", { out_trade_no: no });
      if (d.out_trade_no !== no) throw upstream();
      return "closed" as const;
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== "PAYMENT_TRADE_NOT_FOUND") throw error;
      return "not_found" as const;
    }
  }
  async refund(no: string, id: string, fen: number, reason: string) {
    const d = await this.api("alipay.trade.refund", {
      out_trade_no: no,
      out_request_no: id,
      refund_amount: money(fen),
      refund_reason: reason.slice(0, 256),
    });
    return d.fund_change === "Y" && d.out_trade_no === no && amountFen(d.refund_fee) === fen;
  }
  async queryRefund(no: string, id: string, fen: number) {
    const d = await this.api("alipay.trade.fastpay.refund.query", {
      out_trade_no: no,
      out_request_no: id,
    });
    return (
      d.out_trade_no === no &&
      d.out_request_no === id &&
      d.refund_status === "REFUND_SUCCESS" &&
      amountFen(d.refund_amount) === fen
    );
  }
}
class Wxpay implements PaymentProvider {
  constructor(
    private readonly c: MerchantConfig,
    private readonly transport: PaymentTransport = http,
  ) {}
  private verifyResponse(raw: string, h: Record<string, string>) {
    const timestamp = h["wechatpay-timestamp"],
      nonce = h["wechatpay-nonce"],
      signature = h["wechatpay-signature"];
    if (
      !timestamp ||
      !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) >= 300 ||
      !nonce ||
      !signature ||
      h["wechatpay-serial"] !== this.c.publicKeyId ||
      !verify(
        "RSA-SHA256",
        Buffer.from(timestamp + "\n" + nonce + "\n" + raw + "\n"),
        this.c.publicKey!,
        Buffer.from(signature, "base64"),
      )
    )
      throw bad();
  }
  private async api(path: string, method = "GET", data?: any) {
    const body = data ? JSON.stringify(data) : "",
      timestamp = String(Math.floor(Date.now() / 1000)),
      nonce = randomBytes(16).toString("hex");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(
        method +
          "\n" +
          path +
          "\n" +
          timestamp +
          "\n" +
          nonce +
          "\n" +
          body +
          "\n",
      ),
      this.c.privateKey!,
    ).toString("base64");
    const r = await this.transport(
      "https://api.mch.weixin.qq.com" + path,
      method,
      body,
      {
        "content-type": "application/json",
        accept: "application/json",
        "wechatpay-serial": this.c.publicKeyId!,
        authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${this.c.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.c.certSerial}",signature="${signature}"`,
      },
    );
    // WeChat close responds 204 without a signed body.
    if (!r.text) return null;
    this.verifyResponse(r.text, r.headers);
    return json(r.text);
  }
  async create(r: PaymentRequest): Promise<PaymentResult> {
    if (r.mode === "wap") throw new HttpError(400,"PAYMENT_MODE_MISMATCH","手机网站支付仅适用于支付宝官方渠道");
    const native = r.mode === "qrcode",
      data: any = {
        appid: this.c.appId,
        mchid: this.c.mchId,
        description: utf8Prefix(r.name, 127),
        out_trade_no: r.outTradeNo,
        notify_url: r.notifyURL,
        time_expire: r.expiresAt.replace(/\.\d{3}Z$/, "+00:00"),
        amount: { total: r.amountFen, currency: "CNY" },
      };
    if (!native)
      data.scene_info = {
        payer_client_ip: r.clientIP,
        h5_info: { type: "Wap" },
      };
    const d = await this.api(
      "/v3/pay/transactions/" + (native ? "native" : "h5"),
      "POST",
      data,
    );
    if (native) return { payURL: null, qrCode: String(d.code_url) };
    const url = new URL(String(d.h5_url));
    url.searchParams.set("redirect_url", r.returnURL);
    return { payURL: url.toString(), qrCode: null };
  }
  private evidence(d: any): PaymentEvidence {
    if (
      d.appid !== this.c.appId ||
      d.mchid !== this.c.mchId ||
      d.amount?.currency !== "CNY" ||
      !Number.isSafeInteger(d.amount?.total) ||
      d.amount.total < 1
    )
      throw bad();
    return {
      outTradeNo: String(d.out_trade_no ?? ""),
      transactionId: String(d.transaction_id ?? ""),
      amountFen: d.amount.total,
      currency: d.amount.currency,
      paid: d.trade_state === "SUCCESS",
    };
  }
  async query(no: string) {
    return this.evidence(
      await this.api(
        "/v3/pay/transactions/out-trade-no/" +
          encodeURIComponent(no) +
          "?mchid=" +
          encodeURIComponent(this.c.mchId!),
      ),
    );
  }
  async notification(raw: string, h: Record<string, string>) {
    this.verifyResponse(raw, h);
    const event = json(raw);
    if (event.event_type !== "TRANSACTION.SUCCESS") return null;
    const r = event.resource;
    if (
      r?.algorithm !== "AEAD_AES_256_GCM" ||
      typeof r.ciphertext !== "string" ||
      typeof r.nonce !== "string"
    )
      throw bad();
    try {
      const encrypted = Buffer.from(r.ciphertext, "base64"),
        cipher = createDecipheriv(
          "aes-256-gcm",
          Buffer.from(this.c.apiV3Key!, "utf8"),
          Buffer.from(r.nonce, "utf8"),
        );
      cipher.setAuthTag(encrypted.subarray(-16));
      cipher.setAAD(Buffer.from(r.associated_data ?? ""));
      const data = json(
        Buffer.concat([
          cipher.update(encrypted.subarray(0, -16)),
          cipher.final(),
        ]).toString("utf8"),
      );
      return this.evidence(data);
    } catch {
      throw bad();
    }
  }
  async close(no: string) {
    await this.api(
      "/v3/pay/transactions/out-trade-no/" + encodeURIComponent(no) + "/close",
      "POST",
      { mchid: this.c.mchId },
    );
  }
  async refund(no: string, id: string, fen: number, reason: string) {
    const d = await this.api("/v3/refund/domestic/refunds", "POST", {
      out_trade_no: no,
      out_refund_no: id,
      reason: reason.slice(0, 80),
      amount: { refund: fen, total: fen, currency: "CNY" },
    });
    return (
      d.out_trade_no === no &&
      d.out_refund_no === id &&
      d.status === "SUCCESS" &&
      d.amount?.refund === fen &&
      d.amount?.currency === "CNY"
    );
  }
  async queryRefund(no: string, id: string, fen: number) {
    const d = await this.api(
      "/v3/refund/domestic/refunds/" + encodeURIComponent(id),
    );
    return (
      d.out_trade_no === no &&
      d.out_refund_no === id &&
      d.status === "SUCCESS" &&
      d.amount?.refund === fen &&
      d.amount?.currency === "CNY"
    );
  }
}
class EasyPay implements PaymentProvider {
  constructor(
    private readonly c: MerchantConfig,
    private readonly transport: PaymentTransport = http,
  ) {}
  private endpoint(path: string) {
    return this.c.apiBase!.replace(/\/$/, "") + "/" + path;
  }
  private async post(path: string, p: Record<string, string>) {
    return json(
      (
        await this.transport(
          this.endpoint(path),
          "POST",
          new URLSearchParams(p).toString(),
          { "content-type": "application/x-www-form-urlencoded" },
        )
      ).text,
    );
  }
  async create(r: PaymentRequest): Promise<PaymentResult> {
    if (r.mode === "wap") throw new HttpError(400,"PAYMENT_MODE_MISMATCH","手机网站支付仅适用于支付宝官方渠道");
    const params: Record<string, string> = {
      pid: this.c.pid!,
      type: r.method,
      out_trade_no: r.outTradeNo,
      notify_url: r.notifyURL,
      return_url: r.returnURL,
      name: r.name,
      money: money(r.amountFen),
    };
    params.sign = easySign(params, this.c.pkey!);
    params.sign_type = "MD5";
    if (r.mode === "redirect")
      return {
        payURL: this.endpoint("submit.php") + "?" + new URLSearchParams(params),
        qrCode: null,
      };
    const d = await this.post("mapi.php", params);
    if (Number(d.code) !== 1 || (!d.qrcode && !d.payurl)) throw upstream();
    return { payURL: null, qrCode: String(d.qrcode || d.payurl) };
  }
  async query(no: string) {
    const d = await this.post("api.php", {
      act: "order",
      pid: this.c.pid!,
      key: this.c.pkey!,
      out_trade_no: no,
    });
    if (Number(d.code) !== 1) throw upstream();
    const v = d.data ?? d;
    if (v.pid !== undefined && String(v.pid) !== this.c.pid) throw bad();
    return {
      outTradeNo: String(v.out_trade_no ?? ""),
      transactionId: String(v.trade_no ?? ""),
      amountFen: amountFen(v.money),
      currency: "CNY",
      paid: v.trade_status === "TRADE_SUCCESS" || String(v.status) === "1",
    };
  }
  async notification(raw: string) {
    const p = form(raw),
      allowed = [
        "pid",
        "trade_no",
        "out_trade_no",
        "type",
        "name",
        "money",
        "trade_status",
        "param",
        "sign",
        "sign_type",
      ];
    if (
      Object.keys(p).some((k) => !allowed.includes(k)) ||
      p.pid !== this.c.pid ||
      p.sign_type !== "MD5" ||
      !p.sign ||
      !safeEqual(easySign(p, this.c.pkey!), p.sign.toLowerCase())
    )
      throw bad();
    if (p.trade_status !== "TRADE_SUCCESS") return null;
    const e = {
      outTradeNo: p.out_trade_no!,
      transactionId: p.trade_no!,
      amountFen: amountFen(p.money),
      currency: "CNY",
      paid: true,
    };
    // MD5 callback alone is insufficient: corroborate with authenticated server-side query.
    const q = await this.query(e.outTradeNo);
    if (
      !q.paid ||
      q.outTradeNo !== e.outTradeNo ||
      q.transactionId !== e.transactionId ||
      q.amountFen !== e.amountFen
    )
      throw bad();
    return e;
  }
  async close(_no: string) {
    throw new HttpError(
      409,
      "PAYMENT_CLOSE_UNSUPPORTED",
      "此聚合协议不支持关闭订单，请等待订单过期",
    );
  }
  async refund(no: string, id: string, fen: number, _reason: string) {
    const d = await this.post("api.php", {
      act: "refund",
      pid: this.c.pid!,
      key: this.c.pkey!,
      out_trade_no: no,
      out_refund_no: id,
      money: money(fen),
    });
    if (Number(d.code) !== 1) throw upstream();
    return true;
  }
  async queryRefund(_no: string, _id: string): Promise<boolean> {
    throw new HttpError(
      409,
      "REFUND_QUERY_UNSUPPORTED",
      "此聚合协议不支持退款查询，请核对渠道退款记录后重试同一退款单",
    );
  }
}
export const createProvider = (
  kind: PaymentKind,
  c: MerchantConfig,
  transport?: PaymentTransport,
): PaymentProvider =>
  kind === "wxpay"
    ? new Wxpay(c, transport)
    : kind === "alipay"
      ? new Alipay(c, transport)
      : new EasyPay(c, transport);
function utf8Prefix(text: string, maxBytes: number) {
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result + char) > maxBytes) break;
    result += char;
  }
  return result;
}
