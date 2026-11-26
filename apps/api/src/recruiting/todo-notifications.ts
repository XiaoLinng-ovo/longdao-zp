import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { HttpError } from '../http.js'
import type { DashboardTodo } from './dashboard-todos.js'

export class TodoNotifications {
  constructor(private readonly pool: Pool) {}
  async sync(organizationId: string, userId: string, load: () => Promise<DashboardTodo[]>): Promise<void> {
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ['todos:' + organizationId + ':' + userId])
      const member=await db.query('SELECT 1 FROM public.organization_members m JOIN public.users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2 AND m.is_active AND m.ended_at IS NULL AND u.is_active FOR SHARE OF m',[organizationId,userId])
      if (!member.rows[0]) throw new HttpError(403,'MEMBERSHIP_DISABLED','企业成员身份已失效')
      const todos = await load()
      const keys = todos.map(todo => todo.id)
      await db.query('UPDATE public.recruitment_user_tasks SET active=false,updated_at=now() WHERE organization_id=$1 AND user_id=$2 AND active AND NOT(task_key=ANY($3::text[]))', [organizationId,userId,keys])
      await db.query("UPDATE public.recruitment_notifications SET state='resolved' WHERE organization_id=$1 AND user_id=$2 AND state='active' AND NOT(task_key=ANY($3::text[]))", [organizationId,userId,keys])
      for (const todo of todos) {
        const fingerprint = createHash('sha256').update(JSON.stringify([todo.title,todo.description,todo.path,todo.dueAt])).digest('hex')
        const old = (await db.query('SELECT fingerprint,active,revision FROM public.recruitment_user_tasks WHERE organization_id=$1 AND user_id=$2 AND task_key=$3 FOR UPDATE', [organizationId,userId,todo.id])).rows[0]
        const changed = !old || !old.active || old.fingerprint !== fingerprint
        const revision = old ? Number(old.revision) + (changed ? 1 : 0) : 1
        await db.query(`INSERT INTO public.recruitment_user_tasks(organization_id,user_id,task_key,fingerprint,payload,revision) VALUES($1,$2,$3,$4,$5::jsonb,$6)
          ON CONFLICT(organization_id,user_id,task_key) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload,active=true,revision=excluded.revision,updated_at=now()`,
          [organizationId,userId,todo.id,fingerprint,JSON.stringify(todo),revision])
        if (changed) {
          await db.query(`INSERT INTO public.recruitment_notifications(organization_id,user_id,task_key,event_key,kind,title,description,path)
            SELECT $1,$2,$3,$4,'todo',$5,$6,$7 WHERE NOT ($3 LIKE 'complete-%' AND EXISTS(
              SELECT 1 FROM public.recruitment_notifications WHERE organization_id=$1 AND user_id=$2 AND task_key=$3 AND state='active'))
            ON CONFLICT(organization_id,user_id,event_key) DO NOTHING`,
            [organizationId,userId,todo.id,'task:' + todo.id + ':' + revision,todo.title,todo.description,todo.path])
        }
        if (todo.dueAt && Date.parse(todo.dueAt) <= Date.now() + 30 * 60_000) {
          const overdue = Date.parse(todo.dueAt) < Date.now()
          await db.query(`INSERT INTO public.recruitment_notifications(organization_id,user_id,task_key,event_key,kind,title,description,path)
            VALUES($1,$2,$3,$4,'reminder',$5,$6,$7) ON CONFLICT(organization_id,user_id,event_key) DO NOTHING`,
            [organizationId,userId,todo.id,'reminder:' + todo.id + ':' + fingerprint + ':' + (overdue ? 'due' : 'soon'),overdue ? '面试时间已到' : '面试即将开始',todo.description,todo.path])
        }
      }
      await db.query('COMMIT')
    } catch (error) { await db.query('ROLLBACK'); throw error }
    finally { db.release() }
  }
  async list(organizationId: string, userId: string, unreadOnly: boolean, before?: string) {
    let cursor: {at: string; id: string} | undefined
    if (before) {
      try {
        cursor = JSON.parse(Buffer.from(before,'base64url').toString('utf8'))
        if (!cursor || !Number.isFinite(Date.parse(cursor.at)) || !/^[0-9a-f-]{36}$/i.test(cursor.id)) throw new Error('invalid')
      } catch { throw new HttpError(400,'VALIDATION_ERROR','消息分页游标无效') }
    }
    const result = await this.pool.query(`SELECT id,task_key AS "taskKey",kind,title,description,path,state,read_at AS "readAt",created_at::text AS "createdAt"
      FROM public.recruitment_notifications WHERE organization_id=$1 AND user_id=$2
      AND (NOT $3::boolean OR read_at IS NULL) AND ($4::timestamptz IS NULL OR (created_at,id) < ($4::timestamptz,$5::uuid))
      ORDER BY created_at DESC,id DESC LIMIT 51`, [organizationId,userId,unreadOnly,cursor?.at ?? null,cursor?.id ?? null])
    const unread = await this.pool.query('SELECT count(*)::int AS count FROM public.recruitment_notifications WHERE organization_id=$1 AND user_id=$2 AND read_at IS NULL', [organizationId,userId])
    const items = result.rows.slice(0,50)
    return { items, unreadCount: Number(unread.rows[0]?.count ?? 0), nextBefore: result.rows.length > 50 ? Buffer.from(JSON.stringify({at:items.at(-1)!.createdAt,id:items.at(-1)!.id})).toString('base64url') : null }
  }
  async markRead(organizationId: string, userId: string, ids: string[] | 'all') {
    await this.pool.query(`UPDATE public.recruitment_notifications SET read_at=now() WHERE organization_id=$1 AND user_id=$2 AND read_at IS NULL
      AND ($3::boolean OR id=ANY($4::uuid[]))`, [organizationId,userId,ids === 'all',ids === 'all' ? [] : ids])
    return { ok: true }
  }
}
