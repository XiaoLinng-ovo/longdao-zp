import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Pool, PoolClient } from 'pg'
import type { ObjectStorage } from '@smartrecruit-pro/object-storage'
import { currentTenantContext } from '../db/tenant-context.js'
import { HttpError } from '../http.js'
import { objectTenantSchema, objectTransaction, recordObjectWriteFailure } from '../recruiting/object-write-intent.js'

const parentMissing = () => new HttpError(404, 'INTERVIEW_NOT_FOUND', '面试已删除或不可访问')

/** Stable logical keys preserve recording and transcription idempotency; physical keys never get reused. */
export function managedInterviewAudioStorage(pool: Pool, storage: ObjectStorage): ObjectStorage {
  const sessionFor = (key: string) => {
    const session = /^interviews\/([0-9a-f-]{36})\//i.exec(key)?.[1]
    if (!session || key.includes('/versions/')) throw new Error('INVALID_INTERVIEW_OBJECT_KEY')
    return session
  }
  const parent = async (client: PoolClient, session: string) => {
    const schema = currentTenantContext()?.schemaName ?? 'public'
    const result = await client.query<{ organization_id: string; schema_name: string }>(
      'SELECT i.organization_id,current_schema() AS schema_name FROM "' + schema + '".interview_live_sessions s JOIN "' + schema + '".interviews i ON i.id=s.interview_id AND i.organization_id=s.organization_id WHERE s.id=$1::uuid FOR SHARE OF i,s', [session])
    const row = result.rows[0]
    if (!row) throw parentMissing()
    objectTenantSchema(row.organization_id, row.schema_name)
    return row
  }
  const existing = async (client: PoolClient, organization: string, session: string, key: string) => {
    const result = await client.query<{ physical_key: string | null; location_id: string | null }>(
      "SELECT o.physical_key,l.location_id FROM public.interview_stored_objects o LEFT JOIN public.stored_object_locations l ON l.organization_id=o.organization_id AND l.storage_kind='interview' AND l.storage_key=COALESCE(o.physical_key,o.storage_key) WHERE o.organization_id=$1 AND o.session_id=$2 AND o.storage_key=$3", [organization,session,key])
    const row = result.rows[0]
    if (row && (row.physical_key || row.location_id) && row.location_id !== storage.locationId) throw new Error('INTERVIEW_STORAGE_LOCATION_CHANGED')
    return row
  }
  const physicalKey = async (key: string) => {
    const session = sessionFor(key)
    return objectTransaction(pool, async client => {
      const row = await parent(client, session)
      return (await existing(client,row.organization_id,session,key))?.physical_key ?? key
    })
  }
  const writeVersion = async (key: string, version: string, write: (physical: string) => Promise<void>) => {
      const session = sessionFor(key)
      const attempt = randomUUID()
      const physical = 'interviews/' + session + '/versions/' + attempt
      const registered = await objectTransaction(pool, async client => {
        const row = await parent(client,session)
        if (await existing(client,row.organization_id,session,key)) return undefined
        if (!storage.locationId) throw new Error('INTERVIEW_STORAGE_LOCATION_UNKNOWN')
        await client.query("INSERT INTO public.object_write_intents(attempt_id,organization_id,schema_name,storage_kind,parent_id,logical_key,storage_key,location_id,content_version) VALUES($1,$2,$3,'interview',$4,$5,$6,$7,$8)",
          [attempt,row.organization_id,row.schema_name,session,key,physical,storage.locationId,version])
        return row
      })
      if (!registered) return
      let acknowledged = false
      try {
        await write(physical)
        acknowledged = true
        await objectTransaction(pool, async client => {
          const row = await parent(client,session)
          if (row.organization_id !== registered.organization_id || row.schema_name !== registered.schema_name) throw new Error('INVALID_OBJECT_TENANT')
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['interview-object:' + row.organization_id + ':' + key])
          if (await existing(client,row.organization_id,session,key)) { await recordObjectWriteFailure(client,attempt,true); return }
          const owned = await client.query("UPDATE public.object_write_intents SET status='bound',updated_at=now() WHERE attempt_id=$1 AND status='writing' AND lease_until>now() AND organization_id=$2 AND schema_name=$3 AND parent_id=$4 AND logical_key=$5 AND storage_key=$6 AND location_id=$7 AND content_version=$8 RETURNING attempt_id",
            [attempt,row.organization_id,row.schema_name,session,key,physical,storage.locationId,version])
          if (!owned.rows.length) throw new Error('INTERVIEW_OBJECT_WRITE_EXPIRED')
          await client.query("INSERT INTO public.stored_object_locations(organization_id,storage_kind,storage_key,location_id) VALUES($1,'interview',$2,$3)", [row.organization_id,physical,storage.locationId])
          await client.query('INSERT INTO public.interview_stored_objects(organization_id,session_id,storage_key,schema_name,physical_key) VALUES($1,$2,$3,$4,$5)', [row.organization_id,session,key,row.schema_name,physical])
        })
      } catch (error) {
        await recordObjectWriteFailure(pool,attempt,acknowledged).catch(() => console.warn('音频文件写入结果待核对，未直接删除文件'))
        throw error
      }
  }
  return {
    kind: storage.kind,
    ...(storage.locationId ? { locationId: storage.locationId } : {}),
    get: async key => storage.get(await physicalKey(key)),
    ...(storage.openRead ? { openRead: async (key, options) => storage.openRead!(await physicalKey(key), options) } satisfies Pick<ObjectStorage, 'openRead'> : {}),
    async delete() { throw new Error('INTERVIEW_OBJECT_DELETE_REQUIRES_CLEANUP_TASK') },
    health: () => storage.health(),
    put: (key, audio, contentType) => writeVersion(key, createHash('sha256').update(audio).digest('hex'), physical => storage.put(physical, audio, contentType)),
    ...(storage.putStream ? {
      async putStream(key, body, byteLength, contentType, options = {}) {
        try {
          options.signal?.throwIfAborted()
          if (!/^[0-9a-f]{64}$/.test(options.sha256 ?? '')) throw new Error('INTERVIEW_STREAM_HASH_REQUIRED')
          await writeVersion(key, options.sha256!, async physical => {
            const verified = Readable.from((async function* () {
              const hash = createHash('sha256')
              for await (const chunk of body) { options.signal?.throwIfAborted(); hash.update(chunk); yield chunk }
              if (hash.digest('hex') !== options.sha256) throw new Error('INTERVIEW_STREAM_HASH_MISMATCH')
            })(), { objectMode: false, signal: options.signal })
            try { await storage.putStream!(physical, verified, byteLength, contentType, options) }
            finally { verified.destroy() }
          })
        } finally { body.destroy() }
      },
    } satisfies Pick<ObjectStorage, 'putStream'> : {}),
  }
}
