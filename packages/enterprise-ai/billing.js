import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { EnterpriseAiError } from './errors.js'
import { runtimeFetch } from '@smartrecruit-pro/runtime-lifecycle'
import { executionSignal, withExecutionPermit } from './execution.js'

export const BILLING_OPERATIONS = ['resume_analysis', 'job_spec', 'jd', 'interview_questions', 'answer_analysis', 'interview_summary', 'transcript_processing', 'interview_audio', 'ocr']
export const BILLING_RESOURCES = ['ai_points', 'interview_seconds', 'ocr_pages']
const failure = (code, message, status = 409) => new EnterpriseAiError(code, message, status)
const runningPolicy = new AsyncLocalStorage()
const executionAdmitted = Symbol('executionAdmitted')
const integer = (v, min = 0, max = 1000000000) => Number.isSafeInteger(v) && v >= min && v <= max
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && Object.keys(v).every(k => keys.includes(k))
export function validateBillingPolicy(config) {
  if (!exact(config, ['enabled', 'rules', 'limits', 'trial']) || typeof config.enabled !== 'boolean'
    || !exact(config.rules, BILLING_OPERATIONS)
    || !exact(config.limits, ['maxConcurrent', 'dailyAiPoints', 'maxInputChars', 'maxOutputTokens'])
    || !exact(config.trial, ['resumeUploads', 'interviews', 'aiGenerations', 'aiPoints', 'interviewSeconds', 'ocrPages', 'durationDays', 'seatLimit', 'jobLimit'])) throw failure('VALIDATION_ERROR', '计费配置结构无效，请刷新后重新填写', 400)
  for (const rule of Object.values(config.rules)) {
    if (!exact(rule, ['enabled', 'resource', 'quantity', 'unitSize']) || typeof rule.enabled !== 'boolean'
      || !BILLING_RESOURCES.includes(rule.resource) || !integer(rule.quantity) || !integer(rule.unitSize, 1)) throw failure('VALIDATION_ERROR', '扣费规则需填写有效资源、扣除数量和计量单位', 400)
  }
  for (const [key, value] of Object.entries(config.limits)) if (!integer(value, 1, key === 'maxConcurrent' ? 1000 : 1000000000)) throw failure('VALIDATION_ERROR', '成本保护上限必须为有效正整数', 400)
  for (const value of Object.values(config.trial)) if (!integer(value)) throw failure('VALIDATION_ERROR', '试用额度必须为非负整数', 400)
  if (!integer(config.trial.durationDays,1,3660) || !integer(config.trial.seatLimit,1,1000000) || !integer(config.trial.jobLimit,1,1000000)) throw failure('VALIDATION_ERROR', '试用天数、席位和岗位容量需填写有效正整数',400)
  return structuredClone(config)
}
export function validateBillingEntitlements(value) {
  if (!exact(value, ['quotas', 'grantPeriod', 'rollover']) || !exact(value.quotas, BILLING_RESOURCES)
    || !['once', 'monthly'].includes(value.grantPeriod) || typeof value.rollover !== 'boolean'
    || Object.values(value.quotas).some(v => !integer(v, 0, 1000000000000))) throw failure('VALIDATION_ERROR', '商品额度、发放周期或结转规则无效', 400)
  return structuredClone(value)
}
export function billedUnits(rule, amount) {
  if (!integer(amount, 1)) throw failure('VALIDATION_ERROR', '计量数量必须为正整数', 400)
  const units = rule.enabled ? Math.ceil(amount / rule.unitSize) * rule.quantity : 0
  if (!Number.isSafeInteger(units) || units > 1000000000000) throw failure('VALIDATION_ERROR', '计费数量超出安全范围', 400)
  return units
}
export function coveredMilliseconds(ranges) {
  let total = 0, end = 0
  for (const range of [...ranges].sort((a,b)=>a[0]-b[0])) {
    if (range[1] > end) { total += range[1] - Math.max(end,range[0]); end = range[1] }
  }
  return total
}
export class BillingStore {
  constructor(pool) { this.pool = pool }
  async policy(db = this.pool) {
    const row = (await db.query('SELECT id,config,created_at FROM public.billing_policy_versions ORDER BY id DESC LIMIT 1')).rows[0]
    if (!row) throw failure('BILLING_NOT_CONFIGURED', '平台计费配置缺失，请联系平台管理员', 503)
    return { version: String(row.id), config: row.config, createdAt: row.created_at }
  }
  async transaction(action) {
    const db = await this.pool.connect()
    try { await db.query('BEGIN'); const value = await action(db); await db.query('COMMIT'); return value }
    catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error }
    finally { db.release() }
  }
  async ensureTrialGrants(organizationId, db, policy) {
    const org = (await db.query('SELECT service_status,trial_ends_at FROM public.organizations WHERE id=$1',[organizationId])).rows[0]
    if (org?.service_status!=='trial' || !org.trial_ends_at || new Date(org.trial_ends_at).getTime()<=Date.now()) return
    for (const [resource,key] of [['ai_points','aiPoints'],['interview_seconds','interviewSeconds'],['ocr_pages','ocrPages']]) {
      const units=policy.config.trial[key]
      // A zero allowance is recorded too, so later price changes never silently replenish a trial.
      const inserted=await db.query("INSERT INTO public.billing_trial_grants(organization_id,resource,policy_version) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING resource",[organizationId,resource,policy.version])
      if (units && inserted.rows.length) await db.query("INSERT INTO public.billing_grants(organization_id,resource,total,remaining,expires_at,source_key) VALUES($1,$2,$3,$3,$4,'trial:initial') ON CONFLICT DO NOTHING",[organizationId,resource,units,org.trial_ends_at])
    }
  }
  async reserve(input) {
    if (!BILLING_OPERATIONS.includes(input.operation) || typeof input.key !== 'string' || input.key.length < 8 || input.key.length > 200) throw failure('VALIDATION_ERROR', '计费任务标识无效', 400)
    if (input.audio && (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.audio.sessionId ?? '') || !integer(input.audio.startMs) || !integer(input.audio.endMs,1) || input.audio.endMs<=input.audio.startMs || input.operation!=='interview_audio')) throw failure('VALIDATION_ERROR','音频计量范围无效',400)
    const fingerprint = createHash('sha256').update(JSON.stringify([input.amount ?? 1, input.fingerprint ?? input.key,input.audio ?? null])).digest('hex')
    return this.transaction(async db => {
      const org = (await db.query('SELECT id FROM public.organizations WHERE id=$1 AND public.organization_service_available(id) FOR NO KEY UPDATE', [input.organizationId])).rows[0]
      if (!org) throw failure('WORKSPACE_SERVICE_UNAVAILABLE', '企业服务不可用，未启动算力任务')
      const previous = (await db.query('SELECT * FROM public.billing_tasks WHERE organization_id=$1 AND operation=$2 AND request_key=$3 ORDER BY attempt DESC LIMIT 1', [input.organizationId, input.operation, input.key])).rows[0]
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw failure('BILLING_KEY_CONFLICT', '同一任务标识不能用于不同内容')
        if (previous.state === 'settled' && previous.result !== null) return { replayed: true, result: previous.result }
        if (previous.state !== 'released') throw failure('BILLING_TASK_EXISTS', '任务正在处理或待核对，请勿重复发起；失败重试请使用新的操作标识')
      }
      let policy = await this.policy(db)
      if (input.audio) {
        const snapshot = (await db.query('SELECT * FROM public.billing_audio_sessions WHERE session_id=$1',[input.audio.sessionId])).rows[0]
        if (snapshot) {
          if (snapshot.organization_id!==input.organizationId) throw failure('BILLING_KEY_CONFLICT','面试计量所属企业不一致')
          policy = {version:String(snapshot.policy_version),config:snapshot.config_snapshot}
        } else await db.query('INSERT INTO public.billing_audio_sessions(session_id,organization_id,policy_version,config_snapshot) VALUES($1,$2,$3,$4)',[input.audio.sessionId,input.organizationId,policy.version,JSON.stringify(policy.config)])
      }
      await this.ensureTrialGrants(input.organizationId,db,policy)
      const rule = policy.config.rules[input.operation]
      if (!rule) throw failure('BILLING_RULE_MISSING', '此功能尚未配置计费规则，未发起任务')
      let guardUnits = billedUnits({...rule,enabled:true}, input.amount ?? 1)
      let units = policy.config.enabled ? billedUnits(rule, input.amount ?? 1) : 0
      if (input.audio) {
        const covered = (await db.query("SELECT audio_start_ms,audio_end_ms,state,units FROM public.billing_tasks WHERE organization_id=$1 AND audio_session_id=$2 AND state<>'released'",[input.organizationId,input.audio.sessionId])).rows
        if (covered.some(r=>r.state==='reserved' && Number(r.units)>0 && Number(r.audio_start_ms)<input.audio.endMs && Number(r.audio_end_ms)>input.audio.startMs)) throw failure('BILLING_AUDIO_BUSY','相同音频范围正在识别，请稍后重试')
        const ranges = covered.map(r=>[Number(r.audio_start_ms),Number(r.audio_end_ms)])
        const before = Math.ceil(coveredMilliseconds(ranges)/1000), after = Math.ceil(coveredMilliseconds([...ranges,[input.audio.startMs,input.audio.endMs]])/1000)
        guardUnits = (after ? billedUnits({...rule,enabled:true},after) : 0) - (before ? billedUnits({...rule,enabled:true},before) : 0)
        units = policy.config.enabled && rule.enabled ? guardUnits : 0
      }
      // Reconciliation retains credits and replay protection, not an execution slot.
      const stats = (await db.query("SELECT count(*) FILTER(WHERE state='reserved')::int AS concurrent, COALESCE(sum(COALESCE((rule_snapshot->>'guardUnits')::bigint,units)) FILTER(WHERE resource='ai_points' AND state<>'released' AND created_at>=date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'),0)::text AS daily FROM public.billing_tasks WHERE organization_id=$1", [input.organizationId])).rows[0]
      if (!input[executionAdmitted] && stats.concurrent >= policy.config.limits.maxConcurrent) throw failure('BILLING_CONCURRENCY_LIMIT', '企业算力任务已达到并发上限，请稍后再试')
      if (rule.resource === 'ai_points' && Number(stats.daily) + guardUnits > policy.config.limits.dailyAiPoints) throw failure('BILLING_DAILY_LIMIT', '已达到企业今日算力使用上限，请联系平台管理员')
      let needed = units
      const allocations = []
      if (needed) {
        const grants = (await db.query("SELECT id,remaining FROM public.billing_grants WHERE organization_id=$1 AND resource=$2 AND revoked_at IS NULL AND valid_from<=now() AND (expires_at IS NULL OR expires_at>now()) AND remaining>0 ORDER BY expires_at ASC NULLS LAST,created_at,id FOR UPDATE", [input.organizationId, rule.resource])).rows
        for (const grant of grants) {
          const used = Math.min(needed, Number(grant.remaining))
          await db.query('UPDATE public.billing_grants SET remaining=remaining-$2 WHERE id=$1', [grant.id, used])
          allocations.push({ id: grant.id, units: used }); needed -= used
          if (!needed) break
        }
        if (needed) throw failure('BILLING_QUOTA_EXHAUSTED', '企业可用算力额度不足，请增购额度或联系平台管理员；已有业务数据不受影响')
      }
      const attempt=Number(previous?.attempt ?? 0)+1
      const row = (await db.query('INSERT INTO public.billing_tasks(organization_id,operation,task_key,fingerprint,policy_version,rule_snapshot,resource,units,allocations,request_key,attempt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [input.organizationId,input.operation,createHash('sha256').update(input.key).digest('hex')+':'+attempt,fingerprint,policy.version,JSON.stringify({...rule,guardUnits}),rule.resource,units,JSON.stringify(allocations),input.key,attempt])).rows[0]
      if (input.audio) await db.query('UPDATE public.billing_tasks SET audio_session_id=$2,audio_start_ms=$3,audio_end_ms=$4 WHERE id=$1',[row.id,input.audio.sessionId,input.audio.startMs,input.audio.endMs])
      return { id: row.id, units, version: policy.version, config: policy.config }
    })
  }
  async finish(id, state, result = null) {
    if (!['settled', 'released', 'uncertain'].includes(state)) throw failure('VALIDATION_ERROR', '计费结算状态无效', 400)
    if (!id) return
    await this.transaction(async db => {
      const hint = (await db.query('SELECT organization_id FROM public.billing_tasks WHERE id=$1', [id])).rows[0]
      if (!hint) throw failure('BILLING_TASK_NOT_FOUND', '计费任务不存在')
      await db.query('SELECT id FROM public.organizations WHERE id=$1 FOR NO KEY UPDATE', [hint.organization_id])
      const task = (await db.query('SELECT * FROM public.billing_tasks WHERE id=$1 FOR UPDATE', [id])).rows[0]
      if (task.state !== 'reserved') {
        if (task.state === state) return
        throw failure('BILLING_SETTLEMENT_CONFLICT', '计费状态已变化，请人工核对')
      }
      if (state === 'released') for (const allocation of task.allocations) await db.query('UPDATE public.billing_grants SET remaining=remaining+$2 WHERE id=$1', [allocation.id,allocation.units])
      await db.query('UPDATE public.billing_tasks SET state=$2,result=$3,finished_at=now() WHERE id=$1', [id,state,JSON.stringify(result ?? null)])
    })
  }
  async execute(input, action) {
    const ticket = await this.reserve(input)
    if (ticket.replayed) return ticket.result
    let settling = false
    try { const result = await runningPolicy.run(ticket.config, action); settling = true; await this.finish(ticket.id, 'settled', result); return result }
    catch (error) {
      // Unknown provider/DB outcomes must not release credits and allow a second dispatch.
      const rejected = !settling && (error?.code === 'MODEL_HTTP_ERROR' || error?.code === 'OCR_HTTP_ERROR' || error?.code === 'BILLING_INPUT_LIMIT')
      await this.finish(ticket.id, rejected ? 'released' : 'uncertain').catch(() => undefined)
      throw error
    }
  }
  async balance(organizationId, db = this.pool) {
    const resources = (await db.query(`SELECT resource,sum(remaining)::text AS available,
      COALESCE(sum(remaining) FILTER(WHERE expires_at IS NULL),0)::text AS permanent,
      min(expires_at) FILTER(WHERE remaining>0) AS next_expiry
      FROM public.billing_grants WHERE organization_id=$1 AND revoked_at IS NULL AND valid_from<=now()
      AND (expires_at IS NULL OR expires_at>now()) GROUP BY resource`, [organizationId])).rows
    const reserved = (await db.query("SELECT resource,sum(units)::text AS reserved FROM public.billing_tasks WHERE organization_id=$1 AND state IN ('reserved','uncertain') GROUP BY resource", [organizationId])).rows
    for (const resource of BILLING_RESOURCES) {
      let row = resources.find(r=>r.resource===resource)
      if (!row) { row={resource,available:'0',permanent:'0',next_expiry:null}; resources.push(row) }
      row.reserved=reserved.find(r=>r.resource===resource)?.reserved ?? '0'
    }
    const grants = (await db.query(`SELECT g.id,g.resource,g.remaining::text,g.total::text,g.valid_from,g.expires_at,
      CASE WHEN o.billing_kind='addon' THEN 'paid_addon' WHEN g.order_id IS NOT NULL THEN 'subscription'
        WHEN g.source_key LIKE 'trial:%' THEN 'trial' ELSE 'manual' END AS source,
      o.product_name AS name FROM public.billing_grants g LEFT JOIN public.payment_orders o ON o.id=g.order_id
      WHERE g.organization_id=$1 AND g.revoked_at IS NULL AND g.remaining>0
      AND (g.expires_at IS NULL OR g.expires_at>now()) ORDER BY g.expires_at ASC NULLS LAST,g.created_at,g.id LIMIT 100`, [organizationId])).rows
    const tasks = (await db.query('SELECT id,operation,resource,units::text,state,policy_version::text,created_at,finished_at FROM public.billing_tasks WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50', [organizationId])).rows
    return { resources, tasks, grants }
  }
}
const contexts = new WeakMap()
export function bindBillingEnv(env, pool, organizationId) { contexts.set(env, { pool, organizationId }); return env }
async function executeMetered(env, context, input, action, channel) {
  const store = new BillingStore(context.pool)
  if ((env.AI_CHANNEL_ISOLATION ?? process.env.AI_CHANNEL_ISOLATION) === 'off') return store.execute(input, action)
  const execute = () => store.execute({ ...input, [executionAdmitted]: true }, action)
  // Realtime has already passed session admission in the authenticated gateway.
  if (channel === 'realtime') return execute()
  const policy = await store.policy()
  return withExecutionPermit(context.pool, context.organizationId, channel, env, policy.config.limits.maxConcurrent, execute)
}
export async function meterAiOperation(env, operation, key, input, action, amount = 1, channel = 'interactive') {
  const context = contexts.get(env)
  if (!context) return action()
  return executeMetered(env, context, { organizationId: context.organizationId, operation, key, fingerprint: input, amount }, action, channel)
}
export function createBillingFetch(env, fetchImpl = runtimeFetch) {
  const context = contexts.get(env)
  if (!context) return fetchImpl
  return async (url, init) => {
    const owner = executionSignal()
    if (owner) init = { ...init, signal: init?.signal ? AbortSignal.any([init.signal, owner]) : owner }
    const config = runningPolicy.getStore() ?? (await new BillingStore(context.pool).policy()).config
    if (typeof init?.body !== 'string') return fetchImpl(url, init)
    const body = JSON.parse(init.body)
    if (JSON.stringify(body.messages ?? []).length > config.limits.maxInputChars) throw failure('BILLING_INPUT_LIMIT', '输入内容超过平台单次处理上限，请缩短内容', 400)
    const cap = value => Number.isSafeInteger(value) && value > 0 ? Math.min(value, config.limits.maxOutputTokens) : config.limits.maxOutputTokens
    if (body.max_tokens !== undefined) body.max_tokens = cap(body.max_tokens)
    if (body.max_completion_tokens !== undefined || body.max_tokens === undefined) body.max_completion_tokens = cap(body.max_completion_tokens)
    return fetchImpl(url, { ...init, body: JSON.stringify(body) })
  }
}
export function meterInterviewAudio(env, key, audio, action, channel = 'audio') {
  const context = contexts.get(env)
  if (!context) return action()
  return executeMetered(env, context, {organizationId:context.organizationId,operation:'interview_audio',key,audio},action,channel)
}
export function meterOcrOperation(env, content, pages, action) {
  const input = {sha256:createHash('sha256').update(content).digest('hex'), pages: [...new Set(pages?.length ? pages : [1])].sort((a,b)=>a-b)}
  const key = 'ocr:' + createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return meterAiOperation(env, 'ocr', key, input, action, input.pages.length)
}
