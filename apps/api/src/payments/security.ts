import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { isIP } from "node:net";
import { HttpError } from "../http.js";
export type PaymentKind = "wxpay" | "alipay" | "easypay";
export type PaymentMethod = "wxpay" | "alipay";
export type PaymentMode = "qrcode" | "redirect" | "wap";
export type MerchantConfig = Record<string, string>;
export const uuid = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)
  )
    throw new HttpError(400, "VALIDATION_ERROR", "无效 ID");
  return v;
};
export function note(v: unknown): string {
  if (typeof v !== "string" || v.trim().length < 2 || v.trim().length > 500)
    throw new HttpError(400, "VALIDATION_ERROR", "请填写 2～500 字操作原因");
  return v.trim();
}
function key(env: NodeJS.ProcessEnv) {
  const text = env.PAYMENT_ENCRYPTION_KEY ?? "";
  const b = Buffer.from(text, "base64");
  if (b.length !== 32 || b.toString("base64") !== text)
    throw new HttpError(503, "PAYMENT_KEY_REQUIRED", "请先配置支付加密主密钥");
  return b;
}
export function encryptConfig(
  config: MerchantConfig,
  id: string,
  env = process.env,
) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(env), nonce);
  cipher.setAAD(Buffer.from("payment-provider:" + id));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(config), "utf8"),
    cipher.final(),
  ]);
  return [nonce, cipher.getAuthTag(), body]
    .map((b) => b.toString("base64"))
    .join(".");
}
export function decryptConfig(
  text: string,
  id: string,
  env = process.env,
): MerchantConfig {
  const parts = text.split(".").map((p) => Buffer.from(p, "base64"));
  if (parts.length !== 3)
    throw new HttpError(503, "PAYMENT_CONFIG_INVALID", "支付配置无法解密");
  const cipher = createDecipheriv("aes-256-gcm", key(env), parts[0]!);
  cipher.setAAD(Buffer.from("payment-provider:" + id));
  cipher.setAuthTag(parts[1]!);
  return JSON.parse(
    Buffer.concat([cipher.update(parts[2]!), cipher.final()]).toString("utf8"),
  );
}
export function amountFen(value: unknown): number {
  const text = String(value ?? "");
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(text))
    throw new HttpError(400, "PAYMENT_AMOUNT_INVALID", "支付金额无效");
  const [a, b = ""] = text.split("."),
    n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n < 1 || n > 100000000)
    throw new HttpError(400, "PAYMENT_AMOUNT_INVALID", "支付金额无效");
  return n;
}
export const money = (fen: number) => (fen / 100).toFixed(2);
export function httpsURL(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "PAYMENT_URL_INVALID", "请填写有效 HTTPS 地址");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.port && url.port !== "443") ||
    isIP(host) ||
    host === "localhost" ||
    !host.includes(".") ||
    /\.(local|internal|localhost|invalid)$/.test(host)
  )
    throw new HttpError(
      400,
      "PAYMENT_URL_INVALID",
      "支付地址必须使用公开 HTTPS 域名和标准端口",
    );
  return url;
}
export function validateConfig(
  kind: PaymentKind,
  input: unknown,
): MerchantConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "VALIDATION_ERROR", "支付配置无效");
  const cfg = input as MerchantConfig;
  const fields: Record<PaymentKind, string[]> = {
    wxpay: [
      "appId",
      "mchId",
      "privateKey",
      "certSerial",
      "apiV3Key",
      "publicKey",
      "publicKeyId",
    ],
    alipay: ["appId", "privateKey", "publicKey", "sellerId"],
    easypay: ["apiBase", "pid", "pkey"],
  };
  const labels: Record<PaymentKind, Record<string, string>> = {
    wxpay: { appId: "App ID", mchId: "商户号", privateKey: "商户 RSA 私钥", certSerial: "商户证书序列号", apiV3Key: "API v3 Key", publicKey: "微信支付公钥", publicKeyId: "微信支付公钥 ID" },
    alipay: { appId: "应用 App ID", privateKey: "应用 RSA 私钥", publicKey: "支付宝公钥", sellerId: "收款方 seller_id" },
    easypay: { apiBase: "接口 HTTPS 地址", pid: "商户 PID", pkey: "商户密钥" },
  };
  const unknown = Object.keys(cfg).find((k) => !(fields[kind].includes(k) || (kind === "alipay" && k === "environment")));
  if (unknown)
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "支付配置包含不支持的项目，请按当前渠道页面字段重新填写",
    );
  const missing = fields[kind].find((field) => typeof cfg[field] !== "string" || !cfg[field]!.trim());
  if (missing) throw new HttpError(400, "VALIDATION_ERROR", `请填写「${labels[kind][missing]}」`);
  const tooLong = fields[kind].find((field) => cfg[field]!.length > 16000);
  if (tooLong) throw new HttpError(400, "VALIDATION_ERROR", `「${labels[kind][tooLong]}」内容过长，请检查后重新填写`);
  const copy = Object.fromEntries(
    Object.entries(cfg).map(([k, v]) => [k, typeof v === "string" ? v.trim() : ""]),
  );
  if (kind === "alipay") {
    copy.environment ??= "production";
    if (!["production", "sandbox"].includes(copy.environment))
      throw new HttpError(400, "VALIDATION_ERROR", "支付宝环境必须为正式或沙箱");
  }
  for (const field of kind === "wxpay"
    ? ["appId", "mchId", "certSerial", "publicKeyId"]
    : kind === "alipay"
      ? ["appId", "sellerId"]
      : ["pid"])
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(copy[field]!))
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        `「${labels[kind][field]}」格式无效，仅支持字母、数字、下划线和连字符`,
      );
  if (kind === "easypay") httpsURL(copy.apiBase!);
  else {
    let privateKey, publicKey;
    try { privateKey = createPrivateKey(copy.privateKey!); }
    catch { throw new HttpError(400, "VALIDATION_ERROR", `「${labels[kind].privateKey}」格式无效，请粘贴完整 PEM 密钥并保留起止标记`); }
    try { publicKey = createPublicKey(copy.publicKey!); }
    catch { throw new HttpError(400, "VALIDATION_ERROR", `「${labels[kind].publicKey}」格式无效，请粘贴完整 PEM 密钥并保留起止标记`); }
    for (const [label, key] of [[labels[kind].privateKey, privateKey], [labels[kind].publicKey, publicKey]] as const) {
      if (key.asymmetricKeyType !== "rsa") throw new HttpError(400, "VALIDATION_ERROR", `「${label}」必须是 RSA 密钥`);
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new HttpError(400, "VALIDATION_ERROR", `「${label}」长度不足 2048 位，请更换符合要求的密钥`);
    }
  }
  if (kind === "wxpay" && Buffer.byteLength(copy.apiV3Key!, "utf8") !== 32)
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "微信支付 API v3 Key 长度必须为 32 字节",
    );
  return copy;
}
/** Only configured proxies may supply forwarding headers; inspect the chain from the trusted end. */
export function paymentClientIP(
  remote: string | undefined,
  forwarded: string | string[] | undefined,
  env = process.env,
): string {
  const normalize = (s: string) => s.trim().replace(/^::ffff:/, "");
  const address = normalize(remote ?? "127.0.0.1");
  const trusted = (env.PAYMENT_TRUSTED_PROXY_IPS ?? "")
    .split(",")
    .map(normalize)
    .filter(Boolean);
  if (!trusted.includes(address) || typeof forwarded !== "string")
    return address;
  const chain = forwarded.split(",").map(normalize);
  if (chain.length > 20 || chain.some((p) => !isIP(p))) return address;
  return (
    [...chain, address].reverse().find((p) => !trusted.includes(p)) ?? address
  );
}
export function publicBase(env = process.env) {
  const url = httpsURL(env.PAYMENT_PUBLIC_BASE_URL ?? "");
  if (url.pathname !== "/")
    throw new HttpError(
      503,
      "PAYMENT_BASE_REQUIRED",
      "支付公网地址必须为根域名",
    );
  return url.origin;
}
