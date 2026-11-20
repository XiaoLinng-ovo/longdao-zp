import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { EnterpriseAiError } from './errors.js'

const namespace = 1397901641
const ownership = new AsyncLocalStorage()
const key = value => createHash('sha256').update(value).digest().readInt32BE()
const limit = (env, name, fallback) => {
  const configured = env[name] ?? process.env[name]
  if (configured === undefined) return fallback
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) throw new EnterpriseAiError('AI_EXECUTION_CONFIG_INVALID', 'AI执行通道配置无效，请联系管理员', 503)
  return value
}
export const isExecutionBusy = error => ['AI_CHANNEL_BUSY', 'BILLING_CONCURRENCY_LIMIT', 'BILLING_AUDIO_BUSY'].includes(error?.code)
export const executionSignal = () => ownership.getStore()?.signal

export async function readExecutionStatus(db, organizationId, maxConcurrent, env = process.env) {
  const textCap = limit(env, 'AI_TEXT_GLOBAL_CONCURRENT', 2), audioCap = limit(env, 'AI_AUDIO_GLOBAL_CONCURRENT', 1)
  const orgAudioCap = limit(env, 'AI_AUDIO_ORG_CONCURRENT', 1)
  const ids = (scope, cap) => Array.from({ length: cap }, (_, slot) => key(scope + ':' + slot) >>> 0)
  const textIds = ids('org:' + organizationId + ':text', maxConcurrent), audioIds = ids('org:' + organizationId + ':audio', orgAudioCap)
  const rows = (await db.query(`SELECT objid::text AS id FROM pg_locks WHERE locktype='advisory' AND granted
    AND classid=$1::oid AND objsubid=2 AND objid=ANY($2::oid[])
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`, [namespace, [...textIds, ...audioIds]])).rows
  const count = group => rows.filter(row => group.includes(Number(row.id))).length
  const live = (await db.query('SELECT count(DISTINCT session_id)::int AS active FROM public.billing_stream_sources WHERE organization_id=$1 AND lease_until>now()', [organizationId])).rows[0]
  return { enabled: (env.AI_CHANNEL_ISOLATION ?? process.env.AI_CHANNEL_ISOLATION) !== 'off',
    text: { active: count(textIds), limit: Math.min(maxConcurrent, textCap), reservedInteractive: Math.min(maxConcurrent, textCap) > 1 ? 1 : 0 },
    audio: { active: count(audioIds), limit: Math.min(orgAudioCap, audioCap) },
    realtime: { active: Number(live?.active ?? 0), limit: maxConcurrent } }
}

// Session locks outlive transactions, but never the owning connection. No timer
// expires an in-flight provider call or makes its billing identity replayable.
export async function withExecutionPermit(pool, organizationId, channel, env, maxConcurrent, action) {
  if (!['interactive', 'background', 'audio'].includes(channel)) throw new TypeError('Invalid execution channel')
  const audio = channel === 'audio'
  const globalCap = limit(env, audio ? 'AI_AUDIO_GLOBAL_CONCURRENT' : 'AI_TEXT_GLOBAL_CONCURRENT', audio ? 1 : 2)
  const orgCap = audio ? limit(env, 'AI_AUDIO_ORG_CONCURRENT', 1) : maxConcurrent
  const required = limit(env, 'AI_TEXT_GLOBAL_CONCURRENT', 2) + limit(env, 'AI_AUDIO_GLOBAL_CONCURRENT', 1) + 2
  if (pool.options?.max < required) throw new EnterpriseAiError('AI_EXECUTION_CONFIG_INVALID', '数据库连接池需为AI执行与结算保留足够连接，请联系管理员', 503)
  const started = Date.now(), deadline = started + (channel === 'interactive' ? 3000 : 0)
  do {
    const db = await pool.connect(), held = [], controller = new AbortController()
    let damaged = false
    const lost = () => { damaged = true; controller.abort(new Error('AI execution ownership lost')) }
    db.on?.('error', lost)
    try {
      const take = async (scope, cap) => {
        // Non-interactive text work cannot occupy the reserved interactive slot.
        const first = channel === 'background' && cap > 1 ? 1 : 0
        for (let slot = first; slot < cap; slot++) {
          const id = key(scope + ':' + slot)
          const result = await db.query('SELECT pg_try_advisory_lock($1::int,$2::int) AS acquired', [namespace, id])
          if (result.rows[0]?.acquired === true) { held.push(id); return true }
        }
        return false
      }
      const resource = audio ? 'audio' : 'text'
      if (await take('global:' + resource, globalCap) && await take('org:' + organizationId + ':' + resource, orgCap)) {
        console.info('ai-execution-admitted channel=' + channel + ' org=' + organizationId + ' waitMs=' + (Date.now() - started))
        return await ownership.run(controller, action)
      }
    } finally {
      try {
        for (const id of held.reverse()) await db.query('SELECT pg_advisory_unlock($1::int,$2::int)', [namespace, id])
      } catch { damaged = true }
      db.off?.('error', lost)
      db.release(damaged || undefined)
    }
    if (Date.now() >= deadline) break
    await delay(100 + Math.floor(Math.random() * 100))
  } while (Date.now() <= deadline)
  console.info('ai-execution-busy channel=' + channel + ' org=' + organizationId + ' waitMs=' + (Date.now() - started))
  throw new EnterpriseAiError('AI_CHANNEL_BUSY', '当前处理通道繁忙，后台任务将排队，请稍后重试', 429)
}
