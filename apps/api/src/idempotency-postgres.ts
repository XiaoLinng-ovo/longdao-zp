import type { Pool } from 'pg';
import type { IdempotencyRecord, IdempotencyStore } from './idempotency.js';

const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

interface IdempotencyRow {
  actor_user_id: string | null;
  route: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_body: unknown;
  created_at: Date;
}

/**
 * PostgreSQL 幂等存储：把幂等记录持久化到 `idempotency_records`，跨实例/跨重启保留。
 * 业务主键是客户端提供的 Idempotency-Key；表唯一约束 (actor_user_id, route, idempotency_key)
 * 用于兜底同键不同操作人的误复用。注意 PostgreSQL 的唯一约束对 NULL 不生效，因此匿名写请求
 * （本平台除认证入口外都要求登录）不会参与唯一约束，仅由中间件的 fingerprint 校验兜底。
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly pool: Pool,
    private readonly ttlMs: number = DEFAULT_IDEMPOTENCY_TTL_MS
  ) {}

  async find(key: string): Promise<IdempotencyRecord | undefined> {
    const result = await this.pool.query<IdempotencyRow>(
      `SELECT actor_user_id, route, idempotency_key, request_hash, response_status, response_body, created_at
         FROM idempotency_records
        WHERE idempotency_key = $1
          AND created_at > now() - make_interval(secs => $2::numeric / 1000)
        ORDER BY created_at DESC
        LIMIT 1`,
      [key, this.ttlMs]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return this.toRecord(row);
  }

  async save(record: IdempotencyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO idempotency_records
         (actor_user_id, route, idempotency_key, request_hash, response_status, response_body)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (actor_user_id, route, idempotency_key)
       DO UPDATE SET request_hash = EXCLUDED.request_hash,
                     response_status = EXCLUDED.response_status,
                     response_body = EXCLUDED.response_body,
                     created_at = now()`,
      [record.actorId, record.route, record.key, record.fingerprint, record.status, JSON.stringify(record.data ?? null)]
    );
  }

  async clear(): Promise<void> {
    await this.pool.query(
      `DELETE FROM idempotency_records WHERE created_at <= now() - make_interval(secs => $1::numeric / 1000)`,
      [this.ttlMs]
    );
  }

  private toRecord(row: IdempotencyRow): IdempotencyRecord {
    const createdAt = row.created_at.toISOString();
    const createdMs = row.created_at.getTime();
    return {
      key: row.idempotency_key,
      fingerprint: row.request_hash,
      route: row.route,
      actorId: row.actor_user_id,
      status: row.response_status,
      data: row.response_body,
      createdAt,
      expiresAt: new Date(createdMs + this.ttlMs).toISOString(),
    };
  }
}
