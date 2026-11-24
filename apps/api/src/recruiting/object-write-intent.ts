import type { Pool, PoolClient } from 'pg'
import { currentTenantContext, organizationSchemaName } from '../db/tenant-context.js'
import type { RepositoryQueryExecutor } from './repositories/types.js'

export function objectTenantSchema(organizationId: string, actualSchema: string): string {
  const tenant = currentTenantContext()
  if (tenant ? tenant.organizationId !== organizationId || tenant.schemaName !== actualSchema
    : actualSchema !== 'public' || process.env.TENANT_SCHEMA_ROUTING === 'on') throw new Error('INVALID_OBJECT_TENANT')
  if (actualSchema !== 'public' && actualSchema !== organizationSchemaName(organizationId)) throw new Error('INVALID_OBJECT_TENANT')
  return actualSchema
}

export async function objectTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await action(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
}

export async function recordObjectWriteFailure(executor: RepositoryQueryExecutor, attempt: string, acknowledged: boolean): Promise<void> {
  // A rejected or interrupted PUT can still complete remotely. Expiry alone never authorizes deletion.
  if (!acknowledged) {
    await executor.query("UPDATE public.object_write_intents SET status='unknown',updated_at=now() WHERE attempt_id=$1 AND status='writing'", [attempt])
    return
  }
  // An ambiguous commit is safe: a committed binding no longer matches this condition.
  await executor.query(
    "WITH ready AS (UPDATE public.object_write_intents SET status='cleanup_pending',updated_at=now() WHERE attempt_id=$1 AND status IN ('writing','unknown') RETURNING *) " +
    'INSERT INTO public.object_cleanup_tasks(organization_id,storage_key,schema_name,storage_kind,storage_location_id) ' +
    'SELECT organization_id,storage_key,schema_name,storage_kind,location_id FROM ready ON CONFLICT (organization_id,storage_key) DO NOTHING', [attempt])
}
