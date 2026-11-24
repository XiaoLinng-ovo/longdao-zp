import { HttpError } from '../http.js'
import { organizationSchemaName } from '../db/tenant-context.js'
import type { RepositoryQueryExecutor } from './repositories/types.js'
import { loadResumeUploadLimits } from './upload-admission.js'

export async function analysisQueueDepth(db: RepositoryQueryExecutor, organizationId: string, routed = process.env.TENANT_SCHEMA_ROUTING === 'on') {
  const schemas: { organization_id: string; schema_name: string }[] = routed
    ? (await db.query<{ organization_id: string; schema_name: string }>('SELECT organization_id,schema_name FROM public.organization_schemas WHERE status=\'ready\'')).rows : []
  for (const row of schemas) if (row.schema_name !== organizationSchemaName(row.organization_id)) throw new Error('INVALID_TENANT_SCHEMA')
  // Ignore legacy public copies only for enterprises that have an active company schema.
  const publicRows = await db.query<{ total: number; workspace: number }>(
    `SELECT count(*)::int AS total,count(*) FILTER(WHERE organization_id=$1::uuid)::int AS workspace
     FROM public.analysis_tasks WHERE status IN ('queued','processing') AND NOT(organization_id=ANY($2::uuid[]))`,
    [organizationId, schemas.map(row => row.organization_id)],
  )
  const depth = { total: Number(publicRows.rows[0]?.total ?? 0), workspace: Number(publicRows.rows[0]?.workspace ?? 0) }
  for (const row of schemas) {
    const result = await db.query<{ total: number; workspace: number }>(
      `SELECT count(*)::int AS total,count(*) FILTER(WHERE organization_id=$1::uuid)::int AS workspace FROM "${row.schema_name}".analysis_tasks WHERE status IN ('queued','processing')`, [organizationId],
    )
    depth.total += Number(result.rows[0]?.total ?? 0)
    depth.workspace += Number(result.rows[0]?.workspace ?? 0)
  }
  return depth
}

/** The caller must insert/requeue on this same transaction before releasing the lock. */
export async function reserveAnalysisCapacity(db: RepositoryQueryExecutor, organizationId: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('smartrecruit:analysis-capacity'))")
  const depth = await analysisQueueDepth(db, organizationId), limits = loadResumeUploadLimits()
  if (depth.total >= limits.queueLimit || depth.workspace >= limits.workspaceQueueLimit) {
    throw new HttpError(429, 'RESUME_ANALYSIS_QUEUE_FULL', '简历解析队列已满，请稍后重试', { retryable: true, retryAfterSeconds: 10 })
  }
}
