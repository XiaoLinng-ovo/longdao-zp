import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchIsolatedBrowser } from './isolated-browser-launch.mjs'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'tmp/offer-optimization-browser')
const directory = await mkdtemp(join(tmpdir(), 'offer-flow-'))
const checks = [], errors = [], httpFailures = []
let api, vite, browser, page
const check = (name, value) => { assert.ok(value, name); checks.push({ name, passed: true }) }
// Use the actual HTTP handlers and in-memory test stores, never the business DB or SMTP.
Object.assign(process.env, { NODE_ENV: 'test', AUTH_STORE_PATH: join(directory, 'auth.json'), REQUIRE_CSRF: 'true',
  ALLOWED_ORIGINS: 'http://127.0.0.1:5177', ALLOW_DEV_BOOTSTRAP_AUTH: 'false', PGHOST: '127.0.0.1', PGPORT: '1', PGDATABASE: 'isolated_offer_test', PGPASSWORD: '' })
delete process.env.DATABASE_URL
try {
  await mkdir(output, { recursive: true })
  const { createHttpServer } = await import('../apps/api/dist/src/server.js')
  const { loadConfig } = await import('../apps/api/dist/src/config.js')
  // Ancillary read-only fixtures; recruiting writes still use the actual isolated store.
  const department = { id: 'dept-success', code: 'dept-success', name: '客户成功部', is_active: true,
    created_at: '2026-11-27T00:00:00Z', updated_at: '2026-11-27T00:00:00Z' }
  const fixturePool = {
    async query(sql) {
      assert.match(sql.trim(), /^(?:SELECT\b|WITH session_scores AS\s*\()/i, 'Unexpected database write in isolated browser verification')
      return { rows: /FROM departments\b/.test(sql) ? [department] : [], rowCount: 0 }
    },
    async end() {},
  }
  api = createHttpServer(loadConfig({ NODE_ENV: 'test', PORT: '0' }), { poolFactory: () => fixturePool })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  const apiOrigin = 'http://127.0.0.1:' + api.address().port
  const { createServer } = await import('../web/node_modules/vite/dist/node/index.js')
  vite = await createServer({ root: join(root, 'web'), configFile: join(root, 'web/vite.config.ts'), server: {
    host: '127.0.0.1', port: 5177, strictPort: true, proxy: { '/api': { target: apiOrigin, xfwd: true } } } })
  await vite.listen()
  const playwrightPath = process.env.PLAYWRIGHT_MODULE || 'C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1123-915-0_26.1123.915.0_x64__3k8sg7r9htsxt/dependencies/node/node_modules/playwright/index.mjs'
  const { chromium } = await import(pathToFileURL(playwrightPath).href)
  ;({ browser } = await launchIsolatedBrowser(chromium, { headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' }))
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' })
  const origin = 'http://127.0.0.1:5177'
  const login = await context.request.post(origin + '/api/v1/auth/login', { data: { email: 'recruiter@smartrecruit.local', password: 'recruiter123' } })
  assert.equal(login.status(), 200)
  const csrf = (await context.cookies()).find(row => row.name === 'smartrecruit_csrf')?.value
  assert.ok(csrf)
  const request = async (method, path, data) => {
    const currentCsrf = (await context.cookies()).find(row => row.name === 'smartrecruit_csrf')?.value
    assert.ok(currentCsrf)
    const response = await context.request.fetch(origin + '/api/v1' + path, { method, ...(data ? { data } : {}), headers: { origin, 'x-csrf-token': decodeURIComponent(currentCsrf) } })
    const body = await response.json()
    assert.ok(response.ok(), method + ' ' + path + ': ' + JSON.stringify(body))
    return body.data
  }
  const workspace = await request('POST', '/workspaces', { name: 'Offer 隔离验收企业', kind: 'test' })
  await request('POST', '/workspaces/' + workspace.id + '/select', {})
  await request('GET', '/me')
  const created = await request('POST', '/interviews', { applicationId: 'application-8814', round: 2, title: 'Offer 联动验收', type: 'technical', scheduledStartAt: '2026-11-27T09:00:00Z', scheduledEndAt: '2026-11-27T10:00:00Z', location: '隔离测试会议室', participants: [{ userId: 'user-recruiter', name: '招聘专员', role: 'interviewer', lead: true, required: true, sheetTypes: ['business', 'hr', 'boss'] }] })
  page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.status() >= 500) httpFailures.push({ status: response.status(), path: new URL(response.url()).pathname }) })
  await page.goto(origin + '/interviews')
  const row = page.locator('tr').filter({ hasText: '赵雨欣' }).filter({ has: page.getByRole('button', { name: '详情', exact: true }) })
  await row.getByRole('button', { name: '详情', exact: true }).click()
  await page.waitForURL('**/interviews/*')
  await page.getByRole('button', { name: '完成面试', exact: true }).click()
  await page.getByRole('dialog').locator('select').selectOption('offer')
  await page.getByRole('button', { name: '确认完成', exact: true }).click()
  await page.waitForURL('**/offers*')
  const dialog = page.getByRole('dialog', { name: '新建 Offer' })
  await dialog.waitFor()
  check('Final pass navigates and preselects the exact application without creating an offer',
    await dialog.locator('select').first().inputValue() === 'application-8814' && (await request('GET', '/offers')).length === 0)
  await dialog.locator('#offer-probationDuration').fill('3个月')
  await dialog.getByLabel('初期薪资后调整', { exact: true }).check()
  await dialog.locator('#offer-initial-months').fill('1')
  await dialog.locator('#offer-initial-salary').fill('8000')
  await dialog.locator('#offer-normal-salary').fill('10000')
  await page.waitForFunction(() => document.querySelector('.salary-summary')?.textContent.includes('第 2 个月起正常月薪 10,000 元'))
  check('Three-month probation with one initial salary month has an explicit summary', (await dialog.locator('.salary-summary').textContent()).includes('试用期 3个月'))
  const layouts = []
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await dialog.locator('.offer-salary-fields').scrollIntoViewIfNeeded()
    const layout = await dialog.evaluate(element => ({ viewport: innerWidth, width: element.getBoundingClientRect().width,
      overflow: element.querySelector('.offer-create-body').scrollWidth - element.querySelector('.offer-create-body').clientWidth,
      fields: [...element.querySelectorAll('.offer-salary-fields input')].map(input => { const rect = input.getBoundingClientRect(); return { left: rect.left, right: rect.right } }) }))
    check('Salary form fits viewport ' + width, layout.overflow <= 1 && layout.width <= width && layout.fields.every(field => field.left >= 0 && field.right <= width))
    layouts.push(layout)
    await page.screenshot({ path: join(output, 'create-' + width + '.png') })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  const createResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/offers')
  await dialog.getByRole('button', { name: '保存草稿', exact: true }).click()
  const saved = await createResponse; assert.equal(saved.status(), 201, await saved.text())
  const offer = (await saved.json()).data
  const detail = await request('GET', '/offers/' + offer.id)
  const version = detail.versions.find(item => item.id === detail.currentVersionId)
  check('HTTP persisted independent probation and salary months', version.templateFields.probationDuration === '3个月' && version.templateFields.probationSalaryMonths === '1' && version.templateFields.formalSalaryStartMonth === '2')
  check('Offer body uses the staged salary summary', version.content.includes('第 2 个月起正常月薪 10,000 元'))
  const legacyEmail = await request('POST', '/offers/' + offer.id + '/email-preview', { versionId: detail.currentVersionId,
    to: 'synthetic@example.invalid', subject: 'Legacy template verification', html: '<p>{{试用期工资}} / {{转正后工资}}</p><p>{{薪资安排说明}}</p>' })
  check('Legacy salary variables and staged policy render together without sending', legacyEmail.html.includes('8,000 / 10,000') && legacyEmail.html.includes('第 2 个月起正常月薪 10,000 元') && !legacyEmail.html.includes('{{'))
  await page.goto(origin + '/offers?createApplicationId=application-8814')
  await page.waitForURL('**/offers/' + offer.id)
  check('Re-entering the same application opens the existing offer', await page.getByRole('dialog').count() === 0)
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const revise = page.getByRole('dialog', { name: '修订 Offer' })
  await revise.getByLabel('入职即正常月薪', { exact: true }).check()
  const review = revise.locator('.salary-body-review input')
  if (await review.count()) await review.check()
  const updateResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && response.url().endsWith('/offers/' + offer.id))
  await revise.getByRole('button', { name: '保存修订', exact: true }).click()
  const updated = await updateResponse; assert.equal(updated.status(), 200, await updated.text())
  await revise.waitFor({ state: 'hidden' })
  const revised = await request('GET', '/offers/' + offer.id)
  const current = revised.versions.find(item => item.id === revised.currentVersionId)
  check('Switching to regular salary clears the stored initial salary', !current.compensation.probationSalary && current.templateFields.probationSalaryMonths === '0' && current.templateFields.probationDuration === '3个月')
  check('The prior offer version remains unchanged', revised.versions.find(item => item.id === version.id).compensation.probationSalary.amount === 8000)
  const email = await request('POST', '/offers/' + offer.id + '/email-preview', { versionId: revised.currentVersionId,
    to: 'synthetic@example.invalid', subject: 'Offer verification', html: '<p>{{薪资安排说明}}</p><p>{{正常月薪}}</p>' })
  check('Actual email preview renders the same salary policy without sending', email.html.includes('入职起正常月薪 10,000 元') && !email.html.includes('{{'))
  check('No browser exceptions or server errors', errors.length === 0 && httpFailures.length === 0)
  await page.screenshot({ path: join(output, 'revised-desktop.png'), fullPage: true })
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, storage: 'isolated in-memory stores; actual HTTP API; no business DB, SMTP or model calls', interviewId: created.id, checks, layouts, errors, httpFailures }, null, 2))
  console.log(JSON.stringify({ passed: true, checks: checks.length, report: join(output, 'report.json') }))
} catch (error) {
  if (page) { await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(join(output, 'failure-page.txt'), await page.locator('body').innerText()).catch(() => {}) }
  await writeFile(join(output, 'failure.json'), JSON.stringify({ passed: false, message: error.message, stack: error.stack, checks, errors, httpFailures }, null, 2)).catch(() => {})
  throw error
} finally {
  await browser?.close()
  await vite?.close()
  if (api) await api.closeAsync()
  const resolved = resolve(directory)
  assert.ok(resolved.startsWith(resolve(tmpdir()) + '\\') || resolved.startsWith(resolve(tmpdir()) + '/'))
  await rm(resolved, { recursive: true, force: true })
}
