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
export type BillingResource = 'ai_points' | 'interview_seconds' | 'ocr_pages'
export type BillingOperation = 'resume_analysis' | 'job_spec' | 'jd' | 'interview_questions' | 'answer_analysis' | 'interview_summary' | 'transcript_processing' | 'interview_audio' | 'ocr'
export interface BillingRule { enabled: boolean; resource: BillingResource; quantity: number; unitSize: number }
export interface BillingPolicy {
  enabled: boolean; rules: Record<BillingOperation, BillingRule>;
  limits: { maxConcurrent: number; dailyAiPoints: number; maxInputChars: number; maxOutputTokens: number };
  trial: { durationDays: number; seatLimit: number; jobLimit: number; resumeUploads: number; interviews: number; aiGenerations: number; aiPoints: number; interviewSeconds: number; ocrPages: number };
}
export interface BillingEntitlements { quotas: Record<BillingResource, number>; grantPeriod: 'once' | 'monthly'; rollover: boolean }
export interface BillingTicket { id?: string; units?: number; version?: string; bypassed?: boolean; replayed?: boolean; result?: unknown }
export interface BillingInput { organizationId: string; operation: BillingOperation; key: string; amount?: number; fingerprint?: unknown; audio?: {sessionId:string;startMs:number;endMs:number} }
export const BILLING_OPERATIONS: BillingOperation[]
export const BILLING_RESOURCES: BillingResource[]
export function validateBillingPolicy(value: unknown): BillingPolicy
export function validateBillingEntitlements(value: unknown): BillingEntitlements
export class BillingStore {
  constructor(pool: DatabasePool)
  policy(db?: Queryable): Promise<{ version: string; config: BillingPolicy; createdAt: unknown }>
  ensureTrialGrants(organizationId: string, db: Queryable, policy: {version:string;config:BillingPolicy}): Promise<void>
  reserve(input: BillingInput): Promise<BillingTicket>
  finish(id: string | undefined, state: 'settled' | 'released' | 'uncertain', result?: unknown): Promise<void>
  execute<T>(input: BillingInput, action: () => Promise<T>): Promise<T>
  balance(organizationId: string, db?: Queryable): Promise<{ resources: Record<string, unknown>[]; tasks: Record<string, unknown>[]; grants: Record<string, unknown>[] }>
}
export type ExecutionChannel = 'interactive' | 'background' | 'audio'
export function isExecutionBusy(error: unknown): boolean
export interface ExecutionStatus { enabled: boolean; text: {active:number;limit:number;reservedInteractive:number}; audio:{active:number;limit:number}; realtime:{active:number;limit:number} }
export function readExecutionStatus(db:Queryable,organizationId:string,maxConcurrent:number,env?:Record<string,string|undefined>):Promise<ExecutionStatus>
export function meterAiOperation<T>(env: Record<string, string | undefined>, operation: BillingOperation, key: string, input: unknown, action: () => Promise<T>, amount?: number, channel?: ExecutionChannel): Promise<T>
export function createBillingFetch(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): typeof fetch
export function meterOcrOperation<T>(env: Record<string, string | undefined>, content: Uint8Array, pages: number[] | undefined, action: () => Promise<T>): Promise<T>

export function bindBillingEnv<T extends Record<string,string|undefined>>(env:T,pool:DatabasePool,organizationId:string):T
export function meterInterviewAudio<T>(env:Record<string,string|undefined>,key:string,audio:{sessionId:string;startMs:number;endMs:number},action:()=>Promise<T>,channel?:'audio'|'realtime'):Promise<T>
export function coveredMilliseconds(ranges:number[][]):number
