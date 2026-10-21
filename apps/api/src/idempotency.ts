import { createHash, randomUUID } from 'node:crypto';
import type { Middleware, RequestContext } from './http.js';
import { HttpError } from './http.js';
import { readBody } from './body.js';
import { sendSuccess } from './response.js';

/* ------------------------------------------------------------------ *
 * 可调参数（DEFAULT_*）：改这里即可整体调整幂等行为
 * ------------------------------------------------------------------ */

/** Idempotency-Key 允许的字符集与长度：8 ~ 128 位。 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** 幂等记录保留时长（毫秒），默认 24 小时。 */
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** 内存幂等表最大条数，超出后按创建时间淘汰最旧记录。 */
const DEFAULT_IDEMPOTENCY_MAX_ENTRIES = 1000;

/** 纳入幂等控制的写方法。 */
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** 登录/登出等认证入口不做幂等控制（Cookie 与限流语义不同）。 */
const IDEMPOTENCY_EXEMPT_PREFIXES = ['/api/v1/auth/', '/api/v1/workspaces', '/api/v1/workspace-invitations/'];

/* ------------------------------------------------------------------ *
 * 幂等记录存储
 * ------------------------------------------------------------------ */

export interface IdempotencyRecord {
  key: string;
  /** method + path + 操作人 + 请求体哈希；用于识别「同键不同请求」。 */
  fingerprint: string;
  /** `${method} ${pathname}`，用于把记录归属到具体路由（便于落库与审计）。 */
  route: string;
  /** 操作人用户 UUID；匿名请求为 null。 */
  actorId: string | null;
  status: number;
  data: unknown;
  createdAt: string;
  expiresAt: string;
}

export interface IdempotencyStore {
  find(key: string): Promise<IdempotencyRecord | undefined>;
  save(record: IdempotencyRecord): Promise<void>;
  /** 清理过期记录；内存实现等价于清空（仅测试/排障使用）。 */
  clear(): Promise<void>;
}

/**
 * 单进程内存实现：够本地与单实例演示用，重启即失效。
 * 生产要求跨实例/跨重启持久化时应替换为 PostgreSQL 实现
 * （`idempotency_records` 表，唯一约束 (actor_user_id, route, idempotency_key)），
 * 接口保持不变。
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly ttlMs: number = DEFAULT_IDEMPOTENCY_TTL_MS,
    private readonly maxEntries: number = DEFAULT_IDEMPOTENCY_MAX_ENTRIES
  ) {}

  async find(key: string): Promise<IdempotencyRecord | undefined> {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (Date.parse(record.expiresAt) <= Date.now()) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  async save(record: IdempotencyRecord): Promise<void> {
    this.prune();
    if (this.records.size >= this.maxEntries) {
      const oldest = [...this.records.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt))[0];
      if (oldest) this.records.delete(oldest[0]);
    }
    this.records.set(record.key, record);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  /** 清理已过期记录；find 命中过期键时也会单独删除。 */
  prune(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (Date.parse(record.expiresAt) <= now) this.records.delete(key);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 中间件
 * ------------------------------------------------------------------ */

export interface IdempotencyOptions {
  store?: IdempotencyStore;
  ttlMs?: number;
  /** 设为 false 可整体关闭（用于排障）。 */
  enabled?: boolean;
}

interface CapturedResponse {
  status: number;
  body: unknown;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 记录本次响应（状态码 + JSON 体）。sendJson 只会在响应未发出时写一次，
 * 因此这里捕获到的就是最终响应；转发时保留原始参数，不影响写回行为。
 */
function captureResponse(context: RequestContext): () => CapturedResponse | undefined {
  const response = context.res;
  const originalEnd = response.end;
  let captured: CapturedResponse | undefined;

  response.end = function (this: unknown, ...args: unknown[]): unknown {
    if (captured === undefined) {
      const chunk = args[0];
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      captured = { status: response.statusCode, body: parseJson(text) };
    }
    return (originalEnd as unknown as (...a: unknown[]) => unknown).apply(response, args);
  } as typeof response.end;

  return () => {
    response.end = originalEnd;
    return captured;
  };
}

function isSuccessEnvelope(body: unknown): body is { ok: true; data: unknown } {
  return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true && 'data' in body;
}

function fingerprintOf(context: RequestContext, rawBody: string): string {
  const actor = context.auth?.user.id ?? context.auth?.sessionId ?? 'anonymous';
  return createHash('sha256')
    .update([context.req.method ?? 'GET', context.url.pathname, actor, context.auth?.user.workspaceId ?? '', context.auth?.user.role ?? '', context.auth?.user.departmentId ?? '', rawBody].join('\n'))
    .digest('hex');
}

function readKey(context: RequestContext): string | undefined {
  const header = context.req.headers['idempotency-key'];
  if (header === undefined) return undefined;
  if (Array.isArray(header) || !IDEMPOTENCY_KEY_PATTERN.test(header.trim())) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key 必须是 8-128 位的字母、数字或 . _ : - 组合');
  }
  return header.trim();
}

/**
 * 幂等中间件：请求带 Idempotency-Key 时，
 * - 首次请求正常执行并在 2xx 后记录响应；
 * - 同键同请求（method + path + 操作人 + 请求体）再次到达时直接回放原响应，
 *   并附 `idempotency-replay: true`；
 * - 同键不同请求返回 409 IDEMPOTENCY_KEY_REUSED；
 * - 非 2xx 不记录，客户端可安全重试。
 */
export function createIdempotencyMiddleware(options: IdempotencyOptions = {}): Middleware {
  const store = options.store ?? new MemoryIdempotencyStore();
  const ttlMs = options.ttlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const enabled = options.enabled ?? process.env.IDEMPOTENCY_ENABLED !== 'false';

  return async (context, next) => {
    const method = context.req.method ?? 'GET';
    if (!enabled || !IDEMPOTENT_METHODS.has(method)) return next();
    if (context.req.headers['idempotency-key'] === undefined) return next();
    if (IDEMPOTENCY_EXEMPT_PREFIXES.some((prefix) => context.url.pathname.startsWith(prefix))) return next();
    // AI generation owns a durable task ledger. Always reach its current resource/role guards
    // and fingerprint validation rather than returning a generic cached response first.
    if (process.env.NODE_ENV !== 'test' && /^\/api\/v1\/jobs\/[^/]+\/(?:spec|jd)\/generate$/.test(context.url.pathname)) return next();

    if (/^\/api\/v1\/admin\/(?:billing-sandbox|ai-usage)(?:\/|$)/.test(context.url.pathname)) return next();

    const rawKey = readKey(context);
    if (rawKey === undefined) return next();
    // Separate tenants/actors even when their browsers reuse a client-generated key.
    const key = createHash('sha256').update(JSON.stringify([context.auth?.user.id ?? 'anonymous', context.auth?.user.workspaceId ?? '', rawKey])).digest('hex');

    // 先读完请求体：既为指纹提供原始文本，也让后续 readJson 命中缓存。
    const { raw } = await readBody(context);
    const fingerprint = fingerprintOf(context, raw);

    const existing = await store.find(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '该 Idempotency-Key 已用于其它请求，请为每次写操作使用新键');
      }
      context.res.setHeader('idempotency-replay', 'true');
      sendSuccess(context, existing.data, existing.status);
      return;
    }

    const release = captureResponse(context);
    try {
      await next();
    } finally {
      const captured = release();
      if (captured && captured.status >= 200 && captured.status < 300 && isSuccessEnvelope(captured.body)) {
        const createdAt = new Date().toISOString();
        await store.save({
          key,
          fingerprint,
          route: `${method} ${context.url.pathname}`,
          actorId: context.auth?.user.id ?? null,
          status: captured.status,
          data: captured.body.data,
          createdAt,
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        });
      }
    }
  };
}

/** 进程内默认实例，供 server 管线与排障复用。 */
export const idempotencyStore = new MemoryIdempotencyStore();

export const idempotencyMiddleware = createIdempotencyMiddleware({ store: idempotencyStore });

/** 便于测试与运维生成一个合法键。 */
export function newIdempotencyKey(): string {
  return randomUUID();
}
