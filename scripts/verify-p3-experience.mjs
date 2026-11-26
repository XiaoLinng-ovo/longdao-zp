import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const requireWeb = createRequire(join(root, 'web/package.json'))
const stamp = '2026-11-10T01:00:00.000Z'
const workspace = { id: 'p3-workspace', name: '体验验收企业', kind: 'test', status: 'active', role: 'owner', serviceStatus: 'enabled', serviceAvailable: true, createdAt: stamp }
const taskId = 'qa-task-' + 'a'.repeat(96)
const rows = [
  { id: taskId, operation: 'job_spec', model: 'private-model-name', state: 'uncertain', settledUnits: 0, createdAt: stamp, finishedAt: null, requestId: 'qa-request-' + 'b'.repeat(100), durationMs: 2300, failureCategory: 'future_failure', needsReconciliation: true, reviewCount: 1 },
  { id: 'qa-settled', operation: 'jd', model: 'private-model-name', state: 'settled', settledUnits: 1, createdAt: stamp, finishedAt: stamp, requestId: null, durationMs: 1200, failureCategory: null, needsReconciliation: false, reviewCount: 0 },
  { id: 'qa-unknown', operation: 'future_operation', model: 'private-model-name', state: 'future_state', settledUnits: 0, createdAt: stamp, finishedAt: null, requestId: null, durationMs: null, failureCategory: null, needsReconciliation: false, reviewCount: 0 },
]
const reviews = [{ id: 'qa-note', actorId: 'internal-member-uuid', outcome: 'future_outcome', note: '已记录核对证据，等待进一步确认。', createdAt: stamp }]
const requests = []
let failList = false, failDetail = false
const fixtures = {
  '/me': { user: { id: 'qa-p3-user', name: '体验验收用户', email: 'p3@example.invalid', role: 'recruiter', departmentId: 'qa-dept', workspaceId: workspace.id, workspaceName: workspace.name, workspaceKind: 'test' }, sessionId: 'qa-p3-session', method: 'session', workspaces: [workspace] },
  '/workspaces': [workspace], '/system/features': { recruitmentReportsEnabled: true }, '/trial-usage': { enforced: false, serviceStatus: 'enabled' }, '/auth/csrf': { token: 'isolated-p3-csrf-token' },
}
const preview = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module">
import {createApp,h} from '/node_modules/.vite/deps/vue.js';
import PageHeader from '/src/shared/components/PageHeader.vue';
import StatusTag from '/src/shared/components/StatusTag.vue';
import WorkflowEventTable from '/src/shared/components/workflow/WorkflowEventTable.vue';
import '/src/shared/styles/components.css';
createApp({render(){return h('main',{style:'max-width:100%;min-width:0'},[
 h(PageHeader,{title:'跨区域招聘流程与候选人面试反馈工作台',description:'招聘流程辅助信息与超长编号：'+ 'LongUnbrokenReference'.repeat(12)},{default:()=>h('div',{class:'inline-actions'},[h('button',{class:'btn'},'刷新'),h('button',{class:'btn'},'返回列表')])}),
 h(StatusTag,{status:'future_internal_status'}),h(WorkflowEventTable,{events:[{id:'event',createdAt:'${stamp}',subjectLabel:'虚构候选人',action:'future_internal_action',fromStatus:'screening',toStatus:'future_internal_status',actorName:'体验验收用户',reason:'隔离验收'}]})
])}}).mount('#app');</script><style>*{box-sizing:border-box}body{margin:0;padding:16px;font-family:Arial,sans-serif;color:#243640}main{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}</style></html>`

async function startServer() {
  const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
  const { default: vue } = await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-vue')).href)
  const server = await createServer({ root: join(root, 'web'), configFile: false, plugins: [{ name: 'isolated-p3-fixtures', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://localhost')
      const send = (data, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)) }
      if (url.pathname === '/__qa-preview') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(await vite.transformIndexHtml(url.pathname, preview)) }
      if (url.pathname === '/__qa-state') return send({ requests, reviews })
      if (url.pathname === '/__qa-failure') { failList = url.searchParams.get('list') === '1'; failDetail = url.searchParams.get('detail') === '1'; return send({ ok: true }) }
      if (!url.pathname.startsWith('/api/')) return next()
      const path = url.pathname.replace(/^\/api\/v1/, '')
      const entry = { method: req.method, path, query: Object.fromEntries(url.searchParams), known: true }; requests.push(entry)
      if (req.method === 'GET' && Object.hasOwn(fixtures, path)) return send({ ok: true, data: fixtures[path] })
      if (req.method === 'GET' && path === '/admin/ai-usage') {
        if (failList) return send({ ok: false, error: { code: 'INTERNAL_ERROR', message: '读取失败：TypeError private_table stack at /app/private.ts' } }, 500)
        let items = rows.filter(row => (!url.searchParams.get('operation') || row.operation === url.searchParams.get('operation')) && (!url.searchParams.get('state') || row.state === url.searchParams.get('state')) && (url.searchParams.get('reviewOnly') !== 'true' || row.needsReconciliation))
        const page = Number(url.searchParams.get('page') || 1)
        return send({ ok: true, data: { billingSource: 'customer_model', chargeAmount: null, unit: 'successful_generation', scope: ['job_spec', 'jd'], summary: { total: 3, settled: 1, released: 0, reserved: 0, reconciliation: 1 }, items: items.slice((page - 1) * 20, page * 20), page, pageSize: 20, filteredTotal: items.length } })
      }
      if (path === '/admin/ai-usage/' + taskId + '/reviews') {
        if (req.method === 'GET') {
          if (failDetail) return send({ ok: false, error: { code: 'INTERNAL_ERROR', message: '读取失败：duplicate key violates constraint private_table' } }, 500)
          return send({ ok: true, data: { items: reviews, limit: 20 } })
        }
        if (req.method === 'POST') {
          let body = ''; for await (const chunk of req) body += chunk
          const input = JSON.parse(body); entry.body = input
          let item = reviews.find(note => note.id === input.key)
          const replayed = !!item
          if (!item) { item = { id: input.key, actorId: 'qa-p3-user', outcome: input.outcome, note: input.note, createdAt: stamp }; reviews.unshift(item) }
          return send({ ok: true, data: { item, replayed } })
        }
      }
      entry.known = false
      return send({ ok: false, error: { message: '隔离验收禁止未定义请求' } }, 501)
    })
  } }, vue()], server: { host: '127.0.0.1', port: 0, proxy: {}, watch: { ignored: ['**/reports/**'] } } })
  await server.listen()
  return { server, origin: 'http://127.0.0.1:' + server.httpServer.address().port }
}

if (process.argv.includes('--serve')) {
  const { server, origin } = await startServer()
  console.log('P3 隔离验收地址：' + origin)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0) })
} else {
  const index = process.argv.indexOf('--url')
  const own = index < 0 ? await startServer() : null
  const origin = own?.origin ?? process.argv[index + 1]
  const output = join(root, 'reports/qa-2026-11-10-p3/screenshots')
  await mkdir(output, { recursive: true })
  const requireRuntime = createRequire(join(process.env.CODEX_NODE_MODULES || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright/package.json'))
  const { chromium } = requireRuntime('playwright')
  const checks = [], errors = [], measurements = []
  const check = (label, passed, detail) => checks.push({ label, passed: !!passed, detail })
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'America/Los_Angeles' })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    const state = async () => (await fetch(origin + '/__qa-state')).json()
    const failure = async query => fetch(origin + '/__qa-failure?' + query)
    for (const width of [320, 375, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(origin + '/enterprise/ai-usage')
      await page.locator('.usage-scope').waitFor()
      check(`${width} 统计范围与费用边界明确`, (await page.locator('.usage-scope').innerText()).includes('本页不提供模型服务商账单金额'))
      check(`${width} 未知枚举与模型名称未外露`, !/future_operation|future_state|future_failure|private-model-name/.test(await page.locator('.usage-page').innerText()))
      await page.locator('tbody button').first().click()
      await page.locator('.reviews li').first().waitFor()
      check(`${width} 核对人和未知进度有中文兜底`, (await page.locator('.reviews').innerText()).includes('企业成员（姓名未记录）') && !(await page.locator('.reviews').innerText()).includes('internal-member-uuid'))
      check(`${width} 非北京时间浏览器仍显示09点`, (await page.locator('.reviews').innerText()).includes('2026-11-10 09:00:00'))
      const layout = await page.evaluate(() => {
        const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } }
        const table = document.querySelector('.table-scroll'); table.scrollLeft = table.scrollWidth
        const data = { width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, controls: [...document.querySelectorAll('.usage-page input,.usage-page select,.usage-page textarea,.usage-page button')].filter(el => !el.closest('table')).map(rect), table: { ...rect(table), client: table.clientWidth, scroll: table.scrollWidth, reached: table.scrollLeft, last: rect(table.querySelector('tr:last-child td:last-child')) }, traces: [...document.querySelectorAll('.trace code')].map(el => ({ ...rect(el), scroll: el.scrollWidth, client: el.clientWidth })) }; table.scrollLeft = 0; return data
      })
      measurements.push({ width, layout })
      check(`${width} 页面无横向溢出`, layout.document <= width + 1 && layout.body <= width + 1, layout)
      check(`${width} 表单按钮均未裁切`, layout.controls.every(r => r.left >= -1 && r.right <= width + 1 && r.height >= 14), layout.controls)
      check(`${width} 长追踪编号正确换行`, layout.traces.every(r => r.left >= -1 && r.right <= width + 1 && r.scroll <= r.client + 1), layout.traces)
      check(`${width} 表格局部可滚到末列`, layout.table.reached >= layout.table.scroll - layout.table.client - 1 && layout.table.last.right <= layout.table.right + 1, layout.table)
      await page.screenshot({ path: join(output, `ai-usage-${width}.png`), fullPage: true })
      await page.getByRole('combobox', { name: '生成类型', exact: true }).selectOption('jd')
      await page.getByLabel('开始时间（北京时间，含）', { exact: true }).fill('2026-11-10T09:00')
      await page.getByLabel('结束时间（北京时间，不含）', { exact: true }).fill('2026-11-10T18:00')
      await page.getByRole('button', { name: '应用筛选', exact: true }).click()
      await page.locator('tbody tr').filter({ hasText: '已结算' }).waitFor()
      const query = (await state()).requests.filter(req => req.path === '/admin/ai-usage').at(-1).query
      check(`${width} 时间筛选按北京时间提交`, query.from === '2026-11-10T01:00:00.000Z' && query.to === '2026-11-10T10:00:00.000Z', query)
      check(`${width} 筛选不改变全企业概览`, await page.locator('.stats b').first().innerText() === '3' && await page.locator('tbody tr').count() === 1)
      await page.getByRole('button', { name: '重置', exact: true }).click()
      await page.locator('tbody tr').nth(2).waitFor()
      await page.getByLabel('仅看待核对', { exact: true }).check()
      await page.getByRole('button', { name: '应用筛选', exact: true }).click()
      await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1)
      check(`${width} 仅看待核对筛选生效`, (await state()).requests.filter(req => req.path === '/admin/ai-usage').at(-1).query.reviewOnly === 'true')
      await page.getByRole('button', { name: '重置', exact: true }).click()
      await page.locator('tbody tr').nth(2).waitFor()
      await page.getByLabel('开始时间（北京时间，含）', { exact: true }).fill('2026-11-10T18:00')
      await page.getByLabel('结束时间（北京时间，不含）', { exact: true }).fill('2026-11-10T09:00')
      const before = (await state()).requests.length
      await page.getByRole('button', { name: '应用筛选', exact: true }).click()
      await page.getByRole('alert').waitFor()
      check(`${width} 反向时间范围不发起请求`, (await page.getByRole('alert').innerText()).includes('结束时间必须晚于开始时间') && (await state()).requests.length === before)
      await page.goto(origin + '/__qa-preview')
      await page.locator('.page-header').waitFor()
      const header = await page.evaluate(() => {
        const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
        return { document: document.documentElement.scrollWidth, text: rect(document.querySelector('.page-header > div')), actions: rect(document.querySelector('.page-header .inline-actions')), content: document.body.innerText }
      })
      check(`${width} 公共标题长文字无溢出`, header.document <= width + 1 && header.text.right <= width + 1, header)
      check(`${width} 标题与操作区不重叠`, header.text.bottom <= header.actions.top + 1 || header.text.right <= header.actions.left + 1, header)
      if (width <= 560) check(`${width} 手机操作区在标题下方`, header.actions.top >= header.text.bottom - 1, header)
      check(`${width} 通用状态和操作中文兜底`, header.content.includes('状态待确认') && header.content.includes('其他操作') && !header.content.includes('future_internal'), header.content)
      await page.screenshot({ path: join(output, `shared-header-${width}.png`), fullPage: true })
    }
    await page.goto(origin + '/enterprise/ai-usage')
    await page.locator('.usage-scope').waitFor()
    await page.locator('tbody button').first().click()
    await page.locator('.reviews li').first().waitFor()
    await page.getByLabel('核对说明', { exact: true }).fill('本次仅保存人工核对说明，不改变结算次数。')
    await page.getByRole('button', { name: '保存核对记录', exact: true }).click()
    await page.getByText('核对记录已保存，调用状态与结算次数保持不变。', { exact: true }).waitFor()
    check('保存核对说明后显示本人且概览不变', (await page.locator('.reviews').innerText()).includes('记录人：本人') && await page.locator('.stats b').nth(1).innerText() === '1')
    await page.screenshot({ path: join(output, 'review-saved.png'), fullPage: true })
    await failure('detail=1')
    await page.locator('tbody button').first().click()
    await page.locator('.review-panel [role="alert"]').waitFor()
    check('详情技术异常中文脱敏', !/duplicate|constraint|private_table/.test(await page.locator('.review-panel [role="alert"]').innerText()))
    await failure('list=1')
    await page.getByRole('button', { name: '刷新用量', exact: true }).click()
    await page.getByRole('alert').waitFor()
    check('列表异常无技术细节且清除旧统计', !/TypeError|private_table|stack/.test(await page.getByRole('alert').innerText()) && await page.locator('.usage-scope').count() === 0)
    await page.screenshot({ path: join(output, 'error-redacted.png'), fullPage: true })
    await failure('')
    await page.getByRole('button', { name: '刷新用量', exact: true }).click()
    await page.locator('.usage-scope').waitFor()
    check('异常恢复后可刷新读取', await page.locator('tbody tr').count() === 3)
    const recorded = (await state()).requests
    check('全部业务请求均为隔离夹具', recorded.every(req => req.known), recorded.filter(req => !req.known))
    check('没有真实支付邮件或模型调用', recorded.every(req => req.method === 'GET' || req.path.endsWith('/reviews')))
    check('浏览器无运行异常', errors.length === 0, errors)
    await writeFile(join(output, 'verification.json'), JSON.stringify({ executedAt: new Date().toISOString(), fixturesOnly: true, timezoneId: 'America/Los_Angeles', widths: [320,375,390,768,1440], checks, measurements, requests: recorded, errors }, null, 2))
    console.log(JSON.stringify({ 检查数: checks.length, 通过: checks.filter(c => c.passed).length, 失败: checks.filter(c => !c.passed), 输出目录: output }, null, 2))
    if (checks.some(c => !c.passed)) process.exitCode = 1
  } finally { await browser?.close(); await own?.server.close() }
}
