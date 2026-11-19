export interface ReadinessClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>
  release(error?: boolean): void
}
export interface ReadinessPool { connect(): Promise<ReadinessClient> }
export interface MigrationFile { version: string; name: string; path: string }
export function listMigrationFiles(directory: string): Promise<MigrationFile[]>
export function validateMigrationLedger(migrations: MigrationFile[], rows: { version: string; name: string }[]): void
export interface ReleaseReadinessOptions {
  migrationsDirectory: string
  tenantRouting: boolean
  storageLocations: { resume?: string | undefined; interview?: string | undefined }
}
export interface ReleaseReadinessResult { migrations: number; companies: number; knownStorageLocationsChecked: boolean }
export function assertReleaseReady(pool: ReadinessPool, options: ReleaseReadinessOptions): Promise<ReleaseReadinessResult>
