export function currentRuntimeSignal(): AbortSignal | undefined
export function combinedRuntimeSignal(signal?: AbortSignal | null): AbortSignal | undefined
export function runWithRuntimeSignal<T>(signal: AbortSignal, operation: () => T): T
export function runtimeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
export class ShutdownTimeoutError extends Error { readonly code: 'SHUTDOWN_TIMEOUT'; readonly pending: string[] }
export interface ShutdownBudget {
  readonly signal: AbortSignal
  run<T>(name: string, operation: () => Promise<T> | T): Promise<T>
  pending(): string[]
}
export function createShutdownBudget(timeoutMs: number, controller?: AbortController): ShutdownBudget
export function bindPoolCancellation<T>(pool: T, signal?: AbortSignal): T
