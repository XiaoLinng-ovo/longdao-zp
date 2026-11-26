import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { HttpError } from "../http.js";

type Address = { address: string; family: number };
const officialGateways = new Set([
  "openapi.alipay.com",
  "openapi-sandbox.dl.alipaydev.com",
]);
const blocked = () => new HttpError(400, "PAYMENT_ENDPOINT_BLOCKED", "支付域名解析到非公网地址，请检查本机代理或 DNS 配置");
const dnsFailure = () => new HttpError(502, "PAYMENT_DNS_LOOKUP_FAILED", "无法解析支付渠道的公网地址，请检查网络后重试");

export function publicPaymentIP(ip: string): boolean {
  const family = isIP(ip);
  if (family === 6)
    return /^[23][0-9a-f]{3}:/i.test(ip) && !/^2001:(?:db8|0|10|20):/i.test(ip);
  if (family !== 4) return false;
  const a = ip.split(".").map(Number), x = a[0]!, y = a[1]!;
  return ![0, 10, 127].includes(x) && x < 224 &&
    !(x === 169 && y === 254) && !(x === 172 && y >= 16 && y <= 31) &&
    !(x === 192 && (y === 168 || y === 0)) && !(x === 100 && y >= 64 && y <= 127) &&
    !(x === 198 && (y === 18 || y === 19 || y === 51)) && !(x === 203 && y === 0);
}

function fakeIP(ip: string): boolean {
  return isIP(ip) === 4 && /^198\.(18|19)\./.test(ip);
}

// The DNS endpoint and its public IP are fixed; TLS still authenticates its hostname.
async function officialAddresses(hostname: string): Promise<Address[]> {
  if (!officialGateways.has(hostname)) throw blocked();
  const text = await new Promise<string>((resolve, reject) => {
    const req = request("https://dns.alidns.com/resolve?name=" + encodeURIComponent(hostname) + "&type=A", {
      family: 4,
      lookup: (_host, _options, cb) => cb(null, "223.5.5.5", 4),
      timeout: 5000,
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32768) req.destroy(dnsFailure());
        else chunks.push(chunk);
      });
      res.on("error", () => reject(dnsFailure()));
      res.on("end", () => res.statusCode === 200
        ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(dnsFailure()));
    });
    req.on("timeout", () => req.destroy(dnsFailure()));
    const deadline = setTimeout(() => req.destroy(dnsFailure()), 8000);
    req.once("close", () => clearTimeout(deadline));
    req.on("error", () => reject(dnsFailure()));
    req.end();
  });
  try {
    const data = JSON.parse(text);
    if (data.Status !== 0 || !Array.isArray(data.Answer)) throw dnsFailure();
    return data.Answer.filter((a: any) => a.type === 1).map((a: any) => ({ address: a.data, family: 4 }));
  } catch { throw dnsFailure(); }
}

export async function resolvePaymentAddresses(
  hostname: string,
  systemLookup: (host: string) => Promise<Address[]> = host => lookup(host, { all: true }),
  officialLookup: (host: string) => Promise<Address[]> = officialAddresses,
): Promise<Address[]> {
  let addresses = await systemLookup(hostname);
  // Only recognized proxy Fake-IP answers for exact official hosts get a fallback.
  if (officialGateways.has(hostname) && addresses.length && addresses.every(a => fakeIP(a.address)))
    addresses = await officialLookup(hostname);
  if (!addresses.length || addresses.some(a => !publicPaymentIP(a.address) || isIP(a.address) !== a.family))
    throw blocked();
  return addresses;
}
