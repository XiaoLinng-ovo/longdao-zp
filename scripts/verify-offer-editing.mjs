import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const origin = process.argv[2] || 'http://127.0.0.1:5174'
const output = join(root, 'reports/qa-2026-11-10-offer-editing')
const requireRuntime = createRequire(join(process.env.CODEX_NODE_MODULES || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright/package.json'))
const { chromium } = requireRuntime('playwright')
const stamp = '2026-11-10T01:00:00Z'
const workspace = { id: 'offer-qa-workspace', name: '隔离验收企业', kind: 'test', status: 'active', role: 'owner', serviceStatus: 'enabled', serviceAvailable: true, createdAt: stamp }
const application = { id: 'app-1', code: 'APP-QA', candidateId: 'candidate-1', jobId: 'job-1', status: 'offer_cancelled' }
const fixtures = {
  '/me': { user: { id: 'qa-user', name: '验收用户', email: 'qa@example.invalid', role: 'recruiter', departmentId: 'dept-1', workspaceId: workspace.id, workspaceName: workspace.name, workspaceKind: 'test' }, sessionId: 'qa-session', method: 'session', workspaces: [workspace] },
  '/workspaces': [workspace], '/system/features': { recruitmentReportsEnabled: true }, '/trial-usage': { enforced: false, serviceStatus: 'enabled' }, '/auth/csrf': { token: 'isolated-offer-csrf' },
  '/applications': [application], '/offers/eligible-applications': [application],
  '/candidates': [{ id: 'candidate-1', code: 'C-QA', fullName: '隔离候选人', email: 'qa@example.invalid' }],
  '/jobs': [{ id: 'job-1', code: 'J-QA', title: '算法工程师', departmentId: 'dept-1', department: '技术部', status: 'open', createdAt: stamp, updatedAt: stamp }],
  '/departments': [{ id: 'dept-1', code: 'TECH', name: '技术部' }], '/workflow-events': [], '/onboarding': [], '/offer-templates': [],
}
const original = { id: 'version-1', version: 1, positionTitle: '算法工程师', departmentId: 'dept-1', employmentType: 'full_time', startDate: '2026-12-01', reportingLocation: '杭州市测试路100号', invoiceTitle: '原公司抬头', taxNumber: '9133TEST', templateFields: { reportingTime: '09:30', supervisorName: '王主管', supervisorTitle: '技术总监', probationDuration: '3个月', formalSalaryStartMonth: '4', payday: '15' }, compensation: { baseSalary: { amount: 12000, currency: 'CNY' }, probationSalary: { amount: 10000, currency: 'CNY' }, bonus: { amount: 2000, currency: 'CNY' }, equity: '保留股权约定' }, benefits: ['五险一金', '餐补'], materials: ['id_card', 'bank_card:中国银行', 'other:资格证', 'other:成绩单'], content: '<p>保留手写约定。</p><p>{{candidateName}}，欢迎加入。</p><p>{{报到日期}} {{报到时间}} {{报到地点}}</p>', createdAt: stamp }
let offer = { id: 'offer-qa', code: 'OFFER-QA', applicationId: 'app-1', status: 'sent', currentVersionId: original.id, version: 1, createdAt: stamp, updatedAt: stamp, lastEmail: { to: 'saved@example.invalid', subject: '原保存邮件主题' }, versions: [structuredClone(original)] }
const requests = [], checks = [], errors = [], dimensions = []
const check = (label, passed, detail) => checks.push({ label, passed: !!passed, detail })
const browser = await chromium.launch({ headless: true })
try {
  await mkdir(output, { recursive: true })
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 } })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.replace(/^\/api\/v1/u, '')
    const record = { method: req.method(), path, known: true }; requests.push(record)
    const send = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) })
    if (req.method() === 'GET' && Object.hasOwn(fixtures, path)) return send(fixtures[path])
    if (req.method() === 'GET' && path === '/offers') return send([offer])
    if (req.method() === 'GET' && path === '/offers/offer-qa') return send(offer)
    if (req.method() === 'PATCH' && path === '/offers/offer-qa') {
      const body = req.postDataJSON(); record.body = body
      const next = { ...structuredClone(original), ...body, id: 'version-' + (offer.version + 1), version: offer.version + 1, compensation: { baseSalary: body.baseSalary, probationSalary: body.probationSalary, bonus: body.bonus, equity: body.equity } }
      offer = { ...offer, currentVersionId: next.id, version: next.version, versions: [...offer.versions, next] }
      return send(offer)
    }
    if (req.method() === 'POST' && path === '/offers/offer-qa/email-preview') {
      const body = req.postDataJSON(); record.body = body
      return send({ to: body.to, subject: body.subject, html: body.html, versionId: body.versionId })
    }
    record.known = false
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '隔离验收禁止未定义请求' } }) })
  })
  const page = await context.newPage(); page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/offers/offer-qa')
  await page.getByRole('button', { name: '重新发送', exact: true }).click()
  const dialog = page.locator('.offer-revise-dialog')
  await dialog.locator('#offer-reporting-date').waitFor()
  check('重新发送为完整编辑表单', await dialog.locator('.rich-text-content').count() === 1)
  check('回填原日期及旧格式时刻', await dialog.locator('#offer-reporting-date').inputValue() === '2026-12-01' && await dialog.locator('#offer-reporting-time').inputValue() === '09:30')
  check('回填上次收件人和主题', await dialog.locator('#offer-email-to').inputValue() === 'saved@example.invalid' && await dialog.locator('#offer-email-subject').inputValue() === '原保存邮件主题')
  check('手写正文及多项材料完整回填', (await dialog.locator('.rich-text-content').textContent()).includes('保留手写约定') && await dialog.locator('[aria-label="其他入职材料 1"]').inputValue() === '资格证' && await dialog.locator('[aria-label="其他入职材料 2"]').inputValue() === '成绩单')
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await dialog.locator('#offer-reporting-date').scrollIntoViewIfNeeded()
    const layout = await dialog.evaluate(d => {
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } }
      const body = d.querySelector('.offer-revise-body')
      return { viewport: innerWidth, body: { client: body.clientWidth, scroll: body.scrollWidth }, date: rect(d.querySelector('#offer-reporting-date')), footer: rect(d.querySelector('.offer-revise-footer')) }
    })
    dimensions.push(layout)
    check(width + ' 日期完整且无横向溢出', layout.date.width >= 180 && layout.date.right <= width && layout.body.scroll <= layout.body.client + 1, layout)
    check(width + ' 底部按钮可见', layout.footer.top >= 0 && layout.footer.bottom <= 900)
    await page.screenshot({ path: join(output, 'resend-' + width + '.png') })
  }
  await dialog.getByPlaceholder('请输入候选人报到地点').fill('修改后报到地点')
  await dialog.locator('#offer-email-subject').fill('保留的重发主题')
  await dialog.locator('[aria-label="其他入职材料 2"]').fill('修改后的成绩单')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  check('重发关闭后编辑保留未提交输入', await dialog.getByPlaceholder('请输入候选人报到地点').inputValue() === '修改后报到地点' && await dialog.locator('[aria-label="其他入职材料 2"]').inputValue() === '修改后的成绩单')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '重新发送', exact: true }).click()
  check('再次重发保留主题', await dialog.locator('#offer-email-subject').inputValue() === '保留的重发主题')
  await dialog.getByRole('button', { name: '预览邮件', exact: true }).click()
  await page.locator('.email-final-preview').waitFor()
  check('修改先保存新版本再预览', requests.filter(r => r.method === 'PATCH').length === 1 && requests.filter(r => r.path.endsWith('/email-preview')).at(-1).body.versionId === 'version-2')
  check('材料独立修改无覆盖', requests.find(r => r.method === 'PATCH').body.materials.join('|') === 'id_card|bank_card:中国银行|other:资格证|other:修改后的成绩单')
  await page.locator('.offer-email-dialog').getByRole('button', { name: '返回', exact: true }).click()
  check('预览返回保留表单和主题', await dialog.getByPlaceholder('请输入候选人报到地点').inputValue() === '修改后报到地点' && await dialog.locator('#offer-email-subject').inputValue() === '保留的重发主题')
  await dialog.getByRole('button', { name: '预览邮件', exact: true }).click()
  await page.locator('.email-final-preview').waitFor()
  check('原样再次预览无重复版本', requests.filter(r => r.method === 'PATCH').length === 1)
  await page.screenshot({ path: join(output, 'new-version-preview.png') })
  await page.locator('.offer-email-dialog').getByRole('button', { name: '取消', exact: true }).click()
  offer.status = 'cancelled'
  await page.goto(origin + '/offers')
  await page.getByRole('button', { name: '重新创建', exact: true }).click()
  const create = page.locator('.offer-create-dialog')
  await create.locator('#offer-reporting-date').waitFor()
  await page.waitForFunction(() => document.querySelector('#offer-reporting-date')?.value === '2026-12-01')
  check('重新创建继承已保存条款和正文', await create.getByPlaceholder('请输入候选人报到地点').inputValue() === '修改后报到地点' && (await create.locator('.rich-text-content').textContent()).includes('保留手写约定'))
  await create.locator('details summary').click()
  check('重新创建完整保留四项材料', await create.locator('details input[type=checkbox]:checked').count() === 4 && (await create.locator('details').innerText()).includes('修改后的成绩单'))
  await create.getByPlaceholder('请输入候选人报到地点').fill('重新创建未保存地点')
  await create.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '重新创建', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('input[placeholder="请输入候选人报到地点"]')?.value === '重新创建未保存地点')
  check('重新创建关闭重开保留未保存草稿', await create.getByPlaceholder('请输入候选人报到地点').inputValue() === '重新创建未保存地点')
  await page.screenshot({ path: join(output, 'recreate-preserved.png') })
  check('浏览器无运行异常', errors.length === 0, errors)
  check('所有接口均隔离且未发送邮件', requests.every(r => r.known) && !requests.some(r => r.path.endsWith('/send-email')), requests.filter(r => !r.known))
} catch (error) {
  check('浏览器操作完成', false, error.message)
} finally {
  await browser.close()
  await writeFile(join(output, 'verification.json'), JSON.stringify({ fixturesOnly: true, checks, dimensions, errors, requests }, null, 2))
}
console.log(JSON.stringify({ checks: checks.length, passed: checks.filter(c => c.passed).length, failures: checks.filter(c => !c.passed), output }, null, 2))
if (checks.some(c => !c.passed)) process.exitCode = 1
