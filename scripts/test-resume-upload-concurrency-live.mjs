import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import fs from 'node:fs/promises'

const root = process.cwd()
const require = createRequire(join(root, 'apps/api/package.json'))
const { Client } = require('pg')
const cfg = JSON.parse(await fs.readFile('.codex-artifacts/.pgconn.json', 'utf8'))
if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) throw new Error('只允许对本地数据库执行')

const BASE = process.env.API_BASE || 'http://127.0.0.1:3100'
const ORIGIN = 'http://127.0.0.1:5174'
const db = new Client({ host: cfg.host, port: +cfg.port, user: cfg.user, password: cfg.password, database: cfg.db })
await db.connect()

const report = { startedAt: new Date().toISOString(), phases: [], checks: {}, errors: [] }
const round = (v) => Math.round(v * 100) / 100
const percentile = (values, p) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
}
const TABLES = ['users', 'organizations', 'jobs', 'candidates', 'applications', 'resumes', 'resume_import_batches', 'resume_import_items', 'analysis_tasks', 'analysis_results', 'sessions']
async function counts() {
  const out = {}
  for (const t of TABLES) out[t] = (await db.query(`select count(*)::int n from ${t}`)).rows[0].n
  return out
}
const baseline = await counts()
report.baseline = baseline

// ---------- 建测试组织 ----------
const orgId = randomUUID()
const userId = randomUUID()
const jobId = randomUUID()
const email = `load-test-${orgId.slice(0, 8)}@example.invalid`
const password = `Lt-${randomUUID()}`
const { hashPassword } = await import(new URL('../apps/api/dist/src/auth/password.js', import.meta.url))
await db.query('INSERT INTO users(id,email,display_name,password_hash,is_active) VALUES($1,$2,$3,$4,true)', [userId, email, '并发导入压测账号', await hashPassword(password)])
await db.query("INSERT INTO organizations(id,name,kind,service_status,created_by) VALUES($1,$2,'test','enabled',$3)", [orgId, `并发导入压测企业 ${orgId.slice(0, 8)}`, userId])
await db.query("INSERT INTO organization_members(organization_id,user_id,role,business_role) VALUES($1,$2,'owner','recruiter')", [orgId, userId])
await db.query("INSERT INTO jobs(id,organization_id,job_no,title,headcount,status,created_by) VALUES($1,$2,$3,'并发导入测试岗位',5,'published',$4)", [jobId, orgId, `JOB-${randomUUID().slice(0, 8)}`, userId])

// ---------- 登录 ----------
const login = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000) })
if (login.status !== 200) throw new Error(`登录失败 ${login.status} ${await login.text()}`)
const cookies = login.headers.getSetCookie()
await login.arrayBuffer()
const session = decodeURIComponent(cookies.find((v) => v.startsWith('smartrecruit_session=')).split(';')[0].slice('smartrecruit_session='.length))
const csrf = decodeURIComponent(cookies.find((v) => v.startsWith('smartrecruit_csrf=')).split(';')[0].slice('smartrecruit_csrf='.length))
await db.query('UPDATE sessions SET active_organization_id=$1 WHERE user_id=$2', [orgId, userId])

async function send(method, path, body) {
  const started = performance.now()
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, authorization: `Bearer ${session}`, cookie: `smartrecruit_session=${session}; smartrecruit_csrf=${csrf}`, 'x-csrf-token': csrf, 'x-workspace-id': orgId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text.slice(0, 200) } }
  return { status: response.status, body: parsed, ms: performance.now() - started }
}
async function batch(count, bytes, ext = 'txt', mimeType = 'text/plain') {
  return send('POST', '/api/v1/resume-import-batches', { jobId, files: Array.from({ length: count }, (_, i) => ({ clientFileId: randomUUID(), originalFilename: `synthetic-${i}.${ext}`, mimeType, sizeBytes: bytes })) })
}
function payload(bytes, index = 0) {
  return Buffer.from(`Name: 压测候选人 ${index}\nEmail: load-${index}@example.invalid\nEducation: 本科 计算机科学\nExperience: 5 年 Java\nSkills: Java, Spring Boot, PostgreSQL\n`.padEnd(Math.max(200, bytes), ' '))
}
// 与前端 resume-upload-retry.ts 策略一致：429/505 类按 retry-after 指数退避重试
async function uploadWithRetry(batchId, itemId, content, stats) {
  const delays = [2000, 4000, 8000, 15000, 15000]
  for (let attempt = 0; ; attempt++) {
    const res = await send('POST', `/api/v1/resume-import-batches/${batchId}/items/${itemId}/content`, { content: content.toString('base64'), encoding: 'base64' })
    if (res.status === 200) { stats.retries += attempt; return res }
    const retryable = res.status === 429 || [502, 503, 504].includes(res.status)
    if (!retryable || attempt >= delays.length) { stats.failed++; return res }
    const retryAfter = Number(res.body?.error?.details?.retryAfterSeconds || 2)
    stats.rateLimited += 1
    await new Promise((r) => setTimeout(r, Math.max(delays[attempt], retryAfter * 1000) + Math.floor(Math.random() * 250)))
  }
}
function newStats() { return { rateLimited: 0, retries: 0, failed: 0 } }

async function lanes(items, concurrency, action) {
  let next = 0
  const out = new Array(items.length)
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await action(items[i], i) }
  }))
  return out
}

const createdBatches = []
try {
  // ===== 阶段 1：24 并发上传 60 个 256KB 文件 =====
  for (const phase of [
    { name: '24并发-60x256KB', count: 60, bytes: 256 * 1024, concurrency: 24 },
    { name: '24并发-24x5MB', count: 24, bytes: 5 * 1024 * 1024, concurrency: 24 },
  ]) {
    const created = await batch(phase.count, phase.bytes)
    if (created.status !== 201) throw new Error(`建批次失败 ${created.status} ${JSON.stringify(created.body)}`)
    const fixture = created.body.data
    createdBatches.push(fixture.id)
    const probes = []
    let probing = false
    const sampler = setInterval(() => {
      if (probing) return
      probing = true
      void send('GET', '/api/v1/jobs').then((r) => { probes.push(r.ms); if (r.status !== 200) report.errors.push(`probe:${r.status}`) }).finally(() => { probing = false })
    }, 150)
    let peak = 0, active = 0
    const stats = newStats(); stats.durations = []
    const start = performance.now()
    let results
    try {
      results = await lanes(fixture.items, phase.concurrency, async (item, index) => {
        active++; peak = Math.max(peak, active)
        try {
          const res = await uploadWithRetry(fixture.id, item.id, payload(phase.bytes, index), stats)
          stats.durations.push(res.ms)
          return res
        } finally { active-- }
      })
    } finally { clearInterval(sampler); while (probing) await new Promise((r) => setTimeout(r, 20)) }
    const elapsed = performance.now() - start
    const statuses = {}
    for (const r of results) statuses[r.status] = (statuses[r.status] || 0) + 1
    const refreshed = await send('GET', `/api/v1/resume-import-batches/${fixture.id}`)
    const resumeIds = refreshed.body.data.items.map((i) => i.resumeId).filter(Boolean)
    const stored = (await db.query('SELECT count(*)::int n FROM resumes WHERE id = ANY($1::uuid[])', [resumeIds])).rows[0].n
    const dupNames = (await db.query('SELECT count(*)::int n FROM resumes WHERE organization_id=$1 AND original_filename LIKE $2 GROUP BY original_filename HAVING count(*)>1', [orgId, 'synthetic-%'])).rows
    const durations = stats.durations
    const entry = {
      phase: phase.name, files: phase.count, concurrency: phase.concurrency, peakObserved: peak,
      seconds: round(elapsed / 1000), filesPerSecond: round(phase.count / (elapsed / 1000)),
      p50Ms: round(percentile(durations, 0.5)), p95Ms: round(percentile(durations, 0.95)), maxMs: round(Math.max(...durations)),
      statuses, serverUploadedCount: refreshed.body.data.counts.uploaded, resumesStored: stored, duplicateFilenames: dupNames.length,
      readProbeCount: probes.length, readP95Ms: round(percentile(probes, 0.95)),
      rateLimitedResponses: stats.rateLimited, totalRetries: stats.retries, failedAfterRetry: stats.failed,
    }
    report.phases.push(entry)
    console.log(JSON.stringify(entry))
    if (stats.failed) report.errors.push(`${phase.name}: ${stats.failed} 个文件重试后仍失败`)
    if (statuses[200] !== phase.count) report.errors.push(`${phase.name}: 成功数 ${statuses[200]}/${phase.count}`)
    if (refreshed.body.data.counts.uploaded !== phase.count) report.errors.push(`${phase.name}: 服务端计数 ${refreshed.body.data.counts.uploaded}/${phase.count}`)
    if (stored !== phase.count) report.errors.push(`${phase.name}: 入库 ${stored}/${phase.count}`)
    // 立即清掉分析任务，避免触发真实 worker 的 LLM 分析
    await db.query('DELETE FROM analysis_results WHERE organization_id=$1', [orgId])
    await db.query('DELETE FROM analysis_tasks WHERE organization_id=$1', [orgId])
  }

  // ===== 阶段 2：幂等 / 重复 / 取消 / 限额 =====
  const idem = await batch(6, 4096)
  createdBatches.push(idem.body.data.id)
  const first = await send('POST', `/api/v1/resume-import-batches/${idem.body.data.id}/items/${idem.body.data.items[0].id}/content`, { content: payload(4096).toString('base64'), encoding: 'base64' })
  const repeat = await send('POST', `/api/v1/resume-import-batches/${idem.body.data.id}/items/${idem.body.data.items[0].id}/content`, { content: payload(4096).toString('base64'), encoding: 'base64' })
  const dupId = randomUUID()
  const dupClient = await send('POST', '/api/v1/resume-import-batches', { jobId, files: [{ clientFileId: dupId, originalFilename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1024 }, { clientFileId: dupId, originalFilename: 'b.txt', mimeType: 'text/plain', sizeBytes: 1024 }] })
  const tooMany = await batch(501, 1024)
  const tooBig = await batch(1, 11 * 1024 * 1024)
  const badExt = await batch(1, 1024, 'exe', 'application/octet-stream')
  const cancelled = await batch(10, 2048)
  createdBatches.push(cancelled.body.data.id)
  await lanes(cancelled.body.data.items.slice(0, 3), 3, (item) => send('POST', `/api/v1/resume-import-batches/${cancelled.body.data.id}/items/${item.id}/content`, { content: payload(2048).toString('base64'), encoding: 'base64' }))
  const cancelRes = await send('POST', `/api/v1/resume-import-batches/${cancelled.body.data.id}/cancel`, {})
  const afterCancel = await send('POST', `/api/v1/resume-import-batches/${cancelled.body.data.id}/items/${cancelled.body.data.items[9].id}/content`, { content: payload(2048).toString('base64'), encoding: 'base64' })
  const checks = {
    firstUpload: first.status,
    repeatUpload: { status: repeat.status, code: repeat.body?.error?.code },
    duplicateClientFileId: { status: dupClient.status, code: dupClient.body?.error?.code },
    batchTooLarge: { status: tooMany.status, code: tooMany.body?.error?.code },
    fileTooLarge: { status: tooBig.status, code: tooBig.body?.error?.code },
    unsupportedExtension: { status: badExt.status, code: badExt.body?.error?.code },
    cancelBatch: cancelRes.status,
    uploadAfterCancel: { status: afterCancel.status, code: afterCancel.body?.error?.code },
  }
  report.checks.idempotencyAndLimits = checks
  console.log(JSON.stringify(checks))
  if (first.status !== 200) report.errors.push('首次上传未成功')
  if (dupClient.status !== 400) report.errors.push('重复 clientFileId 未被拒绝')
  if (tooMany.status !== 400) report.errors.push('超限批次未被拒绝')
  if (tooBig.status !== 400) report.errors.push('超大文件未被拒绝')
  if (badExt.status !== 400) report.errors.push('非法扩展名未被拒绝')
  if (afterCancel.status === 200) report.errors.push('取消后仍可上传')

  // ===== 阶段 3：同内容不同名去重观察 =====
  const sameA = await batch(1, 4096)
  createdBatches.push(sameA.body.data.id)
  await send('POST', `/api/v1/resume-import-batches/${sameA.body.data.id}/items/${sameA.body.data.items[0].id}/content`, { content: payload(4096, 777).toString('base64'), encoding: 'base64' })
  const sameB = await batch(1, 4096)
  createdBatches.push(sameB.body.data.id)
  await send('POST', `/api/v1/resume-import-batches/${sameB.body.data.id}/items/${sameB.body.data.items[0].id}/content`, { content: payload(4096, 777).toString('base64'), encoding: 'base64' })
  const candidateCount = (await db.query('SELECT count(*)::int n FROM candidates WHERE organization_id=$1', [orgId])).rows[0].n
  report.checks.sameContentTwice = { candidates: candidateCount }
  console.log(JSON.stringify(report.checks.sameContentTwice))
} catch (error) {
  report.errors.push(`异常中止: ${error.message}`)
  console.error(error)
} finally {
  // ===== 清理 =====
  const cleanupSteps = [
    ['analysis_results', 'DELETE FROM analysis_results WHERE organization_id=$1'],
    ['analysis_tasks', 'DELETE FROM analysis_tasks WHERE organization_id=$1'],
    ['resume_import_items', 'DELETE FROM resume_import_items WHERE organization_id=$1'],
    ['interviews', 'DELETE FROM interviews WHERE organization_id=$1'],
    ['offers', 'DELETE FROM offers WHERE organization_id=$1'],
    ['onboarding_records', 'DELETE FROM onboarding_records WHERE organization_id=$1'],
    ['applications', 'DELETE FROM applications WHERE organization_id=$1'],
    ['resumes', 'DELETE FROM resumes WHERE organization_id=$1'],
    ['candidates', 'DELETE FROM candidates WHERE organization_id=$1'],
    ['resume_import_batches', 'DELETE FROM resume_import_batches WHERE organization_id=$1'],
    ['outbox_events', 'DELETE FROM outbox_events WHERE organization_id=$1'],
    ['workflow_events', 'DELETE FROM workflow_events WHERE organization_id=$1'],
    ['audit_logs', 'DELETE FROM audit_logs WHERE organization_id=$1'],
    ['idempotency_records', 'DELETE FROM idempotency_records WHERE organization_id=$1'],
    ['jobs', 'DELETE FROM jobs WHERE organization_id=$1'],
    ['organization_members', 'DELETE FROM organization_members WHERE organization_id=$1'],
    ['sessions', 'DELETE FROM sessions WHERE user_id=$1'],
    ['user_roles', 'DELETE FROM user_roles WHERE user_id=$1'],
    ['organizations', 'DELETE FROM organizations WHERE id=$1'],
    ['users', 'DELETE FROM users WHERE id=$1'],
  ]
  const cleanupResult = {}
  for (const [name, sql] of cleanupSteps) {
    try { cleanupResult[name] = (await db.query(sql, [name === 'sessions' || name === 'user_roles' || name === 'users' ? userId : (name === 'organizations' ? orgId : orgId)])).rowCount }
    catch (error) { cleanupResult[name] = `ERR ${error.message}` }
  }
  const after = await counts()
  report.cleanup = { steps: cleanupResult, after }
  const drift = Object.entries(after).filter(([k, v]) => v !== baseline[k]).map(([k, v]) => `${k}: ${baseline[k]} -> ${v}`)
  report.cleanup.drift = drift
  report.cleanup.restored = drift.length === 0
  report.finishedAt = new Date().toISOString()
  await fs.mkdir('.codex-artifacts/load-tests', { recursive: true })
  const outFile = `.codex-artifacts/load-tests/live-concurrency-${Date.now()}.json`
  await fs.writeFile(outFile, JSON.stringify(report, null, 2), 'utf8')
  await db.end()
  console.log(JSON.stringify({ errors: report.errors, cleanup: { restored: report.cleanup.restored, drift } }))
  console.log('report:', outFile)
  if (!report.cleanup.restored) process.exitCode = 2
  else if (report.errors.length) process.exitCode = 1
}
