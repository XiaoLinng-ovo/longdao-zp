import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const origin = process.argv[2] || 'http://127.0.0.1:5174'
const output = join(root, 'reports/qa-2026-11-10-auth-workspace-loop')
await mkdir(join(output, 'screenshots'), { recursive: true })
const runtime = createRequire(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'))
const { chromium } = runtime('playwright')
const workspace = { id: 'qa-company-a', name: '登录流程验收企业', kind: 'test', status: 'active', role: 'member', serviceAvailable: true, serviceStatus: 'enabled', createdAt: '2026-11-10T00:00:00Z' }
const user = { id: 'qa-user', name: '流程验收用户', email: 'qa@example.invalid', role: 'recruiter', departmentId: '' }
const checks = [], errors = [], requests = []
const check = (label, passed, details) => {
  checks.push({ label, passed: !!passed, ...(details === undefined ? {} : { details }) })
  if (!passed) throw new Error(label + ' 未通过：' + JSON.stringify(details))
}
let browser, context, page, state, heldResponse, holding = false, holdFailure = false
const session = () => ({ user: { ...user, ...(state.selected ? { workspaceId: state.selected, workspaceName: state.workspaces.find(w => w.id === state.selected)?.name } : {}) }, sessionId: 'qa-session', expiresAt: '2099-01-01T00:00:00Z', method: 'session', workspaces: state.workspaces })
const snapshotSession = () => structuredClone(session())

async function scenario(options = {}, width = 1440) {
  await context?.close()
  state = { authenticated: false, selected: undefined, workspaces: [workspace], transient: false, ...options }
  heldResponse = undefined
  holding = false
  holdFailure = false
  context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  await context.addInitScript(() => {
    window.__qaAuth = async () => {
      const entry = performance.getEntriesByType('resource').find(resource => new URL(resource.name).pathname === '/src/modules/auth/session.ts')
      if (!entry) throw new Error('未找到应用实际加载的会话模块')
      return import(entry.name)
    }
  })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const entry = { path, method: request.method(), workspace: request.headers()['x-workspace-id'], known: true }
    requests.push(entry)
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: true, data, requestId: 'qa-auth' }) })
    const fail = (status, code) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ ok: false, error: { code, message: status === 401 ? '未登录，请先完成身份认证' : '暂时无法连接服务' }, requestId: 'qa-auth' }) })
    if (path === '/me') {
      if (holding) {
        const captured = snapshotSession()
        heldResponse = () => holdFailure ? fail(401, 'AUTHENTICATION_REQUIRED') : send(captured)
        return
      }
      if (state.transient) return fail(503, 'SERVICE_UNAVAILABLE')
      return state.authenticated ? send(session()) : fail(401, 'AUTHENTICATION_REQUIRED')
    }
    if (path === '/auth/csrf') return send({ token: 'isolated-auth-test-csrf' })
    if (path === '/auth/login') { state.authenticated = true; return send({ ...session(), kind: 'authenticated' }) }
    if (path === '/auth/logout') { state.authenticated = false; state.selected = undefined; return send({ ok: true }) }
    if (path === '/auth/accounts') return send([])
    if (path === '/workspaces' && request.method() === 'GET') return send(state.workspaces)
    if (path === '/workspaces' && request.method() === 'POST') {
      const body = request.postDataJSON()
      const created = { ...workspace, id: 'qa-created', name: body.name }
      state.workspaces.push(created)
      return send(created, 201)
    }
    if (/^\/workspaces\/[^/]+\/select$/.test(path)) {
      state.selected = path.split('/')[2]
      return send({ user: session().user })
    }
    if (path === '/system/features') return send({ recruitmentReportsEnabled: false })
    if (path === '/trial-usage') return send({ enforced: false, serviceStatus: 'enabled' })
    if (path === '/dashboard/summary') return send({ generatedAt: '2026-11-10T00:00:00Z', metrics: [], funnel: [], todos: [], pendingApprovals: [], pendingInterviews: [], failedTasks: [] })
    if (['/jobs', '/candidates', '/interviews', '/applications', '/offers', '/offers/eligible-applications', '/onboarding', '/onboarding/workbench', '/departments', '/interviewer-options', '/candidate-tags', '/offer-templates'].includes(path)) return send([])
    if (path === '/onboarding/reports') return send({ totals: { all: 0, pending: 0, preparing: 0, scheduled: 0, completed: 0, no_show: 0, cancelled: 0 }, arrivalRate: null, averagePreparationDays: null, medianPreparationDays: null, requiredTaskOnTimeRate: null, overdueTasks: 0, blockedTasks: 0, reasonDistribution: [], integrationStatus: { not_configured: 0, pending: 0, syncing: 0, ready: 0, failed: 0 }, highRiskItems: [] })
    entry.known = false
    return fail(501, 'ISOLATED_REQUEST_NOT_DEFINED')
  })
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
}

async function credentials() {
  await page.locator('#login-email').fill('qa@example.invalid')
  await page.locator('#login-password').fill('isolated-password')
  await page.locator('form').first().evaluate(form => form.requestSubmit())
}
async function assertPath(path, label) {
  await page.waitForURL(url => url.pathname === path)
  await page.locator('.page-content').waitFor()
  check(label, new URL(page.url()).pathname === path, page.url())
}
async function screenshot(name) { await page.screenshot({ path: join(output, 'screenshots', name + '.png'), fullPage: true }) }
async function pauseRefresh(failure) {
  holding = true
  holdFailure = failure
  await page.evaluate(() => { window.__qaRefresh = window.__qaAuth().then(module => module.refreshAuthSession()); return true })
  for (let attempt = 0; attempt < 100 && !heldResponse; attempt++) await new Promise(resolve => setTimeout(resolve, 50))
  check('延迟的会话读取已被测试夹具截获', typeof heldResponse === 'function')
}
async function releaseRefresh() {
  holding = false
  await heldResponse()
  await page.evaluate(() => window.__qaRefresh)
}

try {
  browser = await chromium.launch({ headless: true })
  for (const width of [1440, 390]) {
    await scenario({}, width)
    const before = requests.filter(r => r.path === '/me').length
    await page.goto(origin + '/login')
    await page.locator('#login-email').waitFor()
    check(`${width} 启动只读取一次会话`, requests.filter(r => r.path === '/me').length - before === 1)
    await credentials()
    await assertPath('/', `${width} 单企业登录自动进入工作台`)
    for (const path of ['/jobs', '/candidates', '/interviews', '/offers', '/onboarding', '/enterprise/departments', '/workspaces', '/']) {
      const target = page.locator(`a[href="${path}"]`).first()
      if (await target.count()) await target.click({ force: width < 600 })
      else await page.evaluate(async path => { const router = document.querySelector('#app').__vue_app__.config.globalProperties.$router; await router.push(path) }, path)
      await assertPath(path, `${width} 切换模块 ${path} 不回企业创建或登录`)
    }
    await page.goto(origin + '/jobs')
    await assertPath('/jobs', `${width} 刷新业务模块保留当前企业`)
    check(`${width} 企业身份稳定`, await page.evaluate(async () => (await window.__qaAuth()).authSession.user?.workspaceId) === workspace.id)
    await screenshot(`jobs-stable-${width}`)
  }

  for (const failure of [false, true]) {
    await scenario()
    await page.goto(origin + '/login')
    await page.locator('#login-email').waitFor()
    await pauseRefresh(failure)
    await credentials()
    await assertPath('/', '有旧请求未完成时仍可完成登录')
    await releaseRefresh()
    await page.locator('a[href="/jobs"]').first().click()
    await assertPath('/jobs', failure ? '旧未登录响应不能清除新登录' : '旧无企业响应不能覆盖新企业')
    check('旧响应后当前企业不丢失', await page.evaluate(async () => (await window.__qaAuth()).authSession.user?.workspaceId) === workspace.id)
  }

  await scenario({ authenticated: true })
  await page.goto(origin + '/interviews?status=scheduled')
  await page.locator('.workspace-open').waitFor()
  check('无当前企业时保留原面试模块目标', new URL(page.url()).searchParams.get('redirect') === '/interviews?status=scheduled')
  await screenshot('choose-enterprise')
  await page.locator('.workspace-open').click()
  await assertPath('/interviews', '选择已有企业后返回原面试模块')
  check('选择后保留筛选条件', new URL(page.url()).searchParams.get('status') === 'scheduled')
  await page.reload()
  await assertPath('/interviews', '企业选择写入后刷新不再跳回')

  await scenario({ workspaces: [workspace, { ...workspace, id: 'qa-company-b', name: '第二验收企业' }] })
  await page.goto(origin + '/login?redirect=%2Foffers')
  await credentials()
  await page.locator('.workspace-choice').waitFor()
  check('多个企业先选择而不是循环跳转', await page.locator('.workspace-choice-item').count() === 2)
  await page.locator('.workspace-choice-item').nth(1).click()
  await assertPath('/offers', '多企业登录选定后到达原录用模块')
  await page.reload()
  await assertPath('/offers', '多企业选定后刷新保持企业')

  await scenario({ workspaces: [workspace, { ...workspace, id: 'expired', serviceStatus: 'trial', serviceAvailable: false, trialEndsAt: '2020-01-01' }] })
  await page.goto(origin + '/login')
  await credentials()
  await assertPath('/', '排除到期企业后自动进入唯一可用企业')

  await scenario({ workspaces: [{ ...workspace, serviceStatus: 'suspended', serviceAvailable: false }] })
  await page.goto(origin + '/login')
  await credentials()
  await page.locator('.workspace-open').waitFor()
  check('暂停企业保留管理与续费入口，不错误自动进入', new URL(page.url()).pathname === '/workspaces' && await page.locator('.workspace-open').isDisabled())

  await scenario({ authenticated: true, workspaces: [] })
  await page.goto(origin + '/jobs?status=draft')
  await page.getByLabel('企业名称', { exact: true }).fill('隔离创建流程验收企业')
  await page.getByRole('button', { name: '新建企业', exact: false }).click()
  await assertPath('/jobs', '无企业用户创建企业后直接进入原岗位模块')
  check('创建后保持原筛选条件', new URL(page.url()).searchParams.get('status') === 'draft')

  await scenario({ authenticated: true, selected: workspace.id, transient: true })
  await page.goto(origin + '/candidates')
  await page.getByRole('button', { name: '重新连接', exact: true }).waitFor()
  check('首次连接故障显示重试，不误导创建企业或重新登录', await page.locator('#login-email').count() === 0 && await page.locator('.workspace-create-form').count() === 0)
  await screenshot('startup-retry')
  state.transient = false
  await page.getByRole('button', { name: '重新连接', exact: true }).click()
  await assertPath('/candidates', '连接恢复后继续原简历库模块')
  state.transient = true
  await page.evaluate(async () => (await window.__qaAuth()).refreshAuthSession())
  check('登录后临时故障不清空企业身份', await page.evaluate(async () => (await window.__qaAuth()).authSession.user?.workspaceId) === workspace.id)
  state.transient = false
  await page.locator('a[href="/jobs"]').first().click()
  await assertPath('/jobs', '登录后临时故障恢复仍可切换模块')

  await scenario({ authenticated: true, selected: workspace.id })
  await page.goto(origin + '/jobs')
  await assertPath('/jobs', '已有会话直接打开岗位模块')
  await pauseRefresh(false)
  await page.evaluate(async () => { const session = await window.__qaAuth(); await session.logoutCurrentUser(); await document.querySelector('#app').__vue_app__.config.globalProperties.$router.replace('/login') })
  await page.locator('#login-email').waitFor()
  await releaseRefresh()
  check('退出后旧响应不能恢复登录', await page.evaluate(async () => (await window.__qaAuth()).authSession.user) === null)
  await credentials()
  await assertPath('/', '退出后可正常重新登录')
  check('全部业务请求由隔离夹具处理', requests.every(r => r.known), requests.filter(r => !r.known))
  check('浏览器没有运行时异常', errors.length === 0, errors)
} catch (error) {
  errors.push(error.stack || String(error))
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {})
  process.exitCode = 1
} finally {
  await browser?.close()
  const result = { origin, checkedAt: new Date().toISOString(), total: checks.length, passed: checks.filter(c => c.passed).length, checks, errors, requests }
  await writeFile(join(output, 'browser-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
