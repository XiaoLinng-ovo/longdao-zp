import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { projectRoot, startIsolatedPostgres } from './isolated-environment.mjs'
import { startLocalSmtpBoundary, verificationCodeFromMime } from './local-smtp-boundary.mjs'
import { startLocalModelBoundary, syntheticResumeEvidence } from './local-model-boundary.mjs'
import { testCodeFingerprint } from './test-code-fingerprint.mjs'
import { integrityFlows } from './business-browser-integrity.mjs'
import { supportFlow } from './business-browser-support.mjs'
import { startLocalAlipayBoundary } from './local-alipay-boundary.mjs'
import { paymentFlows } from './business-browser-payments.mjs'
import { startLocalAsrBoundary, syntheticMicrophoneWav } from './local-asr-boundary.mjs'
import { audioFlows } from './business-browser-audio.mjs'
import { emailRecoveryFlow } from './business-browser-email-recovery.mjs'
import { startPostgresWaitSampler } from './postgres-wait-sampler.mjs'
import { fileRecoveryFlow } from './business-browser-file-recovery.mjs'
import { answerAnalysisFlow } from './business-browser-answer-analysis.mjs'
import { verifyIsolatedBackup } from './verify-isolated-backup.mjs'
import { verifyRestoredServices } from './verify-restored-services.mjs'
import { attachApiRequestDiagnostics } from './api-request-diagnostics.mjs'
import { startBrowserWorker } from './isolated-browser-worker.mjs'
import { ephemeralLoopbackPort, isolatedBrowserIngress } from './isolated-browser-ingress.mjs'
import { sustainedMinutesFromArgs } from './sustained-resume-policy.mjs'
import { openEvidenceJournal } from './bounded-evidence-journal.mjs'
import { measureIsolatedProcessTree } from './isolated-process-tree.mjs'
import { launchIsolatedBrowser } from './isolated-browser-launch.mjs'
import { businessSustainedFlows } from './business-browser-sustained.mjs'
import { browserAction } from './browser-action.mjs'

const argument = process.argv.indexOf('--postgres-bin')
assert.ok(argument >= 0 && process.argv[argument + 1], '必须显式指定专用 PostgreSQL 工具目录')
const mixedMinutes = sustainedMinutesFromArgs(process.argv.slice(2))
const runtimeModules = process.env.CODEX_NODE_MODULES || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules')
const browserExecutable = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe') : undefined
if (browserExecutable) await access(browserExecutable)
const codeFingerprint = await testCodeFingerprint(projectRoot)
const instance = await startIsolatedPostgres(process.argv[argument + 1])
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, instance.env)
const require = createRequire(join(projectRoot, 'apps/api/package.json'))
const { Pool } = require('pg')
const admin = new Pool(instance.connection)
const report = {
  startedAt: new Date().toISOString(), scope: '真实前端、API、Worker、隔离PG；SMTP仅本机接收；不伪造业务接口成功',
  checks: [], requests: [], apiRequestDiagnostics: {}, browserErrors: [], browserNetworkFailures: [], proxyFailures: [], workerDiagnostics: [], cleanup: {}, failures: [],
  codeFingerprint,
  notYetCovered: ['真实语音准确率（按约定不验收）', '全部业务的故障与重复提交矩阵', '真实墙钟跨月流逝（仅测试预置边界日期）'],
}
let created = false, pool, smtp, model, alipay, asr, api, worker, vite, browser, activePage, origin, waitSampler
let postgresJournal, mixedJournal
const recoveryAccounts = []
const ingress = isolatedBrowserIngress()
report.frontendIngress = ingress.evidence
const workspaceIds = new WeakMap()
const output = join(instance.directory, mixedMinutes ? 'business-mixed-report.json' : 'business-browser-report.json')
const load = (app, file) => import(pathToFileURL(join(projectRoot, 'apps', app, 'dist/src', file + '.js')).href)
async function check(name, action) {
  const record = { name, startedAt: new Date().toISOString() }; report.checks.push(record)
  console.log('验证：' + name)
  try {
    const result = await action()
    record.result = result?.page ? { userId: result.userId, userNo: result.userNo, workspaceId: result.id } : result
    record.passed = true
    return result
  }
  catch (error) { record.passed = false; throw error }
  finally { record.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2)) }
}
async function waitFor(predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!await predicate()) { assert.ok(Date.now() < deadline, '等待超时：' + label); await delay(25) }
}
function futureDate(days) {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
async function responseAfter(page, method, path, action, expected = 200) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1' + path && response.request().method() === method)
  const response = await browserAction(pending, action)
  assert.equal(response.status(), expected, await response.text())
  return (await response.json()).data
}
async function json(page, method, path, body, extraHeaders = {}, workspaceId = workspaceIds.get(page)) {
  extraHeaders = { ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}), ...extraHeaders }
  return page.evaluate(async ({ method, path, body, extraHeaders }) => {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('smartrecruit_csrf='))?.split('=').slice(1).join('=')
    const response = await fetch('/api/v1' + path, { method, headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }, { method, path, body, extraHeaders })
}
async function contextPage(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, permissions: ['microphone'] })
  await context.addCookies([ingress.cookie(origin)])
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin === origin) return route.continue()
    if (alipay && url.origin === 'https://openapi.alipay.com' && url.pathname === '/gateway.do' && request.method() === 'GET' && request.isNavigationRequest()) {
      try { return await route.fulfill({ status: 200, contentType: 'text/html;charset=utf-8', body: await alipay.browserHandoff(request.url()) }) }
      catch (error) { report.browserErrors.push('本机支付交接失败：' + error.message); return route.abort() }
    }
    return route.abort()
  })
  const page = await context.newPage(); page.setDefaultTimeout(12000)
  page.on('pageerror', error => report.browserErrors.push(error.message))
  page.on('requestfailed', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) report.browserNetworkFailures.push({ at: new Date().toISOString(), method: request.method(), path: url.pathname, code: request.failure()?.errorText })
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname.startsWith('/api/')) report.requests.push({ method: response.request().method(), path: url.pathname, status: response.status() })
  })
  return page
}
async function signup(index) {
  const page = await contextPage(); activePage = page
  const email = 'browser-' + index + '@example.invalid', password = randomBytes(20).toString('base64url')
  await page.goto(origin + '/register')
  await page.getByRole('heading', { name: '创建企业账号', exact: true }).waitFor()
  assert.equal(await page.locator('vite-error-overlay').count(), 0)
  assert.ok((await page.locator('body').innerText()).length > 100)
  await page.getByLabel('企业名称', { exact: true }).fill('隔离浏览器企业' + index)
  await page.getByLabel('姓名', { exact: true }).fill('普通测试用户' + index)
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  const codeResponse = page.waitForResponse(response => response.url().endsWith('/auth/registration/code') && response.request().method() === 'POST')
  assert.equal((await browserAction(codeResponse, () => page.getByRole('button', { name: '发送邮箱验证码', exact: true }).click())).status(), 200)
  await waitFor(() => smtp.messages.some(message => message.recipients.includes(email)), '注册验证码邮件')
  const message = smtp.messages.findLast(message => message.recipients.includes(email))
  const code = verificationCodeFromMime(message.raw)
  await page.getByLabel('邮箱验证码', { exact: true }).fill(code)
  const registration = page.waitForResponse(response => response.url().endsWith('/auth/register') && response.request().method() === 'POST')
  const response = await browserAction(registration, () => page.getByRole('button', { name: '验证并完成注册', exact: true }).click())
  assert.equal(response.status(), 201, '真实注册失败：' + await response.text())
  const result = (await response.json()).data
  await page.waitForURL(origin + '/')
  const company = { page, email, password, userId: result.user.id, userNo: result.user.userNo, id: result.workspace.id, schema: 'company_' + result.workspace.id.replaceAll('-', '') }
  workspaceIds.set(page, company.id)
  assert.equal(result.user.role, 'recruiter'); assert.ok(!result.user.isSystemAdmin)
  assert.match(company.userNo, /^USR-[A-F0-9]{10}$/)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pg_namespace WHERE nspname=$1', [company.schema])).rows[0].n, 1)
  assert.equal((await pool.query('SELECT business_role FROM organization_members WHERE organization_id=$1 AND user_id=$2', [company.id, company.userId])).rows[0].business_role, 'recruiter')
  const replay = await json(page, 'POST', '/auth/register', { companyName: '不应重复创建', name: '重复', email, password, verificationCode: code })
  assert.equal(replay.status, 400)
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE email=$1', [email])).rows[0].n, 1)
  await page.screenshot({ path: join(instance.directory, 'registered-' + index + '.png'), fullPage: true })
  return company
}
async function createJob(company) {
  const page = company.page; activePage = page
  await page.goto(origin + '/enterprise/departments')
  await page.getByLabel('新增部门', { exact: true }).fill('合成研发部')
  const departmentResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/departments') && response.request().method() === 'POST')
  const department = await browserAction(departmentResponse, () => page.getByRole('button', { name: '新增部门', exact: true }).click())
  assert.equal(department.status(), 201, await department.text())
  const dept = (await department.json()).data
  await page.locator('tbody tr').getByText('合成研发部', { exact: true }).waitFor()
  await page.goto(origin + '/jobs')
  await page.getByRole('button', { name: '新建岗位', exact: true }).click()
  const dialog = page.locator('.job-create-dialog')
  await dialog.locator('.form-field').filter({ has: page.locator('label', { hasText: '岗位名称' }) }).locator('input').fill('合成软件工程师')
  await dialog.locator('select').filter({ has: page.locator('option', { hasText: '请选择部门' }) }).selectOption(dept.code)
  const jobResponse = page.waitForResponse(response => response.url().endsWith('/jobs') && response.request().method() === 'POST')
  const response = await browserAction(jobResponse, () => dialog.getByRole('button', { name: '创建岗位', exact: true }).click())
  assert.equal(response.status(), 201, await response.text())
  const job = (await response.json()).data
  company.jobId = job.id
  company.departmentId = dept.id
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM "' + company.schema + '".jobs WHERE id=$1', [job.id])).rows[0].n, 1)
  await page.getByText('合成软件工程师', { exact: true }).first().waitFor()
  await page.goto(origin + '/jobs/' + job.id)
  const spec = page.locator('#job-document-spec')
  await spec.getByRole('button', { name: '手动填写', exact: true }).click()
  await spec.getByLabel('标题', { exact: true }).fill('合成软件工程师')
  await spec.getByLabel('摘要', { exact: true }).fill('隔离测试的软件开发岗位')
  await spec.getByLabel('要求（每行一条，可写“名称：描述”）', { exact: true }).fill('软件开发：具备软件研发经验')
  const specResponse = page.waitForResponse(response => response.url().includes('/jobs/' + job.id + '/spec') && response.request().method() === 'POST')
  const savedSpec = await browserAction(specResponse, () => spec.getByRole('button', { name: '保存', exact: true }).click())
  assert.equal(savedSpec.status(), 200, await savedSpec.text())
  const confirmed = page.waitForResponse(response => response.url().endsWith('/jobs/' + job.id + '/confirm-spec') && response.request().method() === 'POST')
  const confirmation = await browserAction(confirmed, () => spec.getByRole('button', { name: '确认', exact: true }).click())
  assert.equal(confirmation.status(), 200, await confirmation.text())
  return { departmentId: dept.id, jobId: job.id, confirmedRequirements: 1 }
}
async function rejectLegacyResume(company) {
  const page = company.page; activePage = page
  const schema = '"' + company.schema + '"'
  const counts = async () => (await pool.query(`SELECT (SELECT count(*)::int FROM ${schema}.resume_import_batches) AS batches,
    (SELECT count(*)::int FROM ${schema}.candidates) AS candidates,(SELECT count(*)::int FROM ${schema}.analysis_tasks) AS tasks`)).rows[0]
  const before = await counts(), requestStart = report.requests.length
  await page.goto(origin + '/candidates')
  await page.getByRole('button', { name: '上传简历并建档', exact: true }).click()
  await page.locator('#candidate-resume-job').selectOption(company.jobId)
  await page.locator('#candidate-resume-file').setInputFiles({ name: '合成旧版简历.DOC', mimeType: 'application/msword', buffer: Buffer.from('synthetic-legacy-document') })
  await page.getByText('合成旧版简历.DOC：请转为 DOCX 或 PDF 后上传', { exact: true }).waitFor()
  assert.ok(!(await page.locator('#candidate-resume-file').getAttribute('accept')).split(',').includes('.doc'))
  await page.locator('.resume-submit').click()
  await page.getByText('请选择简历文件', { exact: true }).waitFor()
  assert.deepEqual(await counts(), before)
  assert.deepEqual(report.requests.slice(requestStart).filter(item => item.method === 'POST' && item.path.startsWith('/api/v1/resume-import-batches')), [])
  await page.screenshot({ path: join(instance.directory, 'legacy-doc-rejected.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭上传简历窗口', exact: true }).click()
  return { rejectedBeforeRequest: true, databaseUnchanged: true, existingDocumentDownloadsRetained: '单测单独验证' }
}
async function importResumes(company, count, { screenshot = true } = {}) {
  const page = company.page; activePage = page
  const modelCountBefore = model.requests.filter(request => request.kind === 'resume').length
  await page.goto(origin + '/candidates')
  await page.getByRole('button', { name: '上传简历并建档', exact: true }).click()
  const content = Buffer.from(('姓名：合成同名人员\n邮箱：candidate@example.invalid\n学历：本科\n' + syntheticResumeEvidence + '\n').repeat(10))
  await page.locator('#candidate-resume-file').setInputFiles(Array.from({ length: count }, (_, index) => ({ name: '合成同名人员-' + index + '.txt', mimeType: 'text/plain', buffer: content })))
  await page.locator('#candidate-resume-job').selectOption(company.jobId)
  const batchResponse = page.waitForResponse(response => response.url().endsWith('/resume-import-batches') && response.request().method() === 'POST')
  const response = await browserAction(batchResponse, () => page.locator('.resume-submit').click())
  assert.equal(response.status(), 201, await response.text())
  const batch = (await response.json()).data
  company.batchId = batch.id
  await waitFor(async () => {
    const tasks = (await pool.query(`SELECT t.status,t.last_error FROM "${company.schema}".resume_import_items i
      JOIN "${company.schema}".analysis_tasks t ON t.id=i.analysis_task_id WHERE i.batch_id=$1`, [batch.id])).rows
    assert.equal(tasks.filter(task => task.status === 'failed').length, 0, '真实Worker任务失败：' + JSON.stringify(tasks.filter(task => task.status === 'failed')))
    return tasks.filter(task => task.status === 'completed').length === count
  }, '真实后台解析完成', 30000)
  const candidates = (await pool.query(`SELECT c.id,c.candidate_no,c.name FROM "${company.schema}".resume_import_items i
    JOIN "${company.schema}".candidates c ON c.id=i.candidate_id WHERE i.batch_id=$1 ORDER BY c.created_at,c.id`, [batch.id])).rows
  assert.equal(candidates.length, count)
  assert.equal(new Set(candidates.map(row => row.candidate_no)).size, count)
  assert.equal(new Set(candidates.map(row => row.id)).size, count)
  assert.equal(new Set(candidates.map(row => row.name)).size, 1, '同名测试必须确实是同名')
  company.candidates = candidates
  assert.equal(model.requests.filter(request => request.kind === 'resume').length - modelCountBefore, count, '必须由真实Worker调用本机模型完成评分')
  assert.deepEqual(model.failures, [])
  if (screenshot) await page.screenshot({ path: join(instance.directory, 'import-' + count + '.png'), fullPage: true })
  return { count, distinctIds: count, distinctNumbers: count, tasksCompleted: count, batchId: batch.id }
}
async function login(page, company, password = company.password, destination = '/') {
  await page.goto(origin + '/login' + (destination === '/' ? '' : '?redirect=' + encodeURIComponent(destination)))
  await page.getByLabel('邮箱', { exact: true }).fill(company.email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  const pending = page.waitForResponse(response => response.url().endsWith('/auth/login') && response.request().method() === 'POST')
  const response = await browserAction(pending, () => page.getByRole('button', { name: '登录工作空间', exact: true }).click())
  assert.equal(response.status(), 200, await response.text())
  await page.waitForURL(origin + destination)
  workspaceIds.set(page, company.id)
}
async function accountRecovery(company) {
  const original = company.page
  const page = await contextPage(); activePage = page
  await login(page, company)
  const oldSession = await json(original, 'GET', '/me')
  assert.equal(oldSession.status, 200)
  const resetPage = await contextPage()
  await resetPage.goto(origin + '/forgot-password')
  await resetPage.getByLabel('注册邮箱', { exact: true }).fill(company.email)
  const before = smtp.messages.length
  const requested = resetPage.waitForResponse(response => response.url().endsWith('/auth/password-reset/request') && response.request().method() === 'POST')
  assert.equal((await browserAction(requested, () => resetPage.getByRole('button', { name: '发送验证码', exact: true }).click())).status(), 200)
  await waitFor(() => smtp.messages.slice(before).some(message => message.recipients.includes(company.email)), '密码恢复邮件')
  const code = verificationCodeFromMime(smtp.messages.findLast(message => message.recipients.includes(company.email)).raw)
  const newPassword = randomBytes(20).toString('base64url')
  await resetPage.getByLabel('邮箱验证码', { exact: true }).fill(code)
  await resetPage.getByPlaceholder('至少 8 个字符', { exact: true }).fill(newPassword)
  await resetPage.getByLabel('确认新密码', { exact: true }).fill(newPassword)
  const confirmed = resetPage.waitForResponse(response => response.url().endsWith('/auth/password-reset/confirm') && response.request().method() === 'POST')
  assert.equal((await browserAction(confirmed, () => resetPage.getByRole('button', { name: '重置密码', exact: true }).click())).status(), 200)
  await resetPage.waitForURL(/\/login/)
  assert.equal((await json(original, 'GET', '/me')).status, 401, '注册时的会话必须失效')
  assert.equal((await json(page, 'GET', '/me')).status, 401, '其他登录会话必须失效')
  const replay = await json(resetPage, 'POST', '/auth/password-reset/confirm', { email: company.email, verificationCode: code, password: newPassword })
  assert.equal(replay.status, 400)
  const oldPassword = await json(resetPage, 'POST', '/auth/login', { email: company.email, password: company.password })
  assert.equal(oldPassword.status, 401)
  company.password = newPassword
  await login(resetPage, company)
  await resetPage.getByRole('button', { name: '打开用户信息', exact: true }).click()
  const loggedOut = resetPage.waitForResponse(response => response.url().endsWith('/auth/logout') && response.request().method() === 'POST')
  assert.equal((await browserAction(loggedOut, () => resetPage.getByRole('button', { name: '退出登录', exact: true }).click())).status(), 200)
  await resetPage.waitForURL(/\/login/)
  assert.equal((await json(resetPage, 'GET', '/me')).status, 401)
  await login(resetPage, company)
  company.page = resetPage
  return { staleSessionsRejected: 2, otpReplayStatus: replay.status, oldPasswordStatus: oldPassword.status, logoutRevoked: true, newPasswordLogin: true }
}
async function exceedTrialQuota(company) {
  const page = company.page; activePage = page
  await page.goto(origin + '/candidates')
  await page.getByRole('button', { name: '上传简历并建档', exact: true }).click()
  await page.locator('#candidate-resume-file').setInputFiles({ name: '超额不应建档.txt', mimeType: 'text/plain', buffer: Buffer.from('姓名：超额人员\n邮箱：over-quota@example.invalid\n经验：测试软件研发') })
  await page.locator('#candidate-resume-job').selectOption(company.jobId)
  const rejected = page.waitForResponse(response => response.request().method() === 'POST' && /\/resume-import-batches\/.*\/content$/.test(response.url()))
  const response = await browserAction(rejected, () => page.locator('.resume-submit').click())
  assert.equal(response.status(), 409, await response.text())
  const result = await response.json()
  assert.equal(result.error.code, 'TRIAL_RESUME_LIMIT_REACHED')
  await page.locator('.resume-file-error').filter({ hasText: '试用简历额度' }).waitFor()
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM "' + company.schema + '".candidates')).rows[0].n, 3)
  await page.getByRole('button', { name: '关闭上传简历窗口', exact: true }).click()
  return { status: response.status(), code: result.error.code, candidatesUnchanged: 3 }
}
async function scheduleInitialInterview(company, onlyEligible = false) {
  const page = company.page; activePage = page
  const appointment = days => futureDate(days) + 'T10:00'
  await page.goto(origin + '/candidates')
  const rows = page.locator('.candidate-table tbody tr')
  const first = (onlyEligible ? rows.filter({ has: page.getByRole('button', { name: '初试邀约', exact: true }) }) : rows).first()
  await first.getByRole('button', { name: '初试邀约', exact: true }).click()
  const dialog = page.locator('.initial-interview-dialog')
  await dialog.getByLabel('开始时间', { exact: true }).fill(appointment(1))
  await dialog.getByLabel('初试方式', { exact: true }).selectOption('offline')
  await dialog.getByLabel('面试地点', { exact: true }).fill('合成测试会议室')
  await dialog.getByLabel('面试官（选填）', { exact: true }).selectOption(company.userId)
  const invited = page.waitForResponse(response => response.url().endsWith('/interviews') && response.request().method() === 'POST')
  const invitation = await browserAction(invited, () => dialog.getByRole('button', { name: '创建初试邀约', exact: true }).click())
  assert.equal(invitation.status(), 201, await invitation.text())
  return (await invitation.json()).data
}
async function interviewFlow(company, beforeCompletion, beforeFinalCompletion) {
  const page = company.page
  const appointment = days => futureDate(days) + 'T10:00'
  const initial = await scheduleInitialInterview(company)
  company.applicationId = initial.applicationId; company.initialInterviewId = initial.id
  if (beforeCompletion) await beforeCompletion(initial.id)
  await page.goto(origin + '/interviews')
  await page.locator('tbody tr').filter({ has: page.locator('td.round-cell', { hasText: /^1 轮$/ }) }).getByRole('button', { name: '完成', exact: true }).click()
  await page.getByLabel('面试结论', { exact: true }).selectOption('continue')
  const completed = page.waitForResponse(response => response.url().endsWith('/interviews/' + initial.id + '/complete') && response.request().method() === 'POST')
  assert.equal((await browserAction(completed, () => page.getByRole('button', { name: '确认完成', exact: true }).click())).status(), 200)
  await page.getByRole('button', { name: '安排复试', exact: true }).click()
  const finalDialog = page.locator('.arrange-dialog')
  await finalDialog.locator('fieldset:not([disabled])').waitFor()
  const finalId = await finalDialog.locator('#final-interview-select').inputValue()
  assert.ok(finalId, '必须等真实申请与面试官加载完成后再填写复试')
  await finalDialog.locator('input[type=datetime-local]').fill(appointment(2))
  await finalDialog.getByLabel('复试方式', { exact: true }).selectOption('offline')
  await finalDialog.getByPlaceholder('线下地点', { exact: true }).fill('合成复试会议室')
  await finalDialog.getByLabel('面试官', { exact: true }).selectOption(company.userId)
  const scheduled = page.waitForResponse(response => response.url().endsWith('/interviews/' + finalId) && response.request().method() === 'PATCH')
  assert.equal((await browserAction(scheduled, () => finalDialog.getByRole('button', { name: '确认安排复试', exact: true }).click())).status(), 200)
  if (beforeFinalCompletion) {
    await beforeFinalCompletion(finalId)
    await page.goto(origin + '/interviews')
  }
  await page.locator('tbody tr').filter({ has: page.locator('td.round-cell', { hasText: /^2 轮$/ }) }).getByRole('button', { name: '完成', exact: true }).click()
  await page.getByLabel('面试结论', { exact: true }).selectOption('offer')
  const offered = page.waitForResponse(response => response.url().endsWith('/interviews/' + finalId + '/complete') && response.request().method() === 'POST')
  const offeredResponse = await browserAction(offered, () => page.getByRole('button', { name: '确认完成', exact: true }).click())
  assert.equal(offeredResponse.status(), 200, await offeredResponse.text())
  company.finalInterviewId = finalId
  const interviews = (await pool.query(`SELECT i.id,i.status,
    (SELECT e.metadata->>'outcome' FROM "${company.schema}".workflow_events e
      WHERE e.subject_type='interview' AND e.subject_id=i.id AND e.event_type IN ('conclude','correct_conclusion')
      ORDER BY e.created_at DESC,e.id DESC LIMIT 1) AS outcome
    FROM "${company.schema}".interviews i WHERE application_id=$1 ORDER BY round`, [initial.applicationId])).rows
  assert.deepEqual(interviews.map(row => [row.status, row.outcome]), [['completed', 'continue'], ['completed', 'offer']])
  await page.screenshot({ path: join(instance.directory, 'interviews-completed.png'), fullPage: true })
  return { initialId: initial.id, finalId, applicationId: initial.applicationId, states: interviews.map(row => ({ status: row.status, outcome: row.outcome })) }
}
async function offerFlow(company) {
  const page = company.page; activePage = page
  await page.goto(origin + '/offers')
  await page.getByRole('button', { name: '填写 Offer', exact: true }).click()
  const dialog = page.locator('.offer-create-dialog')
  const field = label => dialog.locator('.form-field').filter({ has: page.locator('label').and(page.getByText(label, { exact: true })) })
  await field('申请').locator('select').selectOption(company.applicationId)
  await field('岗位').locator('select').selectOption({ label: '合成软件工程师（合成研发部）' })
  await field('部门').locator('select').selectOption({ label: '合成研发部' })
  await field('用工类型').locator('select').selectOption('full_time')
  await dialog.getByPlaceholder('请输入候选人报到地点', { exact: true }).fill('合成报到会议室')
  await dialog.getByLabel('报到日期', { exact: true }).fill(futureDate(7))
  await dialog.getByLabel('报到时刻', { exact: true }).fill('09:30')
  await field('试用期工资（元/月）').locator('input').fill('10000')
  await field('转正期工资（元/月）').locator('input').fill('12000')
  const materials = dialog.locator('details.offer-materials-field')
  if (!await materials.evaluate(element => element.open)) await materials.locator('summary').click()
  for (const checkbox of await materials.locator('input[type=checkbox]').all()) await checkbox.setChecked((await checkbox.getAttribute('value')) === 'id_card')
  await dialog.locator('[contenteditable=true]').fill('合成同名人员，现邀请您担任合成软件工程师，请按约定日期报到并携带身份证。')
  const offer = await responseAfter(page, 'POST', '/offers', () => dialog.getByRole('button', { name: '保存草稿', exact: true }).click(), 201)
  company.offerId = offer.id
  await dialog.waitFor({ state: 'hidden' })
  await page.goto(origin + '/offers/' + offer.id)
  await page.getByRole('button', { name: '发送 Offer', exact: true }).click()
  const email = page.locator('.offer-email-dialog')
  await email.getByLabel('收件人', { exact: true }).fill('candidate@example.invalid')
  await email.getByLabel('邮件主题', { exact: true }).fill('合成录用通知')
  const before = smtp.messages.length
  const preview = await responseAfter(page, 'POST', '/offers/' + offer.id + '/email-preview', () => email.getByRole('button', { name: '预览邮件', exact: true }).click())
  assert.equal(smtp.messages.length, before, '邮件预览不能发送邮件')
  assert.equal(preview.to, 'candidate@example.invalid')
  await responseAfter(page, 'POST', '/offers/' + offer.id + '/send-email', () => email.getByRole('button', { name: '确认发送', exact: true }).click())
  await email.waitFor({ state: 'hidden' })
  assert.equal(smtp.messages.length, before + 1)
  assert.deepEqual(smtp.messages.at(-1).recipients, ['candidate@example.invalid'])
  const ledger = (await pool.query('SELECT id,status,message_id FROM public.offer_email_deliveries WHERE organization_id=$1 AND offer_id=$2', [company.id, offer.id])).rows
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].status, 'completed')
  assert.ok(smtp.messages.at(-1).raw.includes(ledger[0].message_id), '投递账本必须对应实际 SMTP Message-ID')
  const accepted = await responseAfter(page, 'POST', '/offers/' + offer.id + '/accept', () => page.getByRole('button', { name: '候选人接受', exact: true }).click())
  assert.equal(accepted.status, 'accepted')
  await responseAfter(page, 'POST', '/offers/' + offer.id + '/archive-onboarding', () => page.getByRole('button', { name: '入职归档', exact: true }).click())
  const onboardings = (await pool.query('SELECT id,status FROM "' + company.schema + '".onboarding_records WHERE offer_id=$1', [offer.id])).rows
  assert.equal(onboardings.length, 1)
  assert.equal(onboardings[0].status, 'pending')
  company.onboardingId = onboardings[0].id
  await page.screenshot({ path: join(instance.directory, 'offer-archived.png'), fullPage: true })
  return { offerId: offer.id, previewDidNotSend: true, localSmtpAccepted: 1, ledgerStatus: ledger[0].status, onboardingId: company.onboardingId, realDeliveryVerified: false }
}
async function onboardingFlow(company, other) {
  const page = company.page; activePage = page
  const path = '/onboarding/' + company.onboardingId
  const getMaterials = () => json(page, 'GET', path + '/materials')
  const initial = (await getMaterials()).body.data
  assert.ok(initial.some(material => material.code === 'id_card'))
  const denied = []
  for (const [method, suffix, body] of [
    ['GET', '', undefined], ['GET', '/materials', undefined],
    ['POST', '/materials', { code: 'cross_company', label: '不应创建的材料' }],
    ['PATCH', '/materials/' + initial[0].id, { status: 'verified', notes: '不应更新的备注' }],
    ['POST', '/complete', {}],
  ]) {
    const response = await json(other.page, method, path + suffix, body)
    assert.ok([403, 404].includes(response.status), '跨公司入职资源必须拒绝：' + method + suffix)
    denied.push({ method, suffix, status: response.status })
  }
  assert.deepEqual((await getMaterials()).body.data, initial, '拒绝请求不能修改材料')
  await page.goto(origin + '/onboarding')
  await page.getByRole('button', { name: '进入工作台', exact: true }).click()
  const workbench = page.locator('.onboarding-workbench')
  await responseAfter(page, 'POST', path + '/prepare', () => workbench.getByRole('button', { name: '开始准备', exact: true }).click())
  const tabs = workbench.getByRole('navigation', { name: '入职工作台模块' })
  await tabs.getByRole('button', { name: '报到', exact: true }).click()
  const schedule = workbench.getByRole('region', { name: '报到安排', exact: true })
  await schedule.getByLabel('计划日期', { exact: true }).fill(futureDate(7))
  await schedule.getByLabel('计划时间', { exact: true }).fill('09:30')
  await schedule.locator('label.field').filter({ has: page.locator('span').and(page.getByText('报到方式', { exact: true })) }).locator('select').selectOption('onsite')
  await schedule.getByLabel('报到地点 / 线上链接', { exact: true }).fill('合成报到会议室')
  await schedule.getByLabel('报到联系人', { exact: true }).fill('普通测试用户1')
  await schedule.getByLabel('联系人电话', { exact: true }).fill('13800000000')
  await responseAfter(page, 'POST', path + '/schedule', () => schedule.getByRole('button', { name: '保存并确认报到', exact: true }).click())
  const early = await json(page, 'POST', path + '/complete', {})
  assert.equal(early.status, 409)
  assert.equal(early.body.error.code, 'ONBOARDING_COMPLETION_BLOCKED')
  await workbench.getByRole('button', { name: '确认已报到', exact: true }).click()
  await workbench.getByText(/仍有 .*项必选任务.*项必选材料未完成/).waitFor()
  await tabs.getByRole('button', { name: /^材料/ }).click()
  const materialPanel = workbench.getByRole('region', { name: '入职材料核验', exact: true })
  const material = materialPanel.locator('article.material-item').filter({ hasText: '身份证' })
  await material.locator('label.field').filter({ has: page.locator('span').and(page.getByText('核验状态', { exact: true })) }).locator('select').selectOption('verified')
  await material.getByLabel('核验备注', { exact: true }).fill('普通用户已核验合成材料')
  await responseAfter(page, 'PATCH', path + '/materials/' + initial.find(item => item.code === 'id_card').id, () => material.getByRole('button', { name: '保存核验', exact: true }).click())
  const verified = (await getMaterials()).body.data.find(item => item.code === 'id_card')
  assert.equal(verified.status, 'verified')
  assert.equal(verified.notes, '普通用户已核验合成材料')
  assert.ok(verified.verifiedAt)
  const extra = materialPanel.locator('.new-item-panel')
  await extra.getByLabel('材料编码', { exact: true }).fill('synthetic_optional')
  await extra.getByLabel('材料名称', { exact: true }).fill('合成补充材料')
  await extra.getByLabel('纳入入职就绪度', { exact: true }).uncheck()
  const added = await responseAfter(page, 'POST', path + '/materials', () => extra.getByRole('button', { name: '添加材料', exact: true }).click(), 201)
  assert.equal(added.isRequired, false)
  await tabs.getByRole('button', { name: /^任务/ }).click()
  const tasks = (await json(page, 'GET', path + '/tasks')).body.data
  for (const task of tasks.filter(item => item.isRequired)) {
    const row = workbench.locator('article.line-item').filter({ has: page.getByText(task.title, { exact: true }) })
    await row.locator('label.field').filter({ has: page.locator('span').and(page.getByText('状态', { exact: true })) }).locator('select').selectOption('completed')
    await responseAfter(page, 'PATCH', path + '/tasks/' + task.id, () => row.getByRole('button', { name: '保存任务', exact: true }).click())
  }
  const completed = await responseAfter(page, 'POST', path + '/complete', () => workbench.getByRole('button', { name: '确认已报到', exact: true }).click())
  assert.equal(completed.status, 'completed')
  await tabs.getByRole('button', { name: /^材料/ }).click()
  await material.getByLabel('核验备注', { exact: true }).fill('报到完成后补录备注')
  await responseAfter(page, 'PATCH', path + '/materials/' + verified.id, () => material.getByRole('button', { name: '保存核验', exact: true }).click())
  await workbench.getByRole('button', { name: '关闭入职工作台', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: '进入工作台', exact: true }).click()
  await tabs.getByRole('button', { name: /^材料/ }).click()
  assert.equal(await material.getByLabel('核验备注', { exact: true }).inputValue(), '报到完成后补录备注')
  const stored = (await pool.query('SELECT status,notes,verified_by_user_id FROM "' + company.schema + '".onboarding_materials WHERE id=$1', [verified.id])).rows[0]
  assert.equal(stored.status, 'verified')
  assert.equal(stored.notes, '报到完成后补录备注')
  assert.equal(stored.verified_by_user_id, company.userId)
  await page.screenshot({ path: join(instance.directory, 'onboarding-materials-completed.png'), fullPage: true })
  return { onboardingId: company.onboardingId, crossCompanyDenied: denied, incompleteRejected: early.body.error.code, tasksCompleted: tasks.filter(item => item.isRequired).length, ordinaryUserMaterialVerified: true, optionalRequiredFalsePreserved: true, completedRecordEditable: true, reloadPreserved: true }
}
try {
  assert.equal(await realpath(instance.directory), instance.directory)
  for (const [key, name] of [['RECRUITING_QUARANTINE_ROOT', 'storage'], ['INTERVIEW_STORAGE_ROOT', 'interviews']]) {
    const root = join(instance.directory, name)
    assert.equal(process.env[key], root)
    await mkdir(root)
    assert.equal(await realpath(root), root)
  }
  report.storageIsolation = { sharedObjects: process.env.RECRUITING_QUARANTINE_ROOT, interviewFallback: process.env.INTERVIEW_STORAGE_ROOT }
  assert.equal((await admin.query('SHOW cluster_name')).rows[0].cluster_name, instance.cluster)
  await admin.query('CREATE DATABASE "' + instance.database + '"'); created = true
  pool = new Pool({ ...instance.connection, database: instance.database })
  const smtpPassword = randomBytes(24).toString('base64url')
  smtp = await startLocalSmtpBoundary({ user: 'sender@example.invalid', password: smtpPassword })
  const modelKey = randomBytes(24).toString('base64url')
  model = await startLocalModelBoundary({ apiKey: modelKey })
  Object.assign(process.env, { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_USER: 'sender@example.invalid', SMTP_PASSWORD: smtpPassword, SMTP_FROM: 'sender@example.invalid', AUTH_OTP_HMAC_SECRET: randomBytes(40).toString('hex'), ISOLATED_ALLOWED_PORTS: instance.env.ISOLATED_ALLOWED_PORTS + ',' + smtp.port })
  const guard = require(join(projectRoot, 'scripts/isolated-network-guard.cjs'))
  guard.allowLoopbackPort(model.port)
  const asrToken = randomBytes(24).toString('base64url')
  asr = await startLocalAsrBoundary({ token: asrToken })
  guard.allowLoopbackPort(asr.port)
  Object.assign(process.env, { FUNASR_BASE_URL: 'http://127.0.0.1:' + asr.port + '/transcribe', FUNASR_TOKEN: asrToken, INTERVIEW_AUDIO_POLL: 'on' })
  alipay = await startLocalAlipayBoundary()
  guard.allowLoopbackPort(alipay.port)
  Object.assign(process.env, { PAYMENT_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PAYMENT_PUBLIC_BASE_URL: 'https://isolated-payments.example.com' })
  Object.assign(process.env, { WORKER_USE_LLM_ANALYSIS: 'true', OPENAI_BASE_URL: 'http://127.0.0.1:' + model.port + '/v1', OPENAI_API_KEY: modelKey, OPENAI_MODEL: 'isolated-synthetic-model', OPENAI_TIMEOUT_MS: '10000' })
  const { resolveEnvFilePath, readEnvValues } = await load('api', 'admin/env-file')
  assert.equal(resolveEnvFilePath(), process.env.ENV_FILE_PATH)
  assert.equal((await readEnvValues(resolveEnvFilePath())).size, 0)
  process.env.OBJECT_CLEANUP_POLL = 'on'
  const { runMigrations } = await load('api', 'db/migrations')
  report.migrations = (await runMigrations(pool, join(projectRoot, 'db/migrations'))).applied.length
  if (mixedMinutes) {
    postgresJournal = await openEvidenceJournal(join(instance.directory, 'mixed-postgres.jsonl'), 128 * 1024 ** 2)
    mixedJournal = await openEvidenceJournal(join(instance.directory, 'mixed-cycles-resources.jsonl'), 64 * 1024 ** 2)
    report.mixedEvidence = { postgres: postgresJournal.evidence, cyclesAndResources: mixedJournal.evidence }
  }
  waitSampler = await startPostgresWaitSampler(admin, instance.database, mixedMinutes ? { intervalMs: 1000, limit: 4, onSample: record => postgresJournal.append(record) } : undefined)
  report.postgresWaits = waitSampler.evidence
  const { startServer } = await load('api', 'server'), { loadConfig } = await load('api', 'config')
  const { PaymentService } = await load('api', 'payments/service'), { createProvider } = await load('api', 'payments/providers')
  const payments = new PaymentService(pool, (kind, config) => {
    assert.equal(kind, 'alipay', '此测试只允许本机合成支付宝渠道')
    return createProvider(kind, config, alipay.transport)
  }, process.env, url => alipay.downloadBill(url))
  api = await startServer(loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: '0' }), { paymentService: payments })
  attachApiRequestDiagnostics(api, { evidence: report.apiRequestDiagnostics })
  const apiPort = api.address().port
  guard.allowLoopbackPort(api.address().port)
  worker = await startBrowserWorker({ instance, runtimeEnv: process.env, onDiagnostic(message) {
    report.workerDiagnostics.push({ ...message, recentSamples: waitSampler.evidence.samples.slice(-4) })
    console.error(message.message)
  } })
  report.workerProcess = worker.evidence
  const webRequire = createRequire(join(projectRoot, 'web/package.json'))
  const { createServer } = await import(pathToFileURL(join(projectRoot, 'web/node_modules/vite/dist/node/index.js')).href)
  const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href)
  const proxyTarget = 'http://127.0.0.1:' + api.address().port
  const frontendPort = await ephemeralLoopbackPort()
  vite = await createServer({ root: join(projectRoot, 'web'), configFile: false, envFile: false, plugins: [ingress.plugin, vue()], server: { host: '127.0.0.1', port: frontendPort, strictPort: true, proxy: {
    '/api': { target: proxyTarget, configure(proxy) {
      proxy.on('proxyReq', req => req.setHeader('origin', 'http://127.0.0.1:5173'))
      proxy.on('error', (error, request) => report.proxyFailures.push({ at: new Date().toISOString(), code: error.code ?? 'PROXY_FAILED', method: request.method, path: new URL(request.url, origin).pathname }))
    } },
    '/funasr-stream': { target: proxyTarget, ws: true, configure(proxy) { proxy.on('proxyReqWs', req => req.setHeader('origin', 'http://127.0.0.1:5173')) } },
  } } })
  await vite.listen(); origin = 'http://127.0.0.1:' + vite.httpServer.address().port
  assert.equal(vite.httpServer.address().port, frontendPort)
  report.frontendPort = frontendPort
  guard.allowLoopbackPort(vite.httpServer.address().port)
  const runtime = createRequire(join(runtimeModules, 'playwright/package.json'))
  const { chromium } = runtime('playwright')
  const microphoneFile = join(instance.directory, 'synthetic-microphone.wav')
  await writeFile(microphoneFile, syntheticMicrophoneWav())
  const launched = await launchIsolatedBrowser(chromium, { channel: 'chrome', ...(browserExecutable ? { executablePath: browserExecutable } : {}), headless: true, args: ['--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + microphoneFile] })
  browser = launched.browser
  report.browserRuntime = { channel: 'chrome', executable: browserExecutable, version: browser.version(), nativeFileMicrophone: true, windowsTcpWorkaround: launched.windowsTcpWorkaround }
  const a = await check('真实注册、邮件验证码消费、普通用户及公司Schema创建', () => signup(1))
  // Keep credentials and live browser objects out of the durable evidence.
  report.checks.at(-1).result = { userId: a.userId, userNo: a.userNo, workspaceId: a.id }
  const b = await check('第二家公司真实注册与独立Schema', () => signup(2))
  report.checks.at(-1).result = { userId: b.userId, userNo: b.userNo, workspaceId: b.id }
  recoveryAccounts.push(a, b)
  if (mixedMinutes) {
    report.scope = '真实浏览器混合子集；同一隔离实例；API与前端同运行器，Worker独立进程；外部服务为本机替身'
    report.notYetCovered.push('持续负载未覆盖所有业务及单故障矩阵；本报告不替代完整业务和恢复验收')
    const audio = audioFlows({ pool, instance, json, responseAfter, waitFor, origin, boundary: asr, activate(page) { activePage = page } })
    const payment = paymentFlows({ pool, instance, json, responseAfter, origin, boundary: alipay, boundaryHeaders: ingress.requestHeaders, activate(page) { activePage = page } })
    const mixed = businessSustainedFlows({ pool, instance, json, responseAfter, waitFor, origin, workspaceIds, report,
      contextPage, login, importResumes, scheduleInitialInterview, audio, payment, journal: mixedJournal,
      sample: () => measureIsolatedProcessTree([process.pid, worker.evidence.pid]),
      healthy() {
        assert.ok(!worker.evidence.exit, '隔离Worker提前退出')
        for (const errors of [asr.failures, model.failures, alipay.failures, report.browserErrors, report.workerDiagnostics,
          report.proxyFailures, waitSampler.evidence.errors, report.apiRequestDiagnostics.socketErrors]) assert.deepEqual(errors, [])
        for (const ledger of [report.requests, report.browserNetworkFailures, asr.requests, asr.streams, model.requests, alipay.requests]) {
          assert.ok(ledger.length < 100000, '运行器证据条数超过安全预算')
        }
      },
    })
    await check('准备隔离混合业务：唯一平台管理员、普通账号、两公司切换和本机订阅', () => mixed.prepare(a, b))
    await check('订阅生效后由普通用户创建混合负载岗位', () => createJob(b))
    await check('同一隔离实例持续混合导入、切换、录音、删除与重复付款通知', () => mixed.run(a, b, mixedMinutes))
  } else {
  await check('普通用户真实创建部门与岗位', () => createJob(a))
  await check('真实浏览器拒绝旧版DOC、提示转换且不创建档案或解析任务', () => rejectLegacyResume(a))
  await check('真实浏览器并发导入同名简历、Worker完成、独立随机编码', () => importResumes(a, 3))
  await check('跨公司对象、导入任务及平台接口拒绝', async () => {
    const missing = await json(a.page, 'GET', '/candidates', undefined, {}, null)
    assert.equal(missing.status, 409)
    assert.equal(missing.body.error.code, 'WORKSPACE_CONTEXT_REQUIRED')
    const changed = await json(a.page, 'GET', '/candidates', undefined, {}, b.id)
    assert.equal(changed.status, 409)
    assert.equal(changed.body.error.code, 'WORKSPACE_CONTEXT_CHANGED')
    const cases = [
      ['GET', '/candidates/' + a.candidates[0].id, [403, 404]],
      ['DELETE', '/candidates/' + a.candidates[0].id, [403, 404]],
      ['GET', '/resume-import-batches/' + a.batchId, [403, 404]],
      ['GET', '/admin/users', [403]], ['GET', '/platform/users', [403]],
    ]
    const results = []
    for (const [method, path, expected] of cases) {
      const response = await json(b.page, method, path)
      assert.ok(expected.includes(response.status), path + '：' + response.status)
      results.push({ method, path, status: response.status, code: response.body.error?.code })
    }
    const own = await json(a.page, 'GET', '/candidates/' + a.candidates[0].id)
    assert.equal(own.status, 200)
    return { missingAssertion: missing.body.error.code, mismatchedAssertion: changed.body.error.code, crossCompany: results }
  })
  await check('真实页面密码重置、旧会话失效、验证码不可重放及退出登录', () => accountRecovery(b))
  await check('试用超额真实上传拒绝且不产生额外档案', () => exceedTrialQuota(a))
  const audio = audioFlows({ pool, instance, json, responseAfter, waitFor, origin, boundary: asr, activate(page) { activePage = page } })
  const answer = answerAnalysisFlow({ pool, instance, json, responseAfter, waitFor, origin, asr, model, activate(page) { activePage = page } })
  await check('真实页面初试、晋级、复试安排及完成进入Offer', () => interviewFlow(a,
    id => check('合成文件麦克风真实采集、流式网关、后台转写、原音频回放与跨公司拒绝', () => audio.capture(a, b, id)),
    id => check('真实手动回答、模型HTTP分析保存、整理文本编辑回读、跨公司拒绝及状态不变', () => answer(a, b, id))))
  await check('真实Offer草稿、预览、本机SMTP投递账本、接受及入职归档', () => offerFlow(a))
  await check('普通用户入职材料核验、跨公司拒绝、就绪保护及报到后补录', () => onboardingFlow(a, b))
  const integrity = integrityFlows({ pool, instance, json, responseAfter, waitFor, origin, workspaceIds, report, activate(page) { activePage = page } })
  await check('真实页面删除申请与档案、关联一致性、后台物理删除及同名保护', () => integrity.deletion(a))
  await check('真实页面创建和切换公司、同会话旧页读写删拒绝及移动端', () => integrity.workspace(a))
  await check('唯一平台管理员绑定随机账号、公司所有者普通权限及跨公司保持', () => integrity.administrator(a, b))
  const support = supportFlow({ pool, instance, json, responseAfter, origin, activate(page) { activePage = page } })
  await check('真实工单附件上传下载、跨公司保护、管理员回复及普通用户重新打开', () => support(a, b))
  const payment = paymentFlows({ pool, instance, json, responseAfter, origin, boundary: alipay, boundaryHeaders: ingress.requestHeaders, activate(page) { activePage = page } })
  await check('真实管理页面发布商品、加密渠道、启用及普通用户权限', () => payment.configure(a, b))
  await check('真实订阅下单、请求重放、错误签名与金额拒绝、8路通知幂等入账', () => payment.subscribe(a, b))
  await check('真实页面重复待付订单拒绝、渠道关单及重复取消一致性', () => payment.cancellation(a, b))
  await check('真实增购入账、未知退款及原生60秒后台轮询自然核对恢复', () => payment.addonAndRecovery(a, b))
  await check('真实订阅退款、原权益恢复、额度撤销及重复退款幂等', () => payment.subscriptionRefund(a, b))
  await check('真实商品改版、旧订单快照、续费延长及权益变化不续期', () => payment.versionAndRenewal(a, b))
  await check('真实商品历史恢复、复制归并及历史订单权益不变', () => payment.catalogRecovery(a, b))
  await check('真实账单ZIP下载解析、双边差异、损坏拒绝及权益不变', () => payment.billReconciliation(a, b))
  await check('真实页面发布计费规则、导入与Worker消费后拒绝退款且不调用外部渠道', () => payment.consumedRefund(a, b, async () => {
    await createJob(b)
    await importResumes(b, 1)
  }))
  await check('预置月末边界后真实页面续费、平闰年与三月额度结转', () => payment.calendarBoundaries(a, b))
  await check('真实后台转写未知、管理员页面核对终止、权限与版本冲突及单次审计', () => audio.recovery(a, b))
  const emailRecovery = emailRecoveryFlow({ pool, instance, json, responseAfter, origin, boundary: smtp, activate(page) { activePage = page } })
  await check('真实SMTP断连与拒收、管理员页面核对、阻止重复发信及保留已报到状态', () => emailRecovery(a, b))
  const fileRecovery = fileRecoveryFlow({ pool, instance, json, responseAfter, waitFor, origin, browser,
    activate(page) { activePage = page }, suspendApi: () => api.closeAsync(),
    async restartApi(cleanupEnabled) {
      await api.closeAsync()
      process.env.OBJECT_CLEANUP_POLL = cleanupEnabled ? 'on' : 'off'
      api = await startServer(loadConfig({ ...process.env, HOST: '127.0.0.1', PORT: String(apiPort) }), { paymentService: payments })
      attachApiRequestDiagnostics(api, { evidence: report.apiRequestDiagnostics })
      assert.equal(api.address().port, apiPort)
    },
  })
  await check('真实API重启与错误存储位置保护、管理员页面重排清理、关联删除及同名保护', () => fileRecovery(a, b))
  }
  assert.deepEqual(asr.failures, [])
  assert.deepEqual(report.browserErrors, [])
  assert.deepEqual(report.workerDiagnostics, [], '后台异常必须定位，不得把连接等待超时视为通过')
  assert.deepEqual(waitSampler.evidence.errors, [])
  report.localSmtp = { authenticated: smtp.authenticated, acceptedMessages: smtp.messages.length, externalDelivery: false }
  report.localModel = { requests: model.requests.length, failures: model.failures, paidCalls: false, realModelQualityVerified: false }
  report.coveredSubsetPassed = true
} catch (error) {
  report.coveredSubsetPassed = false; report.failures.push({ name: error.name, message: error.message, stack: error.stack }); process.exitCode = 1
  if (activePage) {
    try { await activePage.screenshot({ path: join(instance.directory, 'failure.png'), fullPage: true }); report.failurePage = await activePage.locator('body').innerText() } catch {}
  }
  console.error('业务浏览器测试失败：' + error.message)
} finally {
  if (model) report.localModel = { requests: model.requests.length, failures: model.failures, paidCalls: false, realModelQualityVerified: false }
  if (alipay) report.localPayment = { requests: alipay.requests, failures: alipay.failures, realMoneyTransferred: false, boundary: '仅替代外部支付HTTP和浏览器签名付款交接，业务订单、验签、权益与后台核对均真实执行；不访问公网支付宝' }
  if (asr) report.localAsr = { requests: asr.requests, streams: asr.streams, failures: asr.failures, realRecognitionAccuracyVerified: false, boundary: '浏览器原生文件麦克风、录音与业务服务真实执行；仅外部识别HTTP与WS为合成边界' }
  const clean = async (name, action) => { try { await action(); report.cleanup[name] = true } catch (error) { report.failures.push({ cleanup: name, message: error.message }); process.exitCode = 1; report.coveredSubsetPassed = false } }
  await clean('browserClosed', () => browser?.close())
  await clean('frontendClosed', () => vite?.close())
  await clean('apiClosed', () => api?.closeAsync())
  await clean('workerClosed', () => worker?.close())
  await clean('smtpClosed', () => smtp?.close())
  await clean('modelClosed', () => model?.close())
  await clean('paymentBoundaryClosed', () => alipay?.close())
  await clean('asrBoundaryClosed', () => asr?.close())
  await clean('waitSamplerStopped', () => waitSampler?.stop())
  if (mixedMinutes) await clean('mixedEvidenceVerified', async () => {
    const results = await Promise.allSettled([postgresJournal, mixedJournal].filter(Boolean).map(async journal => {
      const evidence = await journal.close(), hash = createHash('sha256')
      for await (const chunk of createReadStream(evidence.path)) hash.update(chunk)
      assert.equal(hash.digest('hex'), evidence.sha256)
    }))
    const failures = results.filter(result => result.status === 'rejected')
    assert.deepEqual(failures, [])
  })
  if (!mixedMinutes && report.coveredSubsetPassed && report.failures.length === 0) {
    try {
      await check('真实隔离业务库、对象与合成加密配置备份恢复', async () => {
        const companies = (await pool.query("SELECT organization_id AS id,schema_name AS schema FROM public.organization_schemas WHERE status='ready' ORDER BY organization_id")).rows
        const backupReport = { checks: {} }
        await verifyIsolatedBackup({ pool, admin, Pool, options: instance.connection, database: instance.database,
          directory: instance.directory, storageRoot: process.env.RECRUITING_QUARANTINE_ROOT, companies,
          sharedInterviewStorage: true,
          report: backupReport, isolation: instance, postgresBin: process.argv[argument + 1],
          async verifyRestored({ pool: restoredPool, database, storageRoot, interviewObjects }) {
            const { inspectMigrations } = await load('api', 'db/migrations')
            const before = await inspectMigrations(restoredPool, join(projectRoot, 'db/migrations'))
            assert.deepEqual(before.pending, [])
            for (const company of companies) {
              const result = await restoredPool.query('SELECT public.organization_schema_structure_ready($1::uuid) AS ready', [company.id])
              assert.equal(result.rows[0].ready, true)
            }
            const services = await verifyRestoredServices({ instance, pool: restoredPool, database, storageRoot,
              interviewObjects,
              accounts: recoveryAccounts, runtimeEnv: process.env })
            return { migrationsComplete: true, companySchemasReady: companies.length, ...services }
          },
        })
        return backupReport.checks
      })
    } catch (error) {
      report.failures.push({ recovery: 'backupRestore', name: error.name, message: error.message, stack: error.stack, evidence: error.recoveryEvidence })
      report.coveredSubsetPassed = false; process.exitCode = 1
    }
  }
  await clean('testPoolClosed', () => pool?.end())
  if (created) await clean('databaseDropped', () => admin.query('DROP DATABASE "' + instance.database + '" WITH (FORCE)'))
  await clean('adminPoolClosed', () => admin.end())
  await clean('postgresStopped', () => instance.stop())
  await clean('codeUnchangedDuringRun', async () => {
    const finalFingerprint = await testCodeFingerprint(projectRoot)
    assert.equal(finalFingerprint.sha256, codeFingerprint.sha256, '测试运行期间受测代码发生变化，报告不能作为固定版本验收证据')
    assert.equal(finalFingerprint.head, codeFingerprint.head)
  })
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2))
  console.log('报告：' + output)
}

