import type { RequestContext } from './http.js';
import { HttpError } from './http.js';

const MAX_BODY_BYTES = 1024 * 1024;
// A 10 MiB file expands to ~13.34 MiB in the JSON base64 upload envelope.
// Keep other JSON routes at 1 MiB; only resume uploads need this allowance.
const MAX_RESUME_BODY_BYTES = Math.ceil(10 * 1024 * 1024 / 3) * 4 + 64 * 1024;

interface CachedBody {
  /** 原始请求体文本，用于幂等键指纹计算。 */
  raw: string;
  /** 解析后的 JSON 对象；空请求体解析为 {}。 */
  parsed: Record<string, unknown>;
}

/**
 * 请求体只能被 IncomingMessage 消费一次。幂等中间件需要原始文本做指纹，
 * 业务路由又需要解析后的对象，因此两者共用这份按 context 缓存的读取结果。
 */
const bodyCache = new WeakMap<RequestContext, CachedBody>();

export async function readBody(context: RequestContext): Promise<CachedBody> {
  const cached = bodyCache.get(context);
  if (cached) return cached;

  const maxBytes = context.req.method === 'POST' && context.url.pathname === '/api/v1/resumes'
    ? MAX_RESUME_BODY_BYTES : MAX_BODY_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of context.req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大');
    chunks.push(Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.length) {
    const empty: CachedBody = { raw: '', parsed: {} };
    bodyCache.set(context, empty);
    return empty;
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    const body: CachedBody = { raw, parsed: value as Record<string, unknown> };
    bodyCache.set(context, body);
    return body;
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', '请求体必须是有效 JSON 对象');
  }
}

export async function readJson(context: RequestContext): Promise<Record<string, unknown>> {
  return (await readBody(context)).parsed;
}
