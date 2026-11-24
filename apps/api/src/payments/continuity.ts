import type { PoolClient } from 'pg'
import { HttpError } from '../http.js'
import { organizationSchemaName } from '../db/tenant-context.js'

export const serviceRequestView = (row: Record<string, any>) => ({
  id: row.id, organizationId: row.organization_id, organizationName: row.organization_name,
  message: row.message, status: row.status, response: row.response,
  createdAt: row.created_at, resolvedAt: row.resolved_at, updatedAt: row.updated_at,
})
export function serviceMessage(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 2000)
    throw new HttpError(400, 'VALIDATION_ERROR', '请填写 2～2000 字内容')
  return value.trim()
}

// Explicit, read-only projection. Never route an expired member into arbitrary recruiting APIs.
export async function readContinuityData(db: PoolClient, org: string, limit: number, env: NodeJS.ProcessEnv) {
  let schema = 'public'
  if (env.TENANT_SCHEMA_ROUTING === 'on') {
    const registry = (await db.query('SELECT schema_name,status FROM public.organization_schemas WHERE organization_id=$1', [org])).rows[0]
    schema = organizationSchemaName(org)
    if (!registry || registry.status !== 'ready' || registry.schema_name !== schema)
      throw new HttpError(503, 'WORKSPACE_SCHEMA_UNAVAILABLE', '企业数据尚未就绪，请联系系统管理员')
  }
  // schema is either a constant or derived solely from a validated UUID, checked against the registry.
  const stats = (await db.query(`SELECT
    (SELECT count(*)::int FROM "${schema}".jobs WHERE organization_id=$1) AS jobs,
    (SELECT count(*)::int FROM "${schema}".applications WHERE organization_id=$1) AS applications,
    (SELECT count(*)::int FROM "${schema}".interviews WHERE organization_id=$1) AS interviews`, [org])).rows[0]
  const jobs = (await db.query(`SELECT id,job_no,title,status,headcount,created_at,updated_at
    FROM "${schema}".jobs WHERE organization_id=$1 ORDER BY created_at DESC,id LIMIT $2`, [org, limit])).rows.map(row => ({
      id: row.id, jobNo: row.job_no, title: row.title, status: row.status, headcount: row.headcount,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }))
  return { stats, jobs, limit, truncated: Number(stats.jobs) > jobs.length }
}

export function continuityCsv(jobs: Awaited<ReturnType<typeof readContinuityData>>['jobs']): string {
  const cell = (value: unknown) => {
    let text = value instanceof Date ? value.toISOString() : String(value ?? '')
    if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text
    return '"' + text.replaceAll('"', '""') + '"'
  }
  return '\uFEFF' + [
    ['岗位编号', '岗位名称', '状态', '招聘人数', '创建时间', '更新时间'],
    ...jobs.map(job => [job.jobNo, job.title, job.status, job.headcount, job.createdAt, job.updatedAt]),
  ].map(row => row.map(cell).join(',')).join('\r\n')
}
