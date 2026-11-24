import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const requireWeb = createRequire(join(root, 'web/package.json'))
const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
const { default: vue } = await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-vue')).href)
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href)
const jobs = ['开发工程师', '产品经理'].map((title, i) => ({ id: `job-${i}`, code: `JOB-${i}`, title, department: '研发部', channels: [], status: 'active', createdAt: '2026-11-01', updatedAt: '2026-11-12' }))
const candidates = Array.from({ length: 60 }, (_, i) => ({
  id: `candidate-${i}`, code: `CAN-${i}`, fullName: `测试候选人${String(i).padStart(2, '0')}`, source: '官网投递', status: 'active', updatedAt: '2026-11-12', score: 90, aiStatus: 'completed',
  applications: [0, 1].map(j => ({ id: `app-${i}-${j}`, candidateId: `candidate-${i}`, jobId: `job-${j}`, status: 'human_review', aiStatus: 'completed', score: 90 - j, updatedAt: '2026-11-12' })),
}))
let delayList = false
const unexpected = [], errors = [], results = []
const html = '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/__qa-entry.js"></script></html>'
const entry = `
import {createApp} from 'vue';
import AppShell from '/src/app/layout/AppShell.vue';
import {createAppRouter} from '/src/app/router.ts';
import {authSession} from '/src/modules/auth/session.ts';
import '/src/shared/styles/base.css';import '/src/shared/styles/layout.css';import '/src/shared/styles/components.css';
authSession.ready=true;authSession.sessionId='isolated-fixture';
authSession.user={id:'fixture-user',name:'隔离测试',role:'recruiter',workspaceId:'fixture-org',departmentId:''};
authSession.workspaces=[{id:'fixture-org',name:'隔离验收企业',status:'active',role:'member'}];
const router=createAppRouter();window.fixtureRouter=router;
createApp(AppShell).use(router).mount('#app');`
const server = await createServer({ root: join(root, 'web'), configFile: false, cacheDir: join(root, 'node_modules/.vite-candidate-navigation'), optimizeDeps: { include: ['vue', 'vue-router'] }, plugins: [vue(), {
  name: 'isolated-candidate-navigation',
  resolveId(id) { if (id === '/__qa-entry.js') return '\0candidate-navigation-entry' },
  load(id) { if (id === '\0candidate-navigation-entry') return entry },
  configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const path = new URL(req.url, 'http://localhost').pathname
      const send = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, data })) }
      if (!path.includes('.') && !path.startsWith('/api/') && !path.startsWith('/@')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(await vite.transformIndexHtml(path, html))
      }
      if (!path.startsWith('/api/')) return next()
      if (path === '/api/v1/candidates') {
        if (delayList) await new Promise(resolve => setTimeout(resolve, 650))
        return send(candidates)
      }
      if (path === '/api/v1/jobs') return send(jobs)
      if (path === '/api/v1/candidate-tags') return send([])
      if (path === '/api/v1/trial-usage') return send({ enforced: false })
      if (path === '/api/v1/auth/csrf') return send({ token: 'isolated-csrf' })
      const candidate = candidates.find(candidate => path === '/api/v1/candidates/' + candidate.id)
      if (candidate) {
        assert.equal(req.method, 'GET', '验收禁止修改真实或模拟业务数据')
        return send({ ...candidate, createdAt: '2026-11-01', jobs, resumes: [], analysisTasks: [], analysisResults: [] })
      }
      unexpected.push({ method: req.method, path }); res.statusCode = 404; send(null)
    })
  },
}], server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const reportDir = join(root, 'reports/candidates/navigation-isolated')
  await mkdir(reportDir, { recursive: true })
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(origin + '/candidates')
    await page.locator('.name-link').first().waitFor()
    await page.getByLabel('简历库搜索').fill('测试')
    await page.getByLabel('评分排序').selectOption('desc')
    const target = page.locator('tr').filter({ has: page.getByRole('button', { name: '测试候选人20', exact: true }) })
    await target.getByRole('button', { name: /展开/ }).click()
    const open = target.getByRole('button', { name: '详情', exact: true })
    await open.scrollIntoViewIfNeeded()
    await page.evaluate(() => { window.scrollBy(0, -240); document.querySelector('.table-wrap').scrollLeft = 180 })
    // Ensure the action is visible before capturing the position that navigation should restore.
    await open.scrollIntoViewIfNeeded()
    const before = await page.evaluate(() => ({ top: window.scrollY, left: document.querySelector('.table-wrap').scrollLeft }))
    assert.ok(before.top > 500, '必须从长列表中部进入详情')
    await page.screenshot({ path: join(reportDir, `before-${width}.png`) })
    await open.click()
    await page.getByRole('heading', { name: '候选人详情', exact: true, level: 2 }).waitFor()
    await page.waitForFunction(() => !document.querySelector('.loading-note'))
    await page.waitForFunction(() => window.scrollY === 0)
    delayList = true
    await page.getByRole('button', { name: '返回列表', exact: true }).click()
    await page.waitForURL('**/candidates')
    await page.waitForFunction(top => Math.abs(window.scrollY - top) <= 2, before.top)
    assert.equal(await page.locator('.loading-note').count(), 0)
    assert.equal(await page.getByLabel('简历库搜索').inputValue(), '测试')
    assert.equal(await page.getByLabel('评分排序').inputValue(), 'desc')
    assert.equal(await page.locator('.application-subrow').count(), 1)
    await page.waitForTimeout(900)
    const after = await page.evaluate(() => ({ top: window.scrollY, left: document.querySelector('.table-wrap').scrollLeft }))
    assert.ok(Math.abs(before.top - after.top) <= 2, JSON.stringify({ before, after }))
    assert.equal(after.left, before.left)
    await page.screenshot({ path: join(reportDir, `returned-${width}.png`) })
    // Browser forward/back must preserve the same list as the detail-page return button.
    await page.goForward(); await page.getByRole('button', { name: '返回列表', exact: true }).waitFor()
    await page.goBack(); await page.waitForFunction(top => Math.abs(window.scrollY - top) <= 2, before.top)
    results.push({ width, before, after, filtersRetained: true, applicationsRetained: true })
    delayList = false
    await page.close()
  }
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, [])
  await writeFile(join(reportDir, 'results.json'), JSON.stringify({ results, errors, unexpected }, null, 2))
  console.log(JSON.stringify({ results, errors, unexpected }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
