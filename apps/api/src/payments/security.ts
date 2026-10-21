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
export type PaymentMode = "qrcode" | "redirect";
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
  if (
    Object.keys(cfg).some((k) => !fields[kind].includes(k)) ||
    fields[kind].some(
      (k) =>
        typeof cfg[k] !== "string" || !cfg[k]?.trim() || cfg[k]!.length > 16000,
    )
  )
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "支付配置字段不完整或存在未知字段",
    );
  const copy = Object.fromEntries(
    Object.entries(cfg).map(([k, v]) => [k, v.trim()]),
  );
  for (const field of kind === "wxpay"
    ? ["appId", "mchId", "certSerial", "publicKeyId"]
    : kind === "alipay"
      ? ["appId", "sellerId"]
      : ["pid"])
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(copy[field]!))
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "商户标识或公钥编号格式无效",
      );
  if (kind === "easypay") httpsURL(copy.apiBase!);
  else {
    try {
      const p = createPrivateKey(copy.privateKey!),
        q = createPublicKey(copy.publicKey!);
      if (
        p.asymmetricKeyType !== "rsa" ||
        q.asymmetricKeyType !== "rsa" ||
        (p.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
        (q.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw Error();
    } catch {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "请使用至少 2048 位的 PEM RSA 密钥",
      );
    }
  }
  if (kind === "wxpay" && Buffer.byteLength(copy.apiV3Key!, "utf8") !== 32)
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "微信 API v3 Key 必须为 32 字节",
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
