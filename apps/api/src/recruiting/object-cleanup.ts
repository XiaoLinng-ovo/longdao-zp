import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import { organizationSchemaName } from '../db/tenant-context.js'
import { objectTransaction } from './object-write-intent.js'

export function cleanupRetryDelaySeconds(attempt: number, random = Math.random): number {
  return Math.min(3600, Math.ceil(Math.min(3600, 10 * 2 ** Math.min(12, Math.max(0, attempt - 1))) * (0.8 + 0.4 * random())))
}

export class ObjectCleanupService {
  constructor(private readonly pool: Pool, private readonly storage: ObjectStorage, private readonly interviewStorage?: ObjectStorage) {}

  async processPending(): Promise<boolean> {
    // Expired writes are evidence for reconciliation, not permission to delete.
    await this.pool.query("UPDATE public.object_write_intents SET status='unknown',updated_at=now() WHERE attempt_id IN (SELECT attempt_id FROM public.object_write_intents WHERE status='writing' AND lease_until<=now() ORDER BY lease_until,attempt_id FOR UPDATE SKIP LOCKED LIMIT 50) AND status='writing'")
    const token = randomUUID()
    const result = await this.pool.query<{ id: string; organization_id: string; storage_key: string; schema_name: string; storage_kind: string; storage_location_id: string | null; attempts: number }>(
      "UPDATE public.object_cleanup_tasks SET attempts=attempts+1,lease_token=$1,available_at=now()+interval '5 minutes' WHERE id=(SELECT id FROM public.object_cleanup_tasks WHERE status='pending' AND available_at<=now() ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,organization_id,storage_key,schema_name,storage_kind,storage_location_id,attempts", [token])
    const task = result.rows[0]
    if (!task) return false
    try {
      const storage = await objectTransaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [(task.storage_kind === 'interview' ? 'interview-object:' : 'resume-object:') + task.storage_key])
      const owned = await client.query("SELECT id FROM public.object_cleanup_tasks WHERE id=$1 AND lease_token=$2 AND status='pending' FOR UPDATE", [task.id, token])
      if (!owned.rows.length) return
      if (task.schema_name !== 'public' && task.schema_name !== organizationSchemaName(task.organization_id)) throw new Error('INVALID_TENANT_SCHEMA')
      const intent = (await client.query<{ organization_id: string; schema_name: string; storage_kind: string; location_id: string | null; status: string }>('SELECT organization_id,schema_name,storage_kind,location_id,status FROM public.object_write_intents WHERE storage_key=$1 FOR UPDATE',[task.storage_key])).rows[0]
      if (intent && (intent.organization_id !== task.organization_id || intent.schema_name !== task.schema_name || intent.storage_kind !== task.storage_kind || intent.location_id !== task.storage_location_id)) throw new Error('OBJECT_CLEANUP_INTENT_MISMATCH')
      if (intent && ['writing','unknown'].includes(intent.status)) {
        await client.query("UPDATE public.object_cleanup_tasks SET status='failed',lease_token=NULL,last_error='写入结果待核对，未删除文件' WHERE id=$1 AND lease_token=$2",[task.id,token])
        return
      }
      const otherOwner = await client.query('SELECT organization_id FROM public.stored_object_locations WHERE storage_kind=$1 AND storage_key=$2 AND organization_id<>$3 LIMIT 1', [task.storage_kind,task.storage_key,task.organization_id])
      if (otherOwner.rows.length) throw new Error('OBJECT_CLEANUP_SHARED_OWNERSHIP_REQUIRES_REVIEW')
      const schema = '"' + task.schema_name + '"'
      const audio = task.storage_kind === 'interview'
      const references = await client.query(audio
        ? 'SELECT r.id FROM ' + schema + '.interview_audio_recordings r WHERE r.object_key=$1 UNION ALL SELECT o.session_id FROM public.interview_stored_objects o WHERE COALESCE(o.physical_key,o.storage_key)=$1 LIMIT 1'
        : 'SELECT id FROM ' + schema + '.resumes WHERE storage_key=$1 LIMIT 1', [task.storage_key])
      if (references.rows.length) {
        await client.query("UPDATE public.object_cleanup_tasks SET status='completed',completed_at=now(),lease_token=NULL,last_error='对象仍被引用，已保留；实际删除时重新登记' WHERE id=$1 AND lease_token=$2", [task.id, token])
        return
      }
      const storage = audio ? this.interviewStorage : this.storage
      if (!storage) throw new Error('INTERVIEW_STORAGE_NOT_CONFIGURED')
      if (!task.storage_location_id || task.storage_location_id !== storage.locationId) {
        await client.query("UPDATE public.object_cleanup_tasks SET status='failed',lease_token=NULL,last_error='原存储位置未知或当前配置已变化，已阻止删除；请核对原存储后恢复' WHERE id=$1 AND lease_token=$2", [task.id,token])
        return
      }
      await client.query('INSERT INTO public.object_deletion_fences(storage_kind,storage_key,organization_id,schema_name,location_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT (storage_kind,storage_key) DO NOTHING', [task.storage_kind,task.storage_key,task.organization_id,task.schema_name,task.storage_location_id])
      if (intent) await client.query("UPDATE public.object_write_intents SET status='deleting',updated_at=now() WHERE storage_key=$1 AND status IN ('bound','cleanup_pending','deleting')",[task.storage_key])
      return storage
      })
      if (!storage) return true
      await storage.delete(task.storage_key)
      await objectTransaction(this.pool, async client => {
      const owned = await client.query("SELECT id FROM public.object_cleanup_tasks WHERE id=$1 AND lease_token=$2 AND status='pending' FOR UPDATE", [task.id, token])
      if (!owned.rows.length) return
      await client.query('DELETE FROM public.stored_object_locations WHERE organization_id=$1 AND storage_kind=$2 AND storage_key=$3 AND location_id=$4', [task.organization_id,task.storage_kind,task.storage_key,task.storage_location_id])
      await client.query("UPDATE public.object_write_intents SET status='deleted',updated_at=now() WHERE storage_key=$1 AND status='deleting'",[task.storage_key])
      await client.query("UPDATE public.object_cleanup_tasks SET status='completed',completed_at=now(),lease_token=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2 AND status='pending'", [task.id, token])
      })
    } catch {
      await this.pool.query("UPDATE public.object_cleanup_tasks SET status=CASE WHEN attempts>=12 THEN 'failed' ELSE 'pending' END,last_error='对象清理失败，请核对存储与引用',lease_token=NULL,available_at=now()+$3*interval '1 second' WHERE id=$1 AND lease_token=$2 AND status='pending'", [task.id, token, cleanupRetryDelaySeconds(task.attempts)])
      console.warn('文件清理暂未完成，已保留任务与退避重试状态')
    }
    return true
  }
}
