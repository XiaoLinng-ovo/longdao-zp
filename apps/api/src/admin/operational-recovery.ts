import type { Pool } from 'pg'
import { HttpError } from '../http.js'

/** No external calls: this surface only lists state or records verified administrator decisions. */
export class OperationalRecoveryService {
  constructor(private readonly pool: Pool) {}
  async list() {
    const [cleanup,audio,refund]=await Promise.all([
      this.pool.query("SELECT id,organization_id,storage_kind,status,attempts,last_error,available_at,created_at,xmin::text AS recovery_version FROM public.object_cleanup_tasks WHERE status='failed' ORDER BY available_at LIMIT 200"),
      this.pool.query("SELECT id,organization_id,interview_id,status,progress,attempts,last_error,updated_at,xmin::text AS recovery_version FROM public.full_audio_transcription_tasks WHERE status IN ('unknown','failed') ORDER BY updated_at LIMIT 200"),
      this.pool.query("SELECT id,organization_id,status,refund_check_attempts,refund_next_check_at,refund_check_error,created_at FROM public.payment_orders WHERE status='refund_pending' ORDER BY refund_next_check_at NULLS FIRST LIMIT 200"),
    ])
    return {cleanup:cleanup.rows,audio:audio.rows,refund:refund.rows,
      audioLookup: { supported: false, reason: '现有转写接口没有持久任务编号或只读查结果能力；保持未知，不会重新提交识别。' } }
  }
  async resolve(kind: string,id: string,action: string,note: string,actorId: string,expectedVersion: string) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || note.trim().length<5 || note.length>2000)
      throw new HttpError(400,'VALIDATION_ERROR','请填写至少五个字符的核对依据')
    if (!(kind==='cleanup' && action==='retry') && !(kind==='audio' && action==='stop'))
      throw new HttpError(400,'VALIDATION_ERROR','不支持该恢复操作')
    if (typeof expectedVersion !== 'string' || !/^[0-9]{1,10}$/.test(expectedVersion))
      throw new HttpError(409,'RECOVERY_CONFLICT','缺少有效的任务版本，请刷新后重新核对')
    const db=await this.pool.connect()
    try {
      await db.query('BEGIN')
      const result=await db.query(kind==='cleanup'
        ? "UPDATE public.object_cleanup_tasks SET status='pending',attempts=0,lease_token=NULL,last_error=NULL,available_at=now() WHERE id=$1 AND status='failed' AND xmin::text=$2 RETURNING organization_id"
        : "UPDATE public.full_audio_transcription_tasks SET status='failed',attempts=GREATEST(attempts,3),inference_pending=true,last_error='系统管理员已核对并终止，禁止自动重试',updated_at=now() WHERE id=$1 AND status='unknown' AND lease_token IS NULL AND xmin::text=$2 RETURNING organization_id",[id,expectedVersion])
      if (!result.rows.length) throw new HttpError(409,'RECOVERY_CONFLICT','任务状态已经变化，请刷新后重新核对')
      await db.query("INSERT INTO public.platform_audit_logs(actor_user_id,organization_id,action,metadata) VALUES($1,$2,'operations.task.resolve',$3::jsonb)",[actorId,result.rows[0].organization_id,JSON.stringify({kind,id,action,note:note.trim(),expectedVersion})])
      await db.query('COMMIT')
      return {resolved:true}
    } catch(error) { await db.query('ROLLBACK').catch(()=>undefined); throw error }
    finally { db.release() }
  }
}
