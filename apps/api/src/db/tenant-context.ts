import { AsyncLocalStorage } from 'node:async_hooks'

export interface TenantContext {
  organizationId: string
  schemaName: string
}

const tenantStorage = new AsyncLocalStorage<TenantContext>()
const schemaPattern = /^company_[0-9a-f]{32}$/

export function organizationSchemaName(organizationId: string): string {
  const normalized = organizationId.toLowerCase().replaceAll('-', '')
  if (!/^[0-9a-f]{32}$/.test(normalized)) throw new Error('INVALID_ORGANIZATION_ID')
  return `company_${normalized}`
}

export function currentTenantContext(): TenantContext | undefined {
  return tenantStorage.getStore()
}

export function runWithTenantContext<T>(context: TenantContext, operation: () => T): T {
  if (!schemaPattern.test(context.schemaName) || context.schemaName !== organizationSchemaName(context.organizationId)) {
    throw new Error('INVALID_TENANT_SCHEMA')
  }
  return tenantStorage.run(context, operation)
}
