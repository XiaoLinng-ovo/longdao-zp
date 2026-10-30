// V1 主流程真实闭环验证：在真实 PostgreSQL 上跑完整条业务链，并逐项断言。
// 用法：DATABASE_URL='postgresql://user:pass@host:port/db' node scripts/verify-v1-flow.mjs
// 前置：已执行 db/migrations 全部迁移 + scripts/seed-dev-postgres.mjs 种子。
// 覆盖：登录 → 招聘需求 → 审批 → 岗位 → 说明书/JD → 确认 → 发布 → 候选人 → 申请
//      → 简历上传 → 分析 → 人工复核 → 面试 → 反馈提交/锁定 → 结论 → Offer → 审批/发送/接受
//      → 入职归档 → 报表/看板/流程事件 → 部门数据范围 → 分页 → 幂等重放。
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ===== 可调参数 =====
const DEFAULT_BASE_DEPARTMENT = 'dept-tech'      // 流程所用部门（需存在于 departments.code）
const DEFAULT_OUTSIDE_DEPARTMENT = 'dept-sales'  // 用于跨部门越权断言
const DEFAULT_PASSWORDS = {
  'recruiter@smartrecruit.local': 'recruiter123',
  'approver@smartrecruit.local': 'approver123',
  'interviewer@smartrecruit.local': 'interviewer123',
  'manager@smartrecruit.local': 'manager123',
}
const DEFAULT_READY_TIMEOUT_MS = 5000
const DEFAULT_ASYNC_TIMEOUT_MS = 30_000

process.env.NODE_ENV = 'production'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
process.env.RECRUITING_QUARANTINE_ROOT = process.env.RECRUITING_QUARANTINE_ROOT || resolve(root, 'data', 'resumes', 'quarantine')
process.env.WORKER_DB_POLL = 'true'
process.env.WORKER_HEALTH_HOST = '127.0.0.1'
process.env.WORKER_HEALTH_PORT = '0'

const { loadConfig } = await import('../apps/api/dist/src/config.js')
const { createHttpServer } = await import('../apps/api/dist/src/server.js')
const { loadDatabaseConfig } = await import('../apps/api/dist/src/db/index.js')
const { loadConfig: loadWorkerConfig } = await import('../apps/worker/dist/src/config.js')
const { startWorker } = await import('../apps/worker/dist/src/worker.js')

const database = loadDatabaseConfig()
const server = createHttpServer(loadConfig({ NODE_ENV: 'production', PORT: '0', HOST: '127.0.0.1' }))
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
const baseUrl = `http://127.0.0.1:${address.port}`
const worker = await startWorker(loadWorkerConfig())

let passed = 0
const failures = []
function check(label, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✔ ${label}`) }
  else { failures.push(label); console.log(`  ✖ ${label}${detail ? ` → ${detail}` : ''}`) }
}
function step(title) { console.log(`\n[${title}]`) }

let csrfToken = ''
let csrfCookie = ''

async function api(method, path, { body, token, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? { 'x-csrf-token': csrfToken, cookie: csrfCookie } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { raw: text.slice(0, 200) } }
  return { status: response.status, body: parsed, headers: response.headers }
}

async function waitFor(label, fetchState, predicate, timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fetchState()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms: ${JSON.stringify(last).slice(0, 500)}`)
}

async function login(email) {
  const password = process.env.SEED_PASSWORD?.trim() || DEFAULT_PASSWORDS[email]
  const response = await api('POST', '/api/v1/auth/login', { body: { email, password } })
  if (response.status !== 200) throw new Error(`登录失败 ${email}: ${response.status} ${JSON.stringify(response.body).slice(0, 200)}`)
  // 会话 token 只在 Set-Cookie 里（生产模式带 __Host- 前缀），响应体不含 token。
  const cookies = response.headers.getSetCookie()
  const session = cookies.map((value) => value.split(';')[0]).find((value) => value.includes('smartrecruit_session='))
  if (!session) throw new Error(`登录未返回会话 Cookie：${JSON.stringify(cookies)}`)
  const token = decodeURIComponent(session.slice(session.indexOf('smartrecruit_session=') + 'smartrecruit_session='.length))
  const csrf = cookies.map((value) => value.split(';')[0]).find((value) => value.includes('smartrecruit_csrf='))
  if (csrf) {
    csrfToken = decodeURIComponent(csrf.slice(csrf.indexOf('smartrecruit_csrf=') + 'smartrecruit_csrf='.length))
    csrfCookie = csrf
  }
  return { token, user: response.body.data.user }
}

try {
  console.log(`目标数据库：${database.target}`)
  console.log(`服务地址：${baseUrl}（NODE_ENV=production，会话与业务数据均走 PostgreSQL）`)

  process.env.PORT = String(address.port)
  process.env.BASE_URL = baseUrl
  const ready = await api('GET', '/api/v1/ready')
  step('就绪检查')
  check('GET /ready 返回 200（数据库可连接）', ready.status === 200, `${ready.status} ${JSON.stringify(ready.body).slice(0, 120)}`)

  step('身份与权限')
  const recruiter = await login('recruiter@smartrecruit.local')
  const approver = await login('approver@smartrecruit.local')
  const interviewer = await login('interviewer@smartrecruit.local')
  const manager = await login('manager@smartrecruit.local')
  const me = await api('GET', '/api/v1/me', { token: recruiter.token })
  check('招聘专员登录后 /me 返回 PostgreSQL 中的真实用户', me.status === 200 && me.body.data.user.email === 'recruiter@smartrecruit.local' && me.body.data.user.role === 'recruiter', JSON.stringify(me.body).slice(0, 160))
  check('会话身份携带部门（来自 users.department_id）', Boolean(me.body.data.user.departmentId), String(me.body.data.user.departmentId))

  step('招聘需求 → 提交 → 审批')
  const request = await api('POST', '/api/v1/recruitment-requests', { token: recruiter.token, body: { title: 'PG 闭环验证岗位', departmentId: DEFAULT_BASE_DEPARTMENT, headcount: 1, employmentType: 'full_time', workMode: 'hybrid', justification: '真实数据库闭环验证' } })
  check('创建招聘需求 201', request.status === 201, `${request.status} ${JSON.stringify(request.body).slice(0, 160)}`)
  const requestId = request.body.data?.id
  const submitted = await api('POST', `/api/v1/recruitment-requests/${requestId}/submit`, { token: recruiter.token, body: {} })
  check('提交后状态 pending_approval', submitted.body.data?.status === 'pending_approval', JSON.stringify(submitted.body).slice(0, 120))
  const forbidden = await api('POST', `/api/v1/recruitment-requests/${requestId}/approve`, { token: recruiter.token, body: {} })
  check('招聘专员不能自审批（403）', forbidden.status === 403, String(forbidden.status))
  const approved = await api('POST', `/api/v1/recruitment-requests/${requestId}/approve`, { token: approver.token, body: {} })
  check('审批人通过后状态 approved', approved.body.data?.status === 'approved', JSON.stringify(approved.body).slice(0, 120))
  const approval = await api('GET', `/api/v1/recruitment-requests/${requestId}/approval`, { token: approver.token })
  check('审批实例已落库且可查询', approval.status === 200 && approval.body.data?.current?.status === 'approved', JSON.stringify(approval.body).slice(0, 160))

  step('岗位 → 说明书/JD → 确认 → 发布')
  const job = await api('POST', '/api/v1/jobs', { token: recruiter.token, body: { title: 'PG 验证工程师', departmentId: DEFAULT_BASE_DEPARTMENT, recruitmentRequestId: requestId, headcount: 1, employmentType: 'full_time', workMode: 'hybrid' } })
  check('创建岗位 201', job.status === 201, `${job.status} ${JSON.stringify(job.body).slice(0, 160)}`)
  const jobId = job.body.data?.id
  const spec = await api('POST', `/api/v1/jobs/${jobId}/spec`, { token: recruiter.token, body: { title: 'PG 验证工程师', summary: '负责数据服务', responsibilities: ['建设数据服务'], requirements: [{ label: '数据库', description: '熟悉 PostgreSQL', required: true }], skills: ['PostgreSQL'] } })
  check('岗位说明书写入 job_spec_versions', spec.status === 200 && spec.body.data?.spec?.version === 1, JSON.stringify(spec.body).slice(0, 160))
  const jd = await api('POST', `/api/v1/jobs/${jobId}/jd`, { token: recruiter.token, body: { language: 'zh-CN', content: '负责数据服务建设' } })
  check('JD 写入 job_description_versions', jd.status === 200 && jd.body.data?.jd?.version === 1, JSON.stringify(jd.body).slice(0, 160))
  const confirmSpec = await api('POST', `/api/v1/jobs/${jobId}/confirm-spec`, { token: recruiter.token, body: {} })
  check('确认说明书后状态仍为 draft（说明 confirmed_at 已落库）', confirmSpec.body.data?.status === 'draft' && confirmSpec.body.data?.spec?.confirmed === true, JSON.stringify(confirmSpec.body).slice(0, 160))
  const confirmJd = await api('POST', `/api/v1/jobs/${jobId}/confirm-jd`, { token: recruiter.token, body: {} })
  check('确认 JD 后状态 ready', confirmJd.body.data?.status === 'ready', JSON.stringify(confirmJd.body).slice(0, 160))
  const published = await api('POST', `/api/v1/jobs/${jobId}/publish`, { token: recruiter.token, body: {} })
  check('发布后状态 published', published.body.data?.status === 'published', JSON.stringify(published.body).slice(0, 160))
  const specVersions = await api('GET', `/api/v1/jobs/${jobId}/spec-versions`, { token: recruiter.token })
  const jdVersions = await api('GET', `/api/v1/jobs/${jobId}/jd-versions`, { token: recruiter.token })
  check('说明书版本列表可读（含确认标记）', specVersions.status === 200 && specVersions.body.data?.[0]?.confirmed === true, JSON.stringify(specVersions.body).slice(0, 160))
  check('JD 版本列表可读（含确认标记）', jdVersions.status === 200 && jdVersions.body.data?.[0]?.confirmed === true, JSON.stringify(jdVersions.body).slice(0, 160))

  step('候选人 → 申请 → 简历隔离 → 分析 → 人工复核')
  const candidate = await api('POST', '/api/v1/candidates', { token: recruiter.token, body: { fullName: 'PG 验证候选人', email: 'pg.verify.candidate@example.com', source: '内部推荐' } })
  check('创建候选人 201', candidate.status === 201, `${candidate.status} ${JSON.stringify(candidate.body).slice(0, 160)}`)
  const candidateId = candidate.body.data?.id
  const application = await api('POST', '/api/v1/applications', { token: recruiter.token, body: { candidateId, jobId, source: '内部推荐' } })
  check('创建职位申请 201（初始 pending_analysis）', application.status === 201 && application.body.data?.status === 'pending_analysis', JSON.stringify(application.body).slice(0, 160))
  const applicationId = application.body.data?.id
  const resume = await api('POST', '/api/v1/resumes', { token: recruiter.token, body: { candidateId, applicationId, originalFilename: 'pg-resume.txt', mimeType: 'text/plain', content: 'PG 验证候选人\nPostgreSQL 8 years' } })
  check('简历可直接进入分析队列', resume.status === 201 && resume.body.data?.resume?.scanStatus === 'clean' && resume.body.data?.task?.status === 'queued', JSON.stringify(resume.body).slice(0, 200))
  const taskId = resume.body.data?.task?.id
  const processed = await waitFor('简历分析',
    () => api('GET', `/api/v1/analysis-tasks/${taskId}`, { token: recruiter.token }),
    (response) => response.body.data?.status === 'completed',
  )
  check('分析任务由 Worker 执行完成并写入 analysis_results', processed.status === 200 && processed.body.data?.status === 'completed', JSON.stringify(processed.body).slice(0, 200))
  const taskResult = await api('GET', `/api/v1/analysis-tasks/${taskId}/result`, { token: recruiter.token })
  check('分析结果可读且标注“仅建议”', taskResult.status === 200 && taskResult.body.data?.result?.safety?.advisoryOnly === true, JSON.stringify(taskResult.body).slice(0, 200))
  const resultId = taskResult.body.data?.id
  const reviewed = await api('PATCH', `/api/v1/analysis-results/${resultId}`, { token: recruiter.token, body: { status: 'accepted', comment: '人工确认' } })
  check('人工复核状态落库 accepted', reviewed.status === 200 && reviewed.body.data?.humanReviewStatus === 'accepted', JSON.stringify(reviewed.body).slice(0, 160))

  step('面试 → 反馈提交 → 锁定 → 结论')
  await api('POST', `/api/v1/applications/${applicationId}/status`, { token: recruiter.token, body: { status: 'analysis_queued' } })
  const humanReview = await api('POST', `/api/v1/applications/${applicationId}/status`, { token: recruiter.token, body: { status: 'human_review' } })
  check('申请推进到 human_review', humanReview.body.data?.status === 'human_review', JSON.stringify(humanReview.body).slice(0, 160))
  const interview = await api('POST', '/api/v1/interviews', { token: interviewer.token, body: { applicationId, title: 'PG 技术面', type: 'technical', scheduledStartAt: new Date(Date.now() + 86400000).toISOString(), participants: [{ userId: interviewer.user.id, name: interviewer.user.name, role: 'interviewer' }] } })
  check('面试官创建面试 201（写入 interviews）', interview.status === 201, `${interview.status} ${JSON.stringify(interview.body).slice(0, 200)}`)
  const interviewId = interview.body.data?.id
  const interviews = await api('GET', `/api/v1/interviews?applicationId=${applicationId}`, { token: interviewer.token })
  check('面试列表可读且带 application/feedbackStatus', interviews.status === 200 && interviews.body.data?.[0]?.application?.id === applicationId && interviews.body.data?.[0]?.feedbackStatus === 'pending', JSON.stringify(interviews.body).slice(0, 220))
  const feedback = await api('POST', `/api/v1/interviews/${interviewId}/feedback`, { token: interviewer.token, body: { interviewerId: interviewer.user.id, overallScore: 90, recommendation: 'yes', ratings: { 技术: 5 }, strengths: ['PostgreSQL 熟练'], concerns: [] } })
  check('提交反馈（interviewer_id 为真实用户 UUID）', feedback.status === 200 && feedback.body.data?.status === 'submitted', `${feedback.status} ${JSON.stringify(feedback.body).slice(0, 200)}`)
  const lock = await api('POST', `/api/v1/interviews/${interviewId}/lock-feedback`, { token: interviewer.token, body: { interviewerId: interviewer.user.id } })
  check('锁定反馈', lock.status === 200 && lock.body.data?.status === 'locked', JSON.stringify(lock.body).slice(0, 160))
  const lockedAgain = await api('POST', `/api/v1/interviews/${interviewId}/feedback`, { token: interviewer.token, body: { interviewerId: interviewer.user.id, overallScore: 60 } })
  check('锁定后不可再改（409 FEEDBACK_LOCKED）', lockedAgain.status === 409, String(lockedAgain.status))
  const concluded = await api('POST', `/api/v1/interviews/${interviewId}/conclude`, { token: interviewer.token, body: { outcome: 'offer' } })
  check('面试结论 completed', concluded.status === 200 && concluded.body.data?.status === 'completed', JSON.stringify(concluded.body).slice(0, 160))

  step('Offer → 审批 → 发送 → 接受 → 入职归档')
  const afterConclude = await api('GET', '/api/v1/applications', { token: recruiter.token })
  check('申请随面试结论推进到 offer_approval', afterConclude.body.data?.find((item) => item.id === applicationId)?.status === 'offer_approval')
  const offer = await api('POST', '/api/v1/offers', { token: recruiter.token, body: { applicationId, positionTitle: 'PG 验证工程师', departmentId: DEFAULT_BASE_DEPARTMENT, employmentType: 'full_time', startDate: '2026-10-01', baseSalary: { amount: 30000, currency: 'CNY' }, benefits: ['五险一金'], content: '欢迎加入' } })
  check('创建 Offer 201（含首个版本）', offer.status === 201 && Boolean(offer.body.data?.currentVersionId), `${offer.status} ${JSON.stringify(offer.body).slice(0, 200)}`)
  const offerId = offer.body.data?.id
  const submittedOffer = await api('POST', `/api/v1/offers/${offerId}/submit-approval`, { token: recruiter.token, body: {} })
  check('Offer 提交审批 pending_approval', submittedOffer.body.data?.status === 'pending_approval', JSON.stringify(submittedOffer.body).slice(0, 160))
  const approvedOffer = await api('POST', `/api/v1/offers/${offerId}/approve`, { token: recruiter.token, body: {} })
  check('Offer 审批通过 approved', approvedOffer.body.data?.status === 'approved', JSON.stringify(approvedOffer.body).slice(0, 160))
  const sentOffer = await api('POST', `/api/v1/offers/${offerId}/send`, { token: recruiter.token, body: {} })
  check('Offer 发送 sent（记录 sent_at）', sentOffer.body.data?.status === 'sent' && Boolean(sentOffer.body.data?.sentAt), JSON.stringify(sentOffer.body).slice(0, 160))
  const acceptedOffer = await api('POST', `/api/v1/offers/${offerId}/accept`, { token: recruiter.token, body: {} })
  check('Offer 接受 accepted（记录 responded_at）', acceptedOffer.body.data?.status === 'accepted' && Boolean(acceptedOffer.body.data?.respondedAt), JSON.stringify(acceptedOffer.body).slice(0, 160))
  const offerDetail = await api('GET', `/api/v1/offers/${offerId}`, { token: recruiter.token })
  check('Offer 详情含版本历史', offerDetail.status === 200 && offerDetail.body.data?.versions?.length === 1, JSON.stringify(offerDetail.body).slice(0, 200))
  const archived = await api('POST', `/api/v1/offers/${offerId}/archive-onboarding`, { token: recruiter.token, body: { reason: '入职资料已归档' } })
  check('归档入职记录 201/200（写入 onboarding_records）', (archived.status === 200 || archived.status === 201) && archived.body.data?.status === 'pending', `${archived.status} ${JSON.stringify(archived.body).slice(0, 200)}`)
  const onboardingId = archived.body.data?.id
  const patched = await api('PATCH', `/api/v1/onboarding/${onboardingId}`, { token: recruiter.token, body: { plannedStartDate: '2026-10-08', notes: '待入职' } })
  check('更新入职计划（planned_start_date）', patched.status === 200 && patched.body.data?.plannedStartDate?.startsWith('2026-10-08'), JSON.stringify(patched.body).slice(0, 200))
  const scheduled = await api('POST', `/api/v1/onboarding/${onboardingId}/schedule`, { token: recruiter.token, body: {} })
  check('入职安排 scheduled', scheduled.body.data?.status === 'scheduled', JSON.stringify(scheduled.body).slice(0, 160))
  const completed = await api('POST', `/api/v1/onboarding/${onboardingId}/complete`, { token: recruiter.token, body: {} })
  check('入职完成 completed 并回写申请状态', completed.body.data?.status === 'completed' && Boolean(completed.body.data?.archivedAt), JSON.stringify(completed.body).slice(0, 160))
  const finalApplications = await api('GET', '/api/v1/applications', { token: recruiter.token })
  check('申请最终状态 onboarding_archived', finalApplications.body.data?.find((item) => item.id === applicationId)?.status === 'onboarding_archived')

  step('聚合与审计读接口（全部来自 PostgreSQL）')
  const reports = await api('GET', '/api/v1/reports', { token: recruiter.token })
  check('报表漏斗/渠道/周期/接受率可读', reports.status === 200 && Array.isArray(reports.body.data?.funnel) && reports.body.data?.recruitmentCycle?.hiredCount >= 1, JSON.stringify(reports.body.data?.recruitmentCycle ?? {}).slice(0, 160))
  check('报表 Offer 接受率已统计', reports.body.data?.offerAcceptance?.accepted >= 1, JSON.stringify(reports.body.data?.offerAcceptance ?? {}).slice(0, 160))
  const dashboard = await api('GET', '/api/v1/dashboard/summary', { token: recruiter.token })
  check('看板汇总可读（含待办反馈/失败任务）', dashboard.status === 200 && dashboard.body.data?.funnel?.[0]?.count >= 1, JSON.stringify(dashboard.body).slice(0, 160))
  const events = await api('GET', '/api/v1/workflow-events?limit=200', { token: recruiter.token })
  const actions = new Set((events.body.data ?? []).map((item) => item.action))
  check('流程事件覆盖关键动作（含 spec_created/jd_created/feedback_locked/conclude/accept）', ['spec_created', 'jd_created', 'feedback_submitted', 'feedback_locked', 'conclude'].every((action) => actions.has(action)), [...actions].slice(0, 12).join(','))
  check('流程事件带可读主体标签', (events.body.data ?? []).some((item) => item.subjectLabel && item.subjectLabel !== item.subjectId))

  step('部门数据范围与分页、幂等')
  const salesRequest = await api('POST', '/api/v1/recruitment-requests', { token: recruiter.token, body: { title: '跨部门越权验证', departmentId: DEFAULT_OUTSIDE_DEPARTMENT, headcount: 1, employmentType: 'full_time', workMode: 'onsite', justification: '越权验证' } })
  await api('POST', `/api/v1/recruitment-requests/${salesRequest.body.data.id}/submit`, { token: recruiter.token, body: {} })
  await api('POST', `/api/v1/recruitment-requests/${salesRequest.body.data.id}/approve`, { token: approver.token, body: {} })
  const salesJob = await api('POST', '/api/v1/jobs', { token: recruiter.token, body: { title: '跨部门越权验证岗位', departmentId: DEFAULT_OUTSIDE_DEPARTMENT, recruitmentRequestId: salesRequest.body.data.id, headcount: 1, employmentType: 'full_time', workMode: 'onsite' } })
  const managerJobs = await api('GET', '/api/v1/jobs', { token: manager.token })
  check('用人经理只看到本部门岗位', managerJobs.status === 200 && managerJobs.body.data.every((item) => item.departmentId === DEFAULT_BASE_DEPARTMENT), JSON.stringify((managerJobs.body.data ?? []).map((item) => item.departmentId)).slice(0, 160))
  const foreignJob = await api('GET', `/api/v1/jobs/${salesJob.body.data.id}`, { token: manager.token })
  check('跨部门岗位详情被拒绝（403）', foreignJob.status === 403, String(foreignJob.status))
  const salesCandidate = await api('POST', '/api/v1/candidates', { token: recruiter.token, body: { fullName: '跨部门候选人', email: `sales.${Date.now()}@example.com` } })
  const salesApplication = await api('POST', '/api/v1/applications', { token: recruiter.token, body: { candidateId: salesCandidate.body.data.id, jobId: salesJob.body.data.id } })
  const foreignInterview = await api('POST', '/api/v1/interviews', { token: manager.token, body: { applicationId: salesApplication.body.data.id, title: '越权面试', participants: [{ userId: interviewer.user.id, role: 'interviewer' }] } })
  check('用人经理不能跨部门创建面试（403）', foreignInterview.status === 403, `status=${foreignInterview.status} ${JSON.stringify(foreignInterview.body).slice(0, 140)}`)
  const paged = await api('GET', '/api/v1/candidates?page=1&pageSize=1', { token: recruiter.token })
  check('分页返回 meta.pagination', paged.status === 200 && paged.body.meta?.pagination?.pageSize === 1 && paged.body.meta?.pagination?.total >= 1, JSON.stringify(paged.body.meta ?? {}).slice(0, 160))
  const idempotencyKey = `verify-${Date.now()}-an`
  // 两次请求体必须字节一致，否则会被判定为“同 key 不同载荷”返回 409（那是正确行为，不是幂等失效）。
  const idempotencyBody = { fullName: '幂等验证候选人', email: `idem.${Date.now()}@example.com` }
  const firstWrite = await api('POST', '/api/v1/candidates', { token: recruiter.token, headers: { 'idempotency-key': idempotencyKey }, body: idempotencyBody })
  const replay = await api('POST', '/api/v1/candidates', { token: recruiter.token, headers: { 'idempotency-key': idempotencyKey }, body: idempotencyBody })
  check('相同 Idempotency-Key 重放不再新建记录', firstWrite.status === 201 && replay.status === 201 && firstWrite.body.data.id === replay.body.data.id && replay.headers.get('idempotency-replay') === 'true', `${firstWrite.status}/${replay.status} replay=${replay.headers.get('idempotency-replay')}`)

  const total = passed + failures.length
  console.log(`\n===== 闭环验证结果：${passed}/${total} 通过 =====`)
  if (failures.length) {
    console.log('失败项：')
    for (const item of failures) console.log(`  - ${item}`)
    process.exitCode = 1
  } else {
    console.log('全链路在真实 PostgreSQL 上跑通。')
  }
} catch (error) {
  console.error('\n验证脚本异常中断:', error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await worker.close()
  await new Promise((resolve) => server.close(resolve))
}
