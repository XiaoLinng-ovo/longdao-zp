import type { Pool, PoolClient } from 'pg'
import { InvitationError } from './workspace-invitations.js'
import type { DashboardTodo } from '../recruiting/dashboard-todos.js'
import { requireReadyWorkspaceSchema } from './workspace-context.js'

const fail = (code: string, message: string, status=400): never => { throw new InvitationError(code,message,status) }
const reasonOf = (value: unknown) => {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (reason.length<2 || reason.length>500) fail('VALIDATION_ERROR','请填写 2 到 500 字的操作原因')
  return reason
}
export class WorkspaceOffboardingService {
  constructor(private pool: Pool, private routeSchemas=process.env.TENANT_SCHEMA_ROUTING==='on') {}
  private async transaction<T>(action: (db: PoolClient)=>Promise<T>) {
    const db=await this.pool.connect()
    try { await db.query('BEGIN'); const result=await action(db); await db.query('COMMIT'); return result }
    catch(error) { await db.query('ROLLBACK'); throw error }
    finally { db.release() }
  }
  private async member(db: Pool | PoolClient, organizationId: string, userId: string) {
    const result=await db.query('SELECT role,is_active FROM public.organization_members WHERE organization_id=$1 AND user_id=$2 AND ended_at IS NULL',[organizationId,userId])
    if (!result.rows[0]) fail('FORBIDDEN','你不属于此企业',403)
    return result.rows[0]!
  }
  private async admin(db: Pool | PoolClient, organizationId: string, actorId: string) {
    const member=await this.member(db,organizationId,actorId)
    if (!member.is_active || !['owner','admin'].includes(member.role)) fail('FORBIDDEN','仅企业管理员可办理退出',403)
    return member.role as string
  }
  async list(organizationId: string, actorId: string) {
    const member=await this.member(this.pool,organizationId,actorId)
    const admin=member.is_active && ['owner','admin'].includes(member.role)
    return (await this.pool.query(`SELECT r.*,u.display_name AS name FROM public.organization_exit_requests r JOIN public.users u ON u.id=r.user_id JOIN public.organization_members m ON m.organization_id=r.organization_id AND m.user_id=r.user_id
      WHERE r.organization_id=$1 AND ($2::boolean OR r.user_id=$3) AND r.status='pending' AND ($4::text='owner' OR r.user_id=$3 OR m.role='member') ORDER BY r.created_at`,[organizationId,admin,actorId,member.role])).rows
  }
  async todos(organizationId: string, actorId: string): Promise<DashboardTodo[]> {
    const role=await this.member(this.pool,organizationId,actorId)
    if (!role.is_active || !['owner','admin'].includes(role.role)) return []
    const rows=await this.list(organizationId,actorId)
    return rows.filter(row=>row.user_id!==actorId).map(row=>({id:'exit-'+row.id,category:'membership',title:'成员退出申请待处理',description:row.name+' · '+row.reason,actionLabel:'办理退出',path:'/workspaces',updatedAt:new Date(row.created_at).toISOString(),ownerUserIds:[actorId]}))
  }
  async request(organizationId: string, userId: string, input: Record<string,unknown>) {
    if (Object.keys(input).some(key=>key!=='reason')) fail('VALIDATION_ERROR','退出申请仅支持填写原因')
    const reason=reasonOf(input.reason)
    return this.transaction(async db=>{
      await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR UPDATE',[organizationId])
      const member=await this.member(db,organizationId,userId)
      if (member.role==='owner') fail('OWNERSHIP_TRANSFER_REQUIRED','请先交接主管理员身份；唯一成员请联系平台办理企业关闭',409)
      const row=(await db.query(`INSERT INTO public.organization_exit_requests(organization_id,user_id,reason) VALUES($1,$2,$3)
        ON CONFLICT (organization_id,user_id) WHERE status='pending' DO UPDATE SET reason=excluded.reason RETURNING *`,[organizationId,userId,reason])).rows[0]
      await db.query(`INSERT INTO public.recruitment_notifications(organization_id,user_id,task_key,event_key,kind,title,description,path)
        SELECT $1,m.user_id,'exit-'||$3::text,'exit-'||$3::text,'todo','成员退出申请待处理',$4,'/workspaces'
        FROM public.organization_members m WHERE m.organization_id=$1 AND m.user_id<>$2 AND m.is_active AND (m.role='owner' OR (m.role='admin' AND $5::text='member'))
        ON CONFLICT(organization_id,user_id,event_key) DO NOTHING`,[organizationId,userId,row.id,reason,member.role])
      return row
    })
  }
  async resolve(organizationId: string, actorId: string, userId: string, input: Record<string,unknown>) {
    if (Object.keys(input).some(key=>!['reason','replacementId','reject'].includes(key)) || (input.reject!==undefined && typeof input.reject!=='boolean')) fail('VALIDATION_ERROR','退出办理参数无效')
    const reason=reasonOf(input.reason)
    return this.transaction(async db=>{
      await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR UPDATE',[organizationId])
      const role=await this.admin(db,organizationId,actorId)
      const target=await this.member(db,organizationId,userId)
      if (actorId===userId || target.role==='owner' || (role!=='owner' && target.role!=='member')) fail('FORBIDDEN','不能移除自己或主管理员；子管理员只能办理普通成员退出',403)
      await db.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE',[userId])
      if (input.reject===true) {
        const result=await db.query("UPDATE public.organization_exit_requests SET status='rejected',resolved_at=now(),resolved_by=$3,resolution=$4 WHERE organization_id=$1 AND user_id=$2 AND status='pending' RETURNING id",[organizationId,userId,actorId,reason])
        if (!result.rows.length) fail('NOT_FOUND','退出申请不存在',404)
      } else {
        const replacementId=typeof input.replacementId==='string' ? input.replacementId : actorId
        if (replacementId===userId) fail('VALIDATION_ERROR','接收人不能是退出成员')
        const replacement=await this.member(db,organizationId,replacementId)
        const account=(await db.query('SELECT display_name FROM public.users WHERE id=$1 AND is_active',[replacementId])).rows[0]
        if (!replacement.is_active || !account) fail('VALIDATION_ERROR','接收人必须是本企业正常成员')
        const schema=this.routeSchemas ? await requireReadyWorkspaceSchema(db,organizationId) : 'public'
        const schemas=[schema]
        if (schema!=='public' && !(await db.query('SELECT public.read_company_data_cutover($1::uuid) AS cutover',[organizationId])).rows[0]?.cutover) schemas.push('public')
        const snapshots: unknown[]=[]
        for (const name of schemas) {
          // Preserve completed interview transcripts and scores; only transfer outstanding responsibility.
          const interviews=await db.query(`SELECT id,participants FROM "`+name+`".interviews WHERE organization_id=$1 AND status<>'cancelled' AND (status<>'completed' OR EXISTS(SELECT 1 FROM "`+name+`".interview_question_sheets q WHERE q.application_id=interviews.application_id AND q.stage=interviews.stage AND q.status<>'locked')) AND participants @> $2::jsonb FOR UPDATE`,[organizationId,JSON.stringify([{userId}])])
          for (const interview of interviews.rows) {
            const people=interview.participants as Record<string,any>[]
            const departing=people.find(person=>person.userId===userId)!
            const present=people.find(person=>person.userId===replacementId)
            const moved={...departing,...present,userId:replacementId,name:account.display_name,role:departing.role==='interviewer' ? 'interviewer' : present?.role ?? departing.role,
              lead:!!(departing.lead || present?.lead),sheetTypes:[...new Set([...(departing.sheetTypes ?? []),...(present?.sheetTypes ?? [])])]}
            const participants=[...people.filter(person=>person.userId!==userId && person.userId!==replacementId),moved]
            await db.query(`UPDATE "`+name+`".interviews SET participants=$3::jsonb,updated_at=now() WHERE id=$1 AND organization_id=$2`,[interview.id,organizationId,JSON.stringify(participants)])
            if (name===schema) snapshots.push({id:interview.id,participants:people})
          }
          await db.query(`UPDATE "`+name+`".applications SET recruiter_id=$3,updated_at=now() WHERE organization_id=$1 AND recruiter_id=$2 AND status NOT IN ('rejected','offer_declined','offer_cancelled','offer_expired','onboarding_archived')`,[organizationId,userId,replacementId])
          await db.query(`UPDATE "`+name+`".jobs SET hiring_manager_names=$3,updated_at=now() WHERE organization_id=$1 AND hiring_manager_names=$2 AND status IN ('draft','ready','published')`,[organizationId,userId,replacementId])
          await db.query(`UPDATE "`+name+`".recruitment_requests SET requested_by=$3,updated_at=now() WHERE organization_id=$1 AND requested_by=$2 AND status IN ('draft','pending_approval','approved')`,[organizationId,userId,replacementId])
        }
        const auditInsert=`INSERT INTO "`+schema+`".audit_logs(organization_id,actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'workspace.member.depart','organization_member',$3,$4::jsonb)`
        const columns='id,organization_id,actor_user_id,action,resource_type,resource_id,request_id,ip_address,user_agent,metadata,created_at'
        const auditSql=schemas.length===1 ? auditInsert : `WITH inserted AS (`+auditInsert+` RETURNING *) INSERT INTO public.audit_logs(`+columns+`) SELECT `+columns+` FROM inserted`
        await db.query(auditSql,[organizationId,actorId,userId,JSON.stringify({reason,replacementId,interviews:snapshots})])
        await db.query(`INSERT INTO public.organization_membership_history(organization_id,user_id,role,joined_at,ended_at,actor_user_id,reason)
          SELECT organization_id,user_id,role,joined_at,now(),$3,$4 FROM public.organization_members WHERE organization_id=$1 AND user_id=$2 AND ended_at IS NULL`,[organizationId,userId,actorId,reason])
        await db.query('UPDATE public.organization_members SET is_active=false,ended_at=now() WHERE organization_id=$1 AND user_id=$2',[organizationId,userId])
        await db.query("UPDATE public.organization_exit_requests SET status='completed',resolved_at=now(),resolved_by=$3,resolution=$4 WHERE organization_id=$1 AND user_id=$2 AND status='pending'",[organizationId,userId,actorId,reason])
        await db.query('UPDATE public.recruitment_user_tasks SET active=false WHERE organization_id=$1 AND user_id=$2',[organizationId,userId])
        await db.query("UPDATE public.recruitment_notifications SET state='cancelled' WHERE organization_id=$1 AND user_id=$2 AND state='active'",[organizationId,userId])
      }
      await db.query(`UPDATE public.recruitment_notifications SET state='resolved' WHERE organization_id=$1 AND task_key IN
        (SELECT 'exit-'||id::text FROM public.organization_exit_requests WHERE organization_id=$1 AND user_id=$2 AND status<>'pending')`,[organizationId,userId])
      await db.query("INSERT INTO public.platform_audit_logs(actor_user_id,organization_id,action,metadata) VALUES($1,$2,$3,$4::jsonb)",[actorId,organizationId,input.reject===true ? 'workspace.exit.rejected' : 'workspace.exit.completed',JSON.stringify({userId,reason})])
      return {ok:true}
    })
  }
}
