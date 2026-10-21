import type { Pool } from 'pg'
import { HttpError } from '../http.js'
import { PlatformService } from './service.js'
const id = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new HttpError(400, 'VALIDATION_ERROR', '无效 ID')
  return value
}
export function validatePlan(input: Record<string, unknown>) {
  if (Object.keys(input).some(k => !['code','version','name','seatLimit','jobLimit','reason'].includes(k))) throw new HttpError(400,'VALIDATION_ERROR','存在不支持的套餐字段')
  if (typeof input.code !== 'string' || !/^[a-z][a-z0-9_-]{1,39}$/u.test(input.code) || input.code === 'legacy') throw new HttpError(400,'VALIDATION_ERROR','套餐编码需为 2～40 位小写英文、数字或下划线，不可使用 legacy')
  if (!Number.isSafeInteger(input.version) || Number(input.version)<1 || Number(input.version)>1000000) throw new HttpError(400,'VALIDATION_ERROR','版本号需为正整数')
  if (typeof input.name !== 'string' || input.name.trim().length<2 || input.name.trim().length>80) throw new HttpError(400,'VALIDATION_ERROR','套餐名称需为 2～80 字')
  for (const k of ['seatLimit','jobLimit']) if (!Number.isSafeInteger(input[k]) || Number(input[k])<1 || Number(input[k])>1000000) throw new HttpError(400,'VALIDATION_ERROR','席位和岗位容量需为 1～1000000 的整数')
  return {code:input.code,version:input.version as number,name:input.name.trim(),seatLimit:input.seatLimit as number,jobLimit:input.jobLimit as number,reason:reason(input.reason)}
}
function reason(value: unknown) {
  if (typeof value !== 'string' || value.trim().length<2 || value.trim().length>500) throw new HttpError(400,'VALIDATION_ERROR','请填写 2～500 字的操作原因')
  return value.trim()
}
const planView = (r: any) => ({id:r.id,code:r.code,version:Number(r.version),name:r.name,seatLimit:r.seat_limit===null?null:Number(r.seat_limit),jobLimit:r.job_limit===null?null:Number(r.job_limit)})
const summarySql = `SELECT o.entitlement_version,o.seat_usage,o.job_usage,p.*,
 organization_service_available(o.id) AS available FROM organizations o JOIN subscription_plan_versions p ON p.id=o.plan_version_id`
const summaryView = (r: any) => ({plan:planView(r),entitlementVersion:Number(r.entitlement_version),seats:{used:Number(r.seat_usage),limit:r.seat_limit},jobs:{used:Number(r.job_usage),limit:r.job_limit},serviceAvailable:Boolean(r.available)})
export class EntitlementService {
  private readonly access: PlatformService
  constructor(private readonly pool: Pool) {this.access=new PlatformService(pool)}
  async listPlans(actorId: string) {
    await this.access.requireAccess(actorId)
    return (await this.pool.query('SELECT * FROM subscription_plan_versions ORDER BY code,version DESC')).rows.map(planView)
  }
  async publish(actorId: string,input: Record<string,unknown>,requestId?: string) {
    const data=validatePlan(input),db=await this.pool.connect()
    try {
      await db.query('BEGIN');await this.access.requireAccess(actorId,true,db,true)
      const result=await db.query(`INSERT INTO subscription_plan_versions(code,version,name,seat_limit,job_limit) VALUES($1,$2,$3,$4,$5) ON CONFLICT(code,version) DO NOTHING RETURNING *`,[data.code,data.version,data.name,data.seatLimit,data.jobLimit])
      if (!result.rows[0]) throw new HttpError(409,'PLAN_VERSION_EXISTS','此套餐版本已发布，请使用新版本号；已有客户权益不会自动变更')
      const plan=planView(result.rows[0])
      await db.query(`INSERT INTO platform_audit_logs(actor_user_id,action,request_id,metadata) VALUES($1,'platform.plan.publish',$2,$3::jsonb)`,[actorId,requestId??null,JSON.stringify({reason:data.reason,plan})])
      await db.query('COMMIT');return plan
    } catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
  }
  async readPlatform(actorId: string,organizationId: string) {
    await this.access.requireAccess(actorId)
    return this.read(id(organizationId))
  }
  async readEnterprise(actorId: string,organizationId: string) {
    // No global role fallback, and no implicit platform membership.
    const result=await this.pool.query(`SELECT m.user_id FROM organization_members m JOIN organizations o ON o.id=m.organization_id JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND u.is_active=true AND o.status='active'`,[id(organizationId),actorId])
    if (!result.rows[0]) throw new HttpError(403,'WORKSPACE_MEMBER_REQUIRED','只能查看你所属企业的套餐权益')
    return this.read(organizationId)
  }
  private async read(organizationId: string) {
    const row=(await this.pool.query(summarySql+' WHERE o.id=$1',[organizationId])).rows[0]
    if (!row) throw new HttpError(404,'NOT_FOUND','企业不存在')
    return summaryView(row)
  }
  async assign(actorId: string,organizationId: string,input: Record<string,unknown>,requestId?: string) {
    id(organizationId)
    if (Object.keys(input).some(k=>!['planVersionId','expectedVersion','reason'].includes(k)) || typeof input.planVersionId!=='string' || !Number.isSafeInteger(input.expectedVersion) || Number(input.expectedVersion)<1) throw new HttpError(400,'VALIDATION_ERROR','缺少有效套餐或权益版本，请刷新后重试')
    id(input.planVersionId);const note=reason(input.reason),db=await this.pool.connect()
    try {
      await db.query('BEGIN');await this.access.requireAccess(actorId,true,db,true)
      const org=(await db.query('SELECT * FROM organizations WHERE id=$1 FOR NO KEY UPDATE',[organizationId])).rows[0]
      if (!org) throw new HttpError(404,'NOT_FOUND','企业不存在')
      if (org.status!=='active') throw new HttpError(409,'WORKSPACE_ARCHIVED','归档企业不能变更套餐')
      if (Number(org.entitlement_version)!==input.expectedVersion) throw new HttpError(409,'VERSION_CONFLICT','企业权益已被修改，请刷新后重试')
      const plan=(await db.query('SELECT * FROM subscription_plan_versions WHERE id=$1',[input.planVersionId])).rows[0]
      if (!plan) throw new HttpError(404,'PLAN_NOT_FOUND','套餐版本不存在')
      if ((plan.seat_limit!==null && org.seat_usage>plan.seat_limit)||(plan.job_limit!==null && org.job_usage>plan.job_limit)) throw new HttpError(409,'PLAN_CAPACITY_BELOW_USAGE','目标套餐容量低于当前用量，请先整理成员或岗位，不会自动删除客户数据')
      await db.query('UPDATE organizations SET plan_version_id=$2,entitlement_version=entitlement_version+1 WHERE id=$1',[organizationId,plan.id])
      await db.query(`INSERT INTO platform_audit_logs(actor_user_id,organization_id,action,request_id,metadata) VALUES($1,$2,'platform.customer.entitlements',$3,$4::jsonb)`,[actorId,organizationId,requestId??null,JSON.stringify({reason:note,before:{planVersionId:org.plan_version_id,version:org.entitlement_version},after:{planVersionId:plan.id,version:Number(org.entitlement_version)+1},usage:{seats:org.seat_usage,jobs:org.job_usage}})])
      const row=(await db.query(summarySql+' WHERE o.id=$1',[organizationId])).rows[0]
      await db.query('COMMIT');return summaryView(row)
    }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
  }
}
