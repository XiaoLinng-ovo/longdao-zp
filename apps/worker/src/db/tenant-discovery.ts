import type { Pool } from 'pg'

interface TenantRow {
  organization_id: string
  schema_name: string | null
  status: string | null
  structure_ready: boolean
  service_available: boolean
}

export async function discoverWorkerTenants(pool: Pick<Pool, 'query'>): Promise<{ organization_id: string; schema_name: string }[]> {
  const result = await pool.query<TenantRow>(
    `SELECT o.id AS organization_id,s.schema_name,s.status,
      public.organization_schema_structure_ready(o.id) AS structure_ready,
      public.organization_service_available(o.id) AS service_available
     FROM public.organizations o LEFT JOIN public.organization_schemas s ON s.organization_id=o.id
     WHERE o.status='active' ORDER BY o.id`,
  )
  const ready: { organization_id: string; schema_name: string }[] = []
  for (const row of result.rows) {
    const expected = 'company_' + row.organization_id.replaceAll('-', '').toLowerCase()
    if (!/^company_[a-f0-9]{32}$/.test(expected) || row.schema_name !== expected || row.status !== 'ready' || !row.structure_ready)
      throw new Error('公司 Schema 未就绪：' + row.organization_id)
    if (row.service_available) ready.push({ organization_id: row.organization_id, schema_name: row.schema_name })
  }
  return ready
}
