import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { HttpError } from '../http.js'
import { classifyUsageFailure, validateUsageFilters, type UsageFilters } from './ai-usage-diagnostics.js'
export interface UsageInput {
  organizationId: string; actorId: string; operation: 'job_spec' | 'jd'; resourceId: string
  key: string; input: unknown; model: string; requestId?: string
}
/** Reports expose metadata only. Protected task rows retain generated results for durable replay;
 * raw inputs, credentials and monetary amounts are not added to the ledger. */
export class AiUsageService {
  constructor(private readonly pool: Pool) {}
  async execute<T>(input: UsageInput, generate: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.key)) throw new HttpError(400,'INVALID_IDEMPOTENCY_KEY','操作标识无效，请刷新后重试')
    const allowed = (await this.pool.query(
      `SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=$1 AND m.user_id=$2 AND u.is_active AND organization_service_available($1::uuid)`,
      [input.organizationId,input.actorId])).rows[0]
    if (!allowed) throw new HttpError(409,'WORKSPACE_SERVICE_UNAVAILABLE','当前企业服务或成员资格不可用，未发起模型调用')
    const fingerprint=createHash('sha256').update(JSON.stringify([input.input,input.model])).digest('hex')
    const result=await this.pool.query(`INSERT INTO ai_usage_tasks(organization_id,actor_user_id,operation,resource_id,idempotency_key,fingerprint,model,request_id)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE organization_service_available($1::uuid)
      ON CONFLICT(organization_id,actor_user_id,operation,resource_id,idempotency_key) DO NOTHING RETURNING id`,
      [input.organizationId,input.actorId,input.operation,input.resourceId,input.key,fingerprint,input.model,input.requestId && /^[A-Za-z0-9._:-]{8,128}$/.test(input.requestId) ? input.requestId : null])
    if (!result.rows[0]) {
      const row=(await this.pool.query(`SELECT * FROM ai_usage_tasks WHERE organization_id=$1 AND actor_user_id=$2 AND operation=$3 AND resource_id=$4 AND idempotency_key=$5`,
        [input.organizationId,input.actorId,input.operation,input.resourceId,input.key])).rows[0]
      if (!row) throw new HttpError(409,'WORKSPACE_SERVICE_UNAVAILABLE','当前企业服务不可用，未发起模型调用')
      if (row.fingerprint!==fingerprint) throw new HttpError(409,'USAGE_KEY_CONFLICT','同一操作标识不能用于不同生成内容')
      if (row.state==='settled') return row.result as T
      throw new HttpError(409,'AI_USAGE_TASK_EXISTS',row.state==='released'?'此前操作未完成，请重新发起生成':'此操作正在处理或需要对账，请勿重复提交；可在 AI 用量中查看')
    }
    const taskId=result.rows[0].id
    const started=performance.now()
    let settling=false
    const elapsed=()=>Math.min(2147483647,Math.max(0,Math.round(performance.now()-started)))
    try {
      const value=await generate()
      settling=true
      const settlement = await this.pool.query(`UPDATE ai_usage_tasks SET state='settled',settled_units=1,result=$2::jsonb,finished_at=now(),duration_ms=$3 WHERE id=$1 AND state='reserved'`,[taskId,JSON.stringify(value),elapsed()])
      if (settlement.rowCount !== 1) throw new HttpError(409,'AI_USAGE_SETTLEMENT_FAILED','生成结果需对账，请勿重复提交')
      return value
    } catch(error) {
      // Explicit HTTP rejection means no successful generation. Timeout, malformed output or DB failure
      // may follow a provider charge: never claim these were refunded or silently invoke the model again.
      const rejected=error instanceof Error && 'code' in error && error.code==='MODEL_HTTP_ERROR'
      await this.pool.query(`UPDATE ai_usage_tasks SET state=$2,finished_at=now(),duration_ms=$3,failure_category=$4 WHERE id=$1 AND state='reserved'`,[taskId,rejected&&!settling?'released':'uncertain',elapsed(),classifyUsageFailure(error,settling)]).catch(() => undefined)
      // If recording the error also fails, retain the reservation for reconciliation and preserve
      // the original error. A retry with the same key still cannot dispatch another model call.
      throw error
    }
  }
  private async authorize(actorId:string,organizationId:string) {
    const member=(await this.pool.query(`SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id JOIN organizations o ON o.id=m.organization_id
      WHERE m.organization_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin') AND u.is_active AND o.status='active'`,[organizationId,actorId])).rows[0]
    if(!member)throw new HttpError(403,'WORKSPACE_ADMIN_REQUIRED','只有本企业所有者和管理员可以查看 AI 用量')
  }
  async read(actorId: string, organizationId: string, page=1, filters:UsageFilters={}) {
    if(!Number.isInteger(page)||page<1||page>100000)throw new HttpError(400,'VALIDATION_ERROR','页码无效')
    validateUsageFilters(filters)
    await this.authorize(actorId,organizationId)
    const params:unknown[]=[organizationId]
    const conditions=['organization_id=$1']
    for(const [field,value,operator] of [['operation',filters.operation,'='],['state',filters.state,'='],['created_at',filters.from,'>='],['created_at',filters.to,'<']] as const)if(value!==undefined){params.push(value);conditions.push(field+operator+'$'+params.length)}
    if(filters.reviewOnly)conditions.push("(state='uncertain' OR (state='reserved' AND created_at<=now()-interval '10 minutes'))")
    const where=conditions.join(' AND ')
    const summary=(await this.pool.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE state='settled')::int AS settled,
      count(*) FILTER(WHERE state='released')::int AS released,
      count(*) FILTER(WHERE state='reserved' AND created_at>now()-interval '10 minutes')::int AS reserved,
      count(*) FILTER(WHERE state='uncertain' OR (state='reserved' AND created_at<=now()-interval '10 minutes'))::int AS reconciliation
      FROM ai_usage_tasks WHERE organization_id=$1`,[organizationId])).rows[0]
    const filteredTotal=(await this.pool.query('SELECT count(*)::int AS total FROM ai_usage_tasks WHERE '+where,params)).rows[0].total
    const items=(await this.pool.query(`SELECT id,operation,model,state,settled_units AS "settledUnits",created_at AS "createdAt",finished_at AS "finishedAt",request_id AS "requestId",duration_ms AS "durationMs",failure_category AS "failureCategory",
      state='uncertain' OR (state='reserved' AND created_at<=now()-interval '10 minutes') AS "needsReconciliation",
      (SELECT count(*)::int FROM ai_usage_review_notes n WHERE n.task_id=ai_usage_tasks.id) AS "reviewCount"
      FROM ai_usage_tasks WHERE `+where+` ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET $`+(params.length+1),[...params,(page-1)*20])).rows
    return {billingSource:'customer_model',chargeAmount:null,unit:'successful_generation',scope:['job_spec','jd'],summary,items,page,pageSize:20,filteredTotal}
  }
  async reviewHistory(actorId:string,organizationId:string,taskId:string) {
    await this.authorize(actorId,organizationId)
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId))throw new HttpError(400,'VALIDATION_ERROR','调用编号无效')
    if(!(await this.pool.query('SELECT 1 FROM ai_usage_tasks WHERE id=$1 AND organization_id=$2',[taskId,organizationId])).rows[0])throw new HttpError(404,'NOT_FOUND','调用记录不存在')
    const items=(await this.pool.query(`SELECT n.id,n.outcome,n.note,n.created_at AS "createdAt",n.actor_user_id AS "actorId"
      FROM ai_usage_review_notes n JOIN ai_usage_tasks t ON t.id=n.task_id WHERE n.task_id=$1 AND t.organization_id=$2 ORDER BY n.created_at DESC,n.id DESC LIMIT 20`,[taskId,organizationId])).rows
    return {items,limit:20}
  }
  async addReview(actorId:string,organizationId:string,taskId:string,input:unknown) {
    const body=input as {key?:unknown;outcome?:unknown;note?:unknown}|null
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    if(!uuid.test(taskId)||!body||typeof body.key!=='string'||!uuid.test(body.key)||typeof body.outcome!=='string'||!['awaiting_provider','awaiting_result','evidence_recorded'].includes(body.outcome)||typeof body.note!=='string'||[...body.note.trim()].length<2||[...body.note.trim()].length>1000)throw new HttpError(400,'VALIDATION_ERROR','核对记录需填写有效类型、操作标识及 2–1000 字说明')
    const note=body.note.trim(),db=await this.pool.connect()
    try {
      await db.query('BEGIN')
      await db.query('SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE',[organizationId])
      const allowed=(await db.query(`SELECT 1 FROM organization_members m JOIN users u ON u.id=m.user_id
        WHERE m.organization_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin') AND u.is_active AND organization_service_available($1::uuid) FOR SHARE OF m,u`,[organizationId,actorId])).rows[0]
      if(!allowed)throw new HttpError(403,'WORKSPACE_ADMIN_REQUIRED','当前企业成员资格或服务不可用，无法保存核对记录')
      const task=(await db.query(`SELECT state,state='uncertain' OR (state='reserved' AND created_at<=now()-interval '10 minutes') AS review FROM ai_usage_tasks WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[taskId,organizationId])).rows[0]
      if(!task)throw new HttpError(404,'NOT_FOUND','调用记录不存在')
      const existing=(await db.query(`SELECT id,outcome,note,created_at AS "createdAt",actor_user_id AS "actorId" FROM ai_usage_review_notes WHERE task_id=$1 AND actor_user_id=$2 AND client_key=$3`,[taskId,actorId,body.key])).rows[0]
      if(existing){if(existing.outcome!==body.outcome||existing.note!==note)throw new HttpError(409,'REVIEW_KEY_CONFLICT','同一操作标识不能用于不同核对记录');await db.query('COMMIT');return {item:existing,replayed:true}}
      if(!task.review)throw new HttpError(409,'AI_REVIEW_NOT_REQUIRED','该调用当前不需要异常核对')
      const item=(await db.query(`INSERT INTO ai_usage_review_notes(task_id,actor_user_id,client_key,outcome,note) VALUES($1,$2,$3,$4,$5) RETURNING id,outcome,note,created_at AS "createdAt",actor_user_id AS "actorId"`,[taskId,actorId,body.key,body.outcome,note])).rows[0]
      await db.query('COMMIT');return {item,replayed:false}
    }catch(error){await db.query('ROLLBACK');throw error}finally{db.release()}
  }

}
export function usageKey(header: string | string[] | undefined, requestId: string) {
  return typeof header==='string'?header:requestId||randomUUID()
}
