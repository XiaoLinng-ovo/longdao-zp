import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const requireWeb = createRequire(join(root, 'web/package.json'))
const stamp = '2026-11-10T02:00:00.000Z'
const name = '布局验收候选人阿依努尔艾力江（虚构）'
const jobTitle = '跨区域智能招聘平台高级研发工程师与招聘流程负责人（虚构岗位）'
const workspace = { id: 'qa-layout-workspace', name: '响应式验收企业', kind: 'test', status: 'active', role: 'owner', serviceStatus: 'enabled', serviceAvailable: true, createdAt: stamp }
const jobs = [1, 2].map(i => ({ id: `qa-job-${i}`, code: `QA-JOB-${i}`, title: `${jobTitle}${i}`, status: 'published', updatedAt: stamp, department: '验收部门', channels: [] }))
const applications = jobs.map((job, i) => ({ id: `qa-app-${i}`, code: `QA-APP-${i}`, candidateId: 'qa-candidate', jobId: job.id, status: 'screening', aiStatus: 'completed', score: 88, updatedAt: stamp }))
const candidate = { id: 'qa-candidate', code: 'QA-CANDIDATE', fullName: name, email: 'responsive-layout-check-with-long-name@example.invalid', phone: '13800000000', source: 'manual', tags: ['响应式验收'], status: 'active', createdAt: stamp, updatedAt: stamp, applications }
const resume = { id: 'qa-resume', candidateId: candidate.id, originalFilename: '长文件名响应式验收-跨区域招聘平台高级工程师完整履历与项目介绍.pdf', mimeType: 'application/pdf', sizeBytes: 1024, scanStatus: 'clean', createdAt: stamp }
const fixtures = {
  '/me': { user: { id: 'qa-layout-user', name: '布局验收用户', email: 'layout@example.invalid', role: 'recruiter', departmentId: 'qa-dept', workspaceId: workspace.id, workspaceName: workspace.name, workspaceKind: 'test' }, sessionId: 'qa-layout-session', method: 'session', workspaces: [workspace] },
  '/workspaces': [workspace],
  '/system/features': { recruitmentReportsEnabled: true },
  '/trial-usage': { enforced: false, serviceStatus: 'enabled' },
  '/jobs': jobs,
  '/candidates': [candidate],
  '/candidate-tags': ['响应式验收'],
  '/resume-import-batches': [],
  '/candidates/qa-candidate': { ...candidate, jobs, resumes: [resume], analysisTasks: [], analysisResults: [] },
  '/dashboard/summary': {
    generatedAt: stamp,
    metrics: ['收到简历', '已通过筛选', '面试中', '已发录用通知'].map((label, i) => ({ label, value: 120 - i * 25, detail: '隔离验收数据' })),
    funnel: ['收到申请', '简历筛选', '初试', '复试', '录用通知', '入职'].map((stage, i) => ({ stage, count: 120 - i * 20, conversionRate: 80 })),
    pendingApprovals: [],
    pendingInterviews: [{ id: 'qa-interview', candidateName: name, jobTitle, round: 2, scheduledStartAt: stamp, status: 'scheduled' }],
    failedTasks: [{ id: 'qa-task', status: 'failed', attempts: 1, lastError: '分析服务暂不可用，请稍后重试', availableAt: stamp }],
    todos: [{ id: 'qa-todo', category: 'interview', title: '复试反馈待完成', description: `${name} · ${jobTitle}`, actionLabel: '去完成', path: '/candidates/qa-candidate', updatedAt: stamp }],
  },
}

const requests = []
async function startServer() {
  const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
  const { default: vue } = await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-vue')).href)
  const server = await createServer({
    root: join(root, 'web'), configFile: false,
    plugins: [{ name: 'isolated-layout-fixtures', configureServer(vite) {
      // Consume every API request before Vite; no production proxy or database is used.
      vite.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/api/')) return next()
        const key = new URL(req.url, 'http://localhost').pathname.replace(/^\/api\/v1/, '')
        const known = req.method === 'GET' && Object.hasOwn(fixtures, key)
        requests.push({ method: req.method, path: key, known })
        res.statusCode = known ? 200 : 501
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(known ? { ok: true, data: fixtures[key] } : { ok: false, error: { message: '隔离验收禁止未定义请求' } }))
      })
      vite.middlewares.use('/__qa-requests', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(requests)) })
    } }, vue()],
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: {}, watch: { ignored: ['**/reports/**'] } },
  })
  await server.listen()
  return { server, origin: `http://127.0.0.1:${server.httpServer.address().port}` }
}

if (process.argv.includes('--serve')) {
  const { server, origin } = await startServer()
  console.log(`隔离验收地址：${origin}`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
} else {
  const urlIndex = process.argv.indexOf('--url')
  const own = urlIndex < 0 ? await startServer() : null
  const origin = own?.origin ?? process.argv[urlIndex + 1]
  const baseline = process.argv.includes('--baseline')
  const output = join(root, 'reports/qa-2026-11-09-p2', baseline ? 'screenshots/2026-11-10/before' : 'screenshots/2026-11-10')
  await mkdir(output, { recursive: true })
  const requireRuntime = createRequire(join(process.env.CODEX_NODE_MODULES || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright/package.json'))
  const { chromium } = requireRuntime('playwright')
  let browser
  const results = []
  const errors = []
  const checks = []
  const check = (label, passed, detail) => checks.push({ label, passed: !!passed, detail })
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    for (const width of [320, 375, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      for (const [key, path, ready] of [['dashboard', '/', '.progress-rail'], ['candidate-list', '/candidates', '.candidate-table tbody .name-link'], ['candidate-detail', '/candidates/qa-candidate', '.profile-grid']]) {
        await page.goto(origin + path)
        await page.locator(ready).first().waitFor()
        await page.evaluate(() => document.fonts.ready)
        const measurements = await page.evaluate(() => {
          const rect = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } }
          const locals = [...document.querySelectorAll('.table-wrap, .progress-rail')].map(el => {
            el.scrollLeft = el.scrollWidth
            const last = el.querySelector('tr:last-child > :last-child, .progress-node:last-of-type')
            const data = { selector: el.className, client: el.clientWidth, scroll: el.scrollWidth, reached: el.scrollLeft, overflow: getComputedStyle(el).overflowX, rect: rect(el), last: last && rect(last) }
            el.scrollLeft = 0
            return data
          })
          const header = document.querySelector('.candidate-detail-header')
          const overlaps = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1
          const text = header && rect(header.firstElementChild)
          const actions = header && rect(header.querySelector('.inline-actions'))
          const controls = [...document.querySelectorAll('.filter-bar input:not([type="checkbox"]), .filter-bar select, .filter-bar button, .filter-bar .talent-filter, .candidate-detail-header button, .section-title-row .btn')].map(el => ({ text: el.textContent || el.getAttribute('aria-label'), ...rect(el) }))
          const sectionTitle = document.querySelector('.section-title-row > .section-title')
          return { viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, locals, header: header && { text, actions, overlaps: overlaps(text, actions), h2: rect(header.querySelector('h2')) }, sectionTitle: sectionTitle && rect(sectionTitle), controls }
        })
        check(`${key}-${width} 页面无横向溢出`, measurements.document <= width + 1 && measurements.body <= width + 1, measurements.document)
        for (const local of measurements.locals) {
          check(`${key}-${width} ${local.selector} 容器在视口内`, local.rect.left >= -1 && local.rect.right <= width + 1, local.rect)
          if (local.scroll > local.client + 1) check(`${key}-${width} ${local.selector} 可滚至最右端`, local.reached >= local.scroll - local.client - 1 && ['auto', 'scroll'].includes(local.overflow) && (!local.last || local.last.right <= local.rect.right + 1), local)
        }
        for (const control of measurements.controls) check(`${key}-${width} 控件未被裁切`, control.left >= -1 && control.right <= width + 1 && control.height >= 14, control)
        if (measurements.sectionTitle) check(`${key}-${width} 简历信息标题不被挤压`, measurements.sectionTitle.height <= 30, measurements.sectionTitle)
        if (measurements.header) {
          check(`candidate-detail-${width} 标题与按钮不重叠`, !measurements.header.overlaps, measurements.header)
          check(`candidate-detail-${width} 标题完整显示`, measurements.header.h2.height < 45, measurements.header.h2)
          if (width <= 560) check(`candidate-detail-${width} 操作区位于姓名下方`, measurements.header.actions.top >= measurements.header.text.bottom - 1, measurements.header)
        }
        await page.screenshot({ path: join(output, `${key}-${width}.png`), fullPage: true })
        if (key !== 'candidate-detail') {
          await page.locator('.table-wrap, .progress-rail').evaluateAll(elements => elements.forEach(el => { el.scrollLeft = el.scrollWidth }))
          await page.screenshot({ path: join(output, `${key}-${width}-right.png`), fullPage: true })
        }
        results.push({ page: key, width, measurements })
      }
      await page.goto(origin + '/candidates')
      await page.locator('.candidate-table .name-link').waitFor()
      await page.getByRole('searchbox', { name: '简历库搜索' }).fill('不存在的虚构姓名')
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      check(`candidate-list-${width} 搜索生效`, await page.locator('.candidate-table').getByText('暂无数据').isVisible())
      await page.getByRole('searchbox', { name: '简历库搜索' }).fill('')
      await page.getByRole('button', { name: '搜索', exact: true }).click()
      await page.getByRole('combobox', { name: '岗位筛选', exact: true }).selectOption(jobs[0].title)
      check(`candidate-list-${width} 岗位筛选可用`, await page.locator('.candidate-table .name-link').count() === 1)
      await page.getByRole('checkbox', { name: '只看人才库' }).check()
      check(`candidate-list-${width} 人才库筛选生效`, await page.locator('.candidate-table').getByText('暂无数据').isVisible())
      await page.getByRole('checkbox', { name: '只看人才库' }).uncheck()
      await page.locator('.candidate-table .name-link').click()
      await page.locator('.profile-grid').waitFor()
      await page.locator('#detail-application').selectOption(applications[1].id)
      check(`candidate-detail-${width} 长岗位申请可切换`, await page.locator('#detail-application').inputValue() === applications[1].id)
      await page.locator('.candidate-detail-header').getByRole('button', { name: '刷新', exact: true }).click()
      await page.locator('.profile-grid').waitFor()
      check(`candidate-detail-${width} 刷新后资料保留`, await page.locator('.profile-grid').getByText(name, { exact: true }).isVisible())
      await page.locator('.candidate-detail-header').getByRole('button', { name: '返回列表' }).click()
      await page.locator('.candidate-table').waitFor()
      check(`candidate-detail-${width} 返回列表可用`, new URL(page.url()).pathname === '/candidates')
    }
    const recorded = await (await fetch(origin + '/__qa-requests')).json()
    check('全部接口为已定义的隔离只读请求', recorded.every(request => request.known && request.method === 'GET'), recorded.filter(request => !request.known))
    check('浏览器无运行错误', errors.length === 0, errors)
    const report = { executedAt: new Date().toISOString(), baseline, fixturesOnly: true, realApiRequests: 0, widths: [320, 375, 390, 768, 1440], checks, results, requests: recorded, errors }
    await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ 检查数: checks.length, 通过: checks.filter(x => x.passed).length, 失败: checks.filter(x => !x.passed), 输出目录: output }, null, 2))
    if (!baseline && checks.some(x => !x.passed)) process.exitCode = 1
  } finally {
    await browser?.close()
    await own?.server.close()
  }
}
