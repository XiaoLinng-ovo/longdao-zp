import type { Pool } from 'pg'
import { organizationSchemaName, runWithTenantContext } from './tenant-context.js'

/** Shared service instances keep concurrency bounded across all enterprises. */
export function tenantBackgroundService<T extends object, K extends keyof T>(service: T, method: K, registry: Pool): T {
  return new Proxy(service, {
    get(target, key, receiver) {
      if (key !== method || process.env.TENANT_SCHEMA_ROUTING !== 'on') return Reflect.get(target, key, receiver)
      return async (...args: unknown[]) => {
        const result = await registry.query<{ organization_id: string; schema_name: string }>(
          `SELECT s.organization_id,s.schema_name FROM public.organization_schemas s
            WHERE s.status='ready' AND public.organization_service_available(s.organization_id)
            ORDER BY s.organization_id`,
        )
        let last: unknown = false
        for (const row of result.rows) {
          if (row.schema_name !== organizationSchemaName(row.organization_id)) throw new Error('INVALID_TENANT_SCHEMA')
          last = await runWithTenantContext({ organizationId: row.organization_id, schemaName: row.schema_name },
            () => (Reflect.get(target, method) as (...input: unknown[]) => unknown).apply(target, args))
          if (last && (typeof last !== 'object' || (last as { processed?: boolean }).processed)) return last
        }
        return last
      }
    },
  })
}
