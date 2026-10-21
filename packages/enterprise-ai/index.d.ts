interface QueryResult { rows: Record<string, unknown>[] }
export interface Queryable { query(sql: string, values?: unknown[]): Promise<QueryResult> }
export interface DatabasePool extends Queryable { connect(): Promise<Queryable & { release(): void }> }
export class EnterpriseAiError extends Error { code: string; status: number; constructor(code: string, message: string, status?: number) }
export function normalizeAiBaseUrl(value: string | undefined): string
export function assertAiEndpointAllowed(baseUrl: string, env?: Record<string, string | undefined>): void
export function encryptApiKey(secret: string, organizationId: string, masterKey: string): string
export function decryptApiKey(value: string, organizationId: string, masterKey: string): string
export function validateEnterpriseAiPatch(patch: unknown): asserts patch is Partial<Record<'OPENAI_BASE_URL' | 'OPENAI_API_KEY' | 'OPENAI_MODEL' | 'OPENAI_TIMEOUT_MS', string>>
export interface EnterpriseAiView {
  organizationId: string; scope: 'enterprise'; configured: boolean; baseUrlHost: string; model: string; timeoutMs: number;
  apiKeyConfigured: boolean; missing: string[]; updatedAt: string | null;
  env: Record<'OPENAI_BASE_URL' | 'OPENAI_API_KEY' | 'OPENAI_MODEL' | 'OPENAI_TIMEOUT_MS', { value: string; configured: boolean; masked: boolean }>
}
export class EnterpriseAiStore {
  constructor(pool: DatabasePool, masterKey?: string)
  assertAdmin(organizationId: string | undefined, actorId: string, executor?: Queryable, lock?: boolean): Promise<string>
  get(organizationId: string | undefined): Promise<EnterpriseAiView>
  runtimeEnv(organizationId: string | undefined): Promise<Record<string, string>>
  save(organizationId: string | undefined, patch: unknown, actorId: string, requestId?: string): Promise<EnterpriseAiView>
}
