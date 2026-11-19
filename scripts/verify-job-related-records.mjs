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
const job = { id: 'job-1', code: 'JOB-1', title: '关联跳转验收岗位', department: '研发部', status: 'draft', channels: [], headcount: 1, filledCount: 0, updatedAt: '2026-11-12' }
const application = { id: 'app-1', candidateId: 'candidate-1', jobId: job.id, status: 'rejected', aiStatus: 'completed', score: 90, updatedAt: '2026-11-12' }
const candidate = { id: 'candidate-1', code: 'CAN-1', fullName: '隔离测试候选人', status: 'active', source: '官网投递', applications: [application], updatedAt: '2026-11-12', createdAt: '2026-11-01', jobs: [job], resumes: [], analysisTasks: [], analysisResults: [] }
const batch = { id: 'batch-1', jobId: job.id, status: 'cancelled', createdAt: '2026-11-01', updatedAt: '2026-11-12', counts: { total: 2, pendingUpload: 0, uploading: 0, uploaded: 1, analyzing: 0, completed: 1, failed: 1, cancelled: 0 }, items: [
  { id: 'file-1', originalFilename: '历史候选人简历.pdf', status: 'queued', analysisStatus: 'completed', candidateId: candidate.id, applicationId: application.id },
  { id: 'file-2', originalFilename: '无法解析.pdf', status: 'failed', error: '文件无法解析' },
] }
const records = [
  { kind: 'application', id: application.id, title: candidate.fullName + ' · APP-1', status: 'rejected', candidateId: candidate.id, applicationId: application.id, updatedAt: '2026-11-12' },
  { kind: 'resume_import', id: batch.id, title: '历史候选人简历.pdf', status: 'cancelled', updatedAt: '2026-11-11' },
]
const errors = [], unexpected = [], results = []
let deletes = 0, detaches = 0, applicationDeletes = 0
let detached = false, applicationDeleted = false, jobDeleted = false
const html = '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/__qa-entry.js"></script></html>'
const entry = `import {createApp} from 'vue';import AppShell from '/src/app/layout/AppShell.vue';import {createAppRouter} from '/src/app/router.ts';import {authSession} from '/src/modules/auth/session.ts';import '/src/shared/styles/base.css';import '/src/shared/styles/layout.css';import '/src/shared/styles/components.css';authSession.ready=true;authSession.sessionId='isolated-fixture';authSession.user={id:'fixture-user',name:'隔离测试',role:'recruiter',workspaceId:'fixture-org',departmentId:''};authSession.workspaces=[{id:'fixture-org',name:'隔离验收企业',status:'active',role:'member'}];createApp(AppShell).use(createAppRouter()).mount('#app');`
const server = await createServer({ root: join(root, 'web'), configFile: false, cacheDir: join(root, 'node_modules/.vite-job-related'), optimizeDeps: { include: ['vue', 'vue-router'] }, plugins: [vue(), {
  name: 'isolated-job-related',
  resolveId(id) { if (id === '/__qa-entry.js') return '\0job-related-entry' },
  load(id) { if (id === '\0job-related-entry') return entry },
  configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const path = new URL(req.url, 'http://localhost').pathname
      const send = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, data })) }
      if (!path.includes('.') && !path.startsWith('/api/') && !path.startsWith('/@')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(await vite.transformIndexHtml(path, html))
      }
      if (!path.startsWith('/api/')) return next()
      if (path === '/api/v1/jobs/job-1' && req.method === 'DELETE') {
        if (detached && applicationDeleted) { deletes++; jobDeleted = true; return send({ deleted: true }) }
        deletes++; res.statusCode = 409; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: false, error: { code: 'JOB_IN_USE', message: '该岗位存在关联业务记录，不能直接删除，请先处理关联记录。' } }))
      }
      if (path === '/api/v1/resume-import-batches/batch-1/detach-job' && req.method === 'POST') {
        detaches++; detached = true
        return send({ ...batch, jobId: '', detachedJobId: job.id, detachedJobTitle: job.title, detachedAt: '2026-11-12T04:00:00Z' })
      }
      if (path === '/api/v1/applications/app-1' && req.method === 'DELETE') {
        applicationDeletes++; applicationDeleted = true; return send({ deleted: true })
      }
      assert.equal(req.method, 'GET', '只允许隔离删除模拟，其余业务只读')
      if (path === '/api/v1/jobs') return send(jobDeleted ? [] : [job])
      if (path === '/api/v1/jobs/job-1/related-records') return send(records.filter(record => record.kind === 'application' ? !applicationDeleted : !detached))
      if (path === '/api/v1/resume-import-batches/batch-1') return send(detached ? { ...batch, jobId: '', detachedJobId: job.id, detachedJobTitle: job.title, detachedAt: '2026-11-12T04:00:00Z' } : batch)
      if (path === '/api/v1/candidates/candidate-1') return send(candidate)
      if (path === '/api/v1/departments' || path === '/api/v1/candidate-tags') return send([])
      if (path === '/api/v1/system/features') return send({ recruitmentReportsEnabled: false })
      if (path === '/api/v1/trial-usage') return send({ enforced: false })
      if (path === '/api/v1/auth/csrf') return send({ token: 'isolated-csrf' })
      unexpected.push({ method: req.method, path }); res.statusCode = 404; send(null)
    })
  },
}], server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
  const reportDir = join(root, 'reports/jobs/related-records-isolated')
  await mkdir(reportDir, { recursive: true })
  for (const width of [1440, 390]) {
    detached = false; applicationDeleted = false; jobDeleted = false
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    page.on('dialog', dialog => dialog.accept())
    page.setDefaultTimeout(12000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('409 (Conflict)')) errors.push(message.text()) })
    const openRelated = async () => {
      await page.goto(origin + '/jobs')
      await page.getByRole('button', { name: `删除岗位：${job.title}`, exact: true }).click()
      await page.getByRole('button', { name: '确认删除', exact: true }).click()
      await page.locator('.job-related-records tbody tr').nth(1).waitFor()
      assert.equal(await page.getByRole('dialog').count(), 0)
      const linkBox = await page.locator('.related-link').first().boundingBox()
      assert.ok(linkBox && linkBox.x >= 0 && linkBox.x + linkBox.width <= width, '不滑动也能看到跳转入口')
    }
    await openRelated()
    for (const button of await page.locator('.related-actions button').all()) {
      assert.equal(await button.evaluate(element => element.scrollWidth > element.clientWidth), false, '关联处理按钮文字不能被截断')
    }
    await page.screenshot({ path: join(reportDir, `related-${width}.png`), fullPage: true })
    await page.locator('.job-related-records tbody tr').first().getByRole('link', { name: '查看详情' }).click()
    await page.waitForURL('**/candidates/candidate-1?applicationId=app-1')
    await page.getByRole('heading', { name: '候选人详情', exact: true, level: 2 }).waitFor()
    await openRelated()
    await page.locator('.job-related-records tbody tr').nth(1).getByRole('link', { name: '查看详情' }).click()
    await page.waitForURL('**/resume-import-batches/batch-1')
    await page.getByText('文件无法解析', { exact: true }).waitFor()
    assert.ok((await page.locator('.batch-summary').innerText()).includes('已取消'))
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    assert.equal(overflow, false, '不能出现整页横向溢出')
    await page.screenshot({ path: join(reportDir, `batch-${width}.png`), fullPage: true })
    await page.getByRole('link', { name: '查看候选人' }).click()
    await page.waitForURL('**/candidates/candidate-1?applicationId=app-1')
    await openRelated()
    await page.locator('.job-related-records').getByRole('button', { name: '删除申请', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.job-related-records tbody tr').length === 1)
    await page.locator('.job-related-records').getByRole('link', { name: '查看详情' }).click()
    await page.getByRole('button', { name: '解除岗位关联', exact: true }).click()
    await page.getByText('已解除岗位关联，导入历史及候选人资料已保留。', { exact: true }).waitFor()
    assert.equal(await page.locator('.batch-files tbody tr').count(), 2, '解除关联不能删除批次文件')
    await page.screenshot({ path: join(reportDir, `detached-${width}.png`), fullPage: true })
    await page.getByRole('link', { name: '返回岗位管理' }).click()
    await page.getByText('关联记录已处理，可以继续删除岗位。', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.locator('.job-related-records').getByRole('button', { name: '删除岗位', exact: true }).click()
    await page.getByRole('button', { name: '确认删除', exact: true }).click()
    await page.getByText(`岗位“${job.title}”已删除`, { exact: true }).waitFor()
    const retainedCandidate = await page.request.get(origin + '/api/v1/candidates/candidate-1')
    assert.equal((await retainedCandidate.json()).data.id, candidate.id)
    results.push({ width, applicationNavigation: true, batchNavigation: true, itemNavigation: true, detachHistoryPreserved: true, deleteJobAfterCleanup: true, overflow })
    await page.close()
  }
  assert.equal(deletes, 8)
  assert.equal(detaches, 2)
  assert.equal(applicationDeletes, 2)
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, [])
  await writeFile(join(reportDir, 'results.json'), JSON.stringify({ results, deletes, detaches, applicationDeletes, errors, unexpected }, null, 2))
  console.log(JSON.stringify({ results, deletes, detaches, applicationDeletes, errors, unexpected }, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
