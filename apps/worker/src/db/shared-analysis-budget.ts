import type { PgClient } from './analysis-task-store.js'

export interface SharedAnalysisBudget { platform: number; workspace: number }
export function loadSharedAnalysisBudget(env: NodeJS.ProcessEnv = process.env): SharedAnalysisBudget {
  const limit = (key: string, fallback: number) => {
    const value = Number(env[key] ?? fallback)
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error(key + ' 必须在 1 到 100 之间')
    return value
  }
  return {platform:limit('WORKER_SHARED_CONCURRENCY',4),workspace:limit('WORKER_WORKSPACE_CONCURRENCY',2)}
}

/** Must run in the same transaction as task claim and lease insertion. */
export async function reserveSharedAnalysisSlot(db: PgClient, budget: SharedAnalysisBudget, now: string, maxAttempts: number): Promise<string | undefined> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('smartrecruit:analysis-execution-budget'))")
  await db.query('DELETE FROM public.analysis_execution_leases WHERE expires_at<=$1::timestamptz',[now])
  await db.query("UPDATE analysis_tasks SET status='failed',completed_at=$1,last_error='解析租约过期且重试次数已耗尽，请核对后重试' WHERE status IN ('queued','processing') AND attempts>=$2 AND available_at<=$1::timestamptz",[now,maxAttempts])
  const candidates=await db.query<{organization_id:string;schema_name:string}>(
    "SELECT DISTINCT t.organization_id,current_schema() AS schema_name FROM analysis_tasks t JOIN resumes r ON r.id=t.resume_id AND r.organization_id=t.organization_id WHERE t.status IN ('queued','processing') AND t.available_at<=$1::timestamptz AND t.attempts<$2 AND r.scan_status='clean' AND public.organization_service_available(t.organization_id)",[now,maxAttempts])
  if (!candidates.rows.length) {
    await db.query('UPDATE public.analysis_dispatch_states SET waiting_until=$1::timestamptz WHERE schema_name=current_schema()',[now])
    return undefined
  }
  const organizations=candidates.rows.map(row=>row.organization_id)
  await db.query('UPDATE public.analysis_dispatch_states SET waiting_until=$1::timestamptz WHERE schema_name=current_schema() AND NOT (organization_id=ANY($2::uuid[]))',[now,organizations])
  await db.query("INSERT INTO public.analysis_dispatch_states(organization_id,schema_name,waiting_until) SELECT id,current_schema(),$2::timestamptz+interval '30 seconds' FROM unnest($1::uuid[]) AS id ON CONFLICT(organization_id) DO UPDATE SET schema_name=excluded.schema_name,waiting_until=excluded.waiting_until",[organizations,now])
  const capacity=await db.query<{allowed:boolean}>(
    'SELECT count(*)<$1 AS allowed FROM public.analysis_execution_leases WHERE expires_at>$2::timestamptz',[budget.platform,now])
  if (!capacity.rows[0]?.allowed) return undefined
  const fair=await db.query<{organization_id:string}>(
    'SELECT s.organization_id FROM public.analysis_dispatch_states s WHERE s.waiting_until>$1::timestamptz AND (SELECT count(*) FROM public.analysis_execution_leases l WHERE l.organization_id=s.organization_id AND l.expires_at>$1::timestamptz)<$2 ORDER BY s.last_claimed_at NULLS FIRST,s.organization_id LIMIT 1',[now,budget.workspace])
  const selected=fair.rows[0]?.organization_id
  return selected && organizations.includes(selected) ? selected : undefined
}
