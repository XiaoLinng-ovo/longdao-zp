import { randomUUID } from 'node:crypto'
import { startBackgroundPoll } from '../background-poll.js'
import type { Pool } from 'pg'
import { EnterpriseAiStore } from '@smartrecruit-pro/enterprise-ai'
import { createInterviewObjectStorageFromEnv } from '@smartrecruit-pro/object-storage'
import { createDatabasePool } from '../db/connection.js'
import { requireReadyWorkspaceSchema } from '../auth/workspace-context.js'
import { organizationSchemaName, runWithTenantContext } from '../db/tenant-context.js'
import { HttpError } from '../http.js'
import { FullInterviewAudio, type FullAudioSource } from './full-audio.js'
import { createLiveInterviewAudioStorage } from './live-audio-storage.js'
import { managedInterviewAudioStorage } from './managed-audio-storage.js'
import { InterviewAudioRecordingRepository } from './audio-recording-repository.js'
import { splitFullInterviewAudio, type FullAudioInput, type FullAudioTranscriptionJob, type RecordedChunkMeter, type AudioSplitter } from './full-audio-transcription.js'
import { transcribeInterviewChunk } from './interview-transcriber.js'
import { billedRecordingChunks } from './billed-recording.js'

interface Task {
  id: string; organization_id: string; interview_id: string; session_id: string; schema_name: string
  storage_key: string; source: FullAudioSource; fingerprint: string; status: string; progress: number
  text: string; next_chunk: number; lease_token: string; updated_at: Date; last_error: string | null
}
interface Enqueue { organizationId: string; interviewId: string; sessionId: string; key: string; source: FullAudioSource; fingerprint: string }
type Runtime = (task: Task) => Promise<{ load(signal?: AbortSignal): Promise<FullAudioInput>; meter: RecordedChunkMeter; totalChunks: number }>
function view(task: Task): FullAudioTranscriptionJob {
  return { status: task.status === 'queued' ? 'processing' : task.status === 'unknown' ? 'failed' : task.status as FullAudioTranscriptionJob['status'],
    progress: task.progress, text: task.text, updatedAt: new Date(task.updated_at).toISOString(), ...(task.last_error ? { error: task.last_error } : {}) }
}

export function loadFullAudioBudget(env: NodeJS.ProcessEnv = process.env): {platform:number;workspace:number} {
  const read=(key:string,fallback:number)=>{
    const value=Number(env[key] ?? fallback)
    if (!Number.isInteger(value) || value<1 || value>16) throw new Error(key+' 必须在 1 到 16 之间')
    return value
  }
  return {platform:read('FULL_AUDIO_SHARED_CONCURRENCY',2),workspace:read('FULL_AUDIO_WORKSPACE_CONCURRENCY',1)}
}

export class PersistentFullAudioTranscription {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<boolean>>()
  private closing: Promise<void> | undefined
  cancel() { this.lifetime.abort() }
  constructor(private readonly pool: Pool, private readonly runtime: Runtime,
    private readonly transcribe = transcribeInterviewChunk, private readonly split: AudioSplitter = (audio, signal) => splitFullInterviewAudio(audio, undefined, signal),
    private readonly budget = loadFullAudioBudget(), private readonly closeResources: () => Promise<void> = async () => {}) {}

  close(): Promise<void> {
    this.cancel()
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.active])
      await this.closeResources()
    })()
  }

  async get(organizationId: string, key: string): Promise<FullAudioTranscriptionJob | null> {
    const result = await this.pool.query<Task>('SELECT * FROM public.full_audio_transcription_tasks WHERE organization_id=$1 AND storage_key=$2', [organizationId, key])
    return result.rows[0] ? view(result.rows[0]) : null
  }

  async enqueue(input: Enqueue): Promise<FullAudioTranscriptionJob> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const parent = await client.query("SELECT i.organization_id,current_schema() AS schema_name FROM interview_live_sessions s JOIN interviews i ON i.id=s.interview_id WHERE s.id=$1 AND i.id=$2 AND i.organization_id=$3 FOR SHARE OF i", [input.sessionId, input.interviewId, input.organizationId])
      if (!parent.rows[0]) throw new HttpError(404, 'INTERVIEW_NOT_FOUND', '面试场次已删除或不可访问')
      const result = await client.query<Task>(
        "INSERT INTO public.full_audio_transcription_tasks(organization_id,interview_id,session_id,schema_name,storage_key,source,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id,storage_key) DO UPDATE SET status=CASE WHEN full_audio_transcription_tasks.status='failed' AND full_audio_transcription_tasks.attempts<3 AND NOT full_audio_transcription_tasks.inference_pending THEN 'queued' ELSE full_audio_transcription_tasks.status END,updated_at=now() RETURNING *",
        [input.organizationId, input.interviewId, input.sessionId, parent.rows[0].schema_name, input.key, input.source, input.fingerprint])
      await client.query('COMMIT')
      return view(result.rows[0]!)
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }

  private async claim(): Promise<Task | undefined> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('smartrecruit:full-audio-budget'))")
      await client.query("UPDATE public.full_audio_transcription_tasks SET status=CASE WHEN inference_pending THEN 'unknown' WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,last_error=CASE WHEN inference_pending THEN '进程在识别调用期间中断，结果与费用待管理员核对，未自动重试' ELSE '处理租约过期，等待恢复' END,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE status='processing' AND lease_until<now()")
      const token = randomUUID()
      const result = await client.query<Task>(
        "UPDATE public.full_audio_transcription_tasks SET status='processing',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '90 seconds',last_claimed_at=now(),last_error=NULL,updated_at=now() WHERE id=(SELECT t.id FROM public.full_audio_transcription_tasks t WHERE t.status='queued' AND (SELECT count(*) FROM public.full_audio_transcription_tasks a WHERE a.status='processing')<$2 AND (SELECT count(*) FROM public.full_audio_transcription_tasks a WHERE a.organization_id=t.organization_id AND a.status='processing')<$3 ORDER BY (SELECT max(a.last_claimed_at) FROM public.full_audio_transcription_tasks a WHERE a.organization_id=t.organization_id) NULLS FIRST,t.created_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1) RETURNING *", [token,this.budget.platform,this.budget.workspace])
      await client.query('COMMIT')
      return result.rows[0]
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }

  processPending(): Promise<boolean> {
    if (this.lifetime.signal.aborted) return Promise.resolve(false)
    const work = this.processOnce().finally(() => this.active.delete(work))
    this.active.add(work)
    return work
  }

  private async processOnce(): Promise<boolean> {
    if (this.lifetime.signal.aborted) return false
    const task = await this.claim()
    if (!task) return false
    const scoped = async () => {
      if (task.schema_name !== 'public') await requireReadyWorkspaceSchema(this.pool, task.organization_id)
      const available = await this.pool.query('SELECT public.organization_service_available($1) AS available', [task.organization_id])
      if (!available.rows[0]?.available) throw new Error('WORKSPACE_SERVICE_UNAVAILABLE')
      const update = async (sql: string, values: unknown[] = []) => {
        const result = await this.pool.query('UPDATE public.full_audio_transcription_tasks SET ' + sql + ',updated_at=now() WHERE id=$1 AND lease_token=$2 AND status=\'processing\' AND lease_until>now() RETURNING id', [task.id, task.lease_token, ...values])
        if (!result.rows.length) throw new Error('FULL_AUDIO_LEASE_LOST')
      }
      let leaseLost = false, pendingCall = false
      const deadline = new AbortController(), deadlineTimer = setTimeout(() => deadline.abort(), 30 * 60_000)
      const signal = AbortSignal.any([this.lifetime.signal, deadline.signal])
      let heartbeatWork: Promise<unknown> = Promise.resolve(), heartbeatBusy = false
      const heartbeat = setInterval(() => {
        if (heartbeatBusy) return
        heartbeatBusy = true
        heartbeatWork = update("lease_until=now()+interval '90 seconds'").catch(() => { leaseLost = true }).finally(() => { heartbeatBusy = false })
      }, 15000)
      heartbeat.unref()
      try {
        const runtime = await this.runtime(task)
        signal.throwIfAborted()
        const chunks = await this.split(await runtime.load(signal), signal)
        let index = 0, text = task.text
        for await (const audio of chunks) {
          signal.throwIfAborted()
          const current = index++
          if (current < task.next_chunk) continue
          if (leaseLost) throw new Error('FULL_AUDIO_LEASE_LOST')
          await update('inference_pending=true')
          pendingCall = true
          const segments = await runtime.meter(audio, current, () => this.transcribe(audio, 'audio/wav'))
          const recognized = segments.map(row => row.text.trim()).filter(Boolean).join('')
          if (recognized) text += (text ? '\n' : '') + recognized
          await update('inference_pending=false,text=$3,next_chunk=$4,progress=$5', [text, index, Math.min(99, Math.round(index / Math.max(index, runtime.totalChunks) * 100))])
          pendingCall = false
        }
        await update("status='completed',progress=100,inference_pending=false,lease_token=NULL,lease_until=NULL,last_error=NULL")
      } catch (error) {
        const code = String((error as { code?: string })?.code ?? '')
        const unknown = pendingCall && !code.startsWith('BILLING_QUOTA')
        await update('status=$3,last_error=$4,inference_pending=$5,lease_token=NULL,lease_until=NULL', [unknown ? 'unknown' : 'failed', unknown ? '识别调用结果待核对，未自动重试，请联系系统管理员' : code.startsWith('BILLING_') && error instanceof Error ? error.message : '整段转写失败，请检查服务后重试', unknown]).catch(() => undefined)
      } finally { clearInterval(heartbeat); clearTimeout(deadlineTimer); await heartbeatWork }
    }
    try {
      if (task.schema_name === 'public') {
        if (process.env.TENANT_SCHEMA_ROUTING === 'on') throw new Error('INVALID_TENANT_SCHEMA')
        await scoped()
      } else {
        if (task.schema_name !== organizationSchemaName(task.organization_id)) throw new Error('INVALID_TENANT_SCHEMA')
        await runWithTenantContext({ organizationId: task.organization_id, schemaName: task.schema_name }, scoped)
      }
    } catch {
      await this.pool.query("UPDATE public.full_audio_transcription_tasks SET status='failed',last_error='企业数据结构未就绪，任务未执行',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2", [task.id, task.lease_token])
    }
    return true
  }
}

export function createConfiguredPersistentFullAudioTranscription(providedPool?: Pool): PersistentFullAudioTranscription {
  const pool = providedPool ?? createDatabasePool()
  const rawStorage = createInterviewObjectStorageFromEnv(process.env)
  const storage = createLiveInterviewAudioStorage(managedInterviewAudioStorage(pool, rawStorage))
  const full = new FullInterviewAudio(storage), recordings = new InterviewAudioRecordingRepository(pool)
  return new PersistentFullAudioTranscription(pool, async task => {
    const manifest = await recordings.manifest(task.interview_id, task.session_id)
    if (!manifest.length || full.fingerprint(manifest, task.source) !== task.fingerprint) throw new Error('FULL_AUDIO_INPUT_CHANGED')
    const env = await new EnterpriseAiStore(pool).runtimeEnv(task.organization_id)
    const duration = Math.max(...manifest.map(row => row.endMs ?? row.offsetMs))
    return { load: signal => full.loadStream(task.session_id, manifest, task.source, signal), meter: billedRecordingChunks(env, task.session_id, task.source + ':' + task.fingerprint), totalChunks: Math.max(1, Math.ceil(duration / 60000)) }
  }, undefined, undefined, undefined, async () => {
    try { await full.close() } finally {
      try { await rawStorage.close?.() } finally { if (!providedPool) await pool.end() }
    }
  })
}

export function startPersistentFullAudioPoll(service: Pick<PersistentFullAudioTranscription, 'processPending'> & Partial<Pick<PersistentFullAudioTranscription, 'cancel' | 'close'>>): () => Promise<void> {
  const stop = startBackgroundPoll({ intervalMs: 1000, run: async () => { await service.processPending() },
    onError: () => { console.warn('整场转写任务调度失败，请检查迁移与数据库') } })
  let closing: Promise<void> | undefined
  return () => closing ??= (async () => {
    const draining = stop(), timer = setTimeout(() => service.cancel?.(), 30000)
    try { await draining } finally { clearTimeout(timer); await service.close?.() }
  })()
}
