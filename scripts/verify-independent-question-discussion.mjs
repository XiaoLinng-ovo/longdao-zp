import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const deployedOrigin = process.argv[2]
if (deployedOrigin) {
  const url = new URL(deployedOrigin)
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'Verification only accepts a local service origin')
}
const requireWeb = createRequire(join(root, 'web/package.json'))
const requireRuntime = createRequire(join(process.env.CODEX_NODE_MODULES || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright/package.json'))
const { chromium } = requireRuntime('playwright')
const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
const { default: vue } = await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-vue')).href)
const output = join(root, 'reports', 'independent-question-discussion-' + Date.now())
const stamp = '2026-11-17T00:00:00Z'
const workspace = { id: 'qa-workspace', name: '隔离验收企业', kind: 'test', status: 'active', role: 'owner', serviceAvailable: true, serviceStatus: 'enabled', createdAt: stamp }
const fixtures = {
  '/me': { user: { id: 'qa-user', name: '验收用户', email: 'qa@example.invalid', role: 'recruiter', departmentId: '', workspaceId: workspace.id, workspaceName: workspace.name, workspaceKind: 'test' }, sessionId: 'qa-session', method: 'session', workspaces: [workspace] },
  '/workspaces': [workspace], '/auth/csrf': { token: 'isolated-qa-csrf' }, '/system/features': { recruitmentReportsEnabled: true }, '/trial-usage': { enforced: false, serviceStatus: 'enabled' },
  '/interviews/qa-interview': { id: 'qa-interview', applicationId: 'qa-application', round: 1, status: 'scheduled', participants: [], application: { candidateId: 'qa-candidate', jobId: 'qa-job' } },
  '/candidates': [{ id: 'qa-candidate', fullName: '隔离验收候选人' }], '/jobs': [{ id: 'qa-job', title: '软件工程师' }],
  '/interviews/qa-interview/live-sessions': null, '/interviews/qa-interview/questions': null,
  '/ready': { status: 'ready', checks: { externalServices: { funasr: 'ok', llm: 'ok' } } },
}
let preparation = 'failed', holdDiscussion = false, discussionCalls = 0, releaseDiscussion
const errors = [], checks = [], unknown = []
const check = (label, value) => { checks.push({ label, passed: !!value }); assert.ok(value, label) }
const server = deployedOrigin ? undefined : await createServer({ root: join(root, 'web'), configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 0, proxy: {} } })
let browser
await mkdir(output, { recursive: true })
try {
  await server?.listen()
  const origin = deployedOrigin ? new URL(deployedOrigin).origin : 'http://127.0.0.1:' + server.httpServer.address().port
  console.log('Isolated browser verification: ' + origin)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (!url.pathname.startsWith('/api/')) return route.continue()
    const path = url.pathname.replace(/^\/api\/v1/u, '')
    const send = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) })
    if (request.method() === 'GET' && Object.hasOwn(fixtures, path)) return send(fixtures[path])
    if (path === '/interviews/qa-interview/question-preparation') return send({ status: preparation, completedGroups: [], error: preparation === 'failed' ? '隔离验收：左侧题库生成失败' : undefined })
    if (request.method() === 'POST' && path === '/interviews/qa-interview/questions') {
      const body = request.postDataJSON()
      if (body.refinement) {
        discussionCalls++
        if (holdDiscussion) await new Promise(resolve => { releaseDiscussion = resolve })
        return send({ questions: [], engine: 'llm', mode: 'discussion', bankUpdated: false, advisoryOnly: true, applicationStatusMutation: 'none', assistantMessage: '独立对话回复：请结合简历说明项目中的协作分工。' })
      }
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'MODEL_REQUEST_FAILED', message: '隔离验收：左侧重新生成失败' } }) })
    }
    unknown.push({ method: request.method(), path })
    return route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'QA_ISOLATION', message: 'Undefined isolated request' } }) })
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const open = async () => {
    await page.goto(origin + '/interviews/qa-interview/live')
    await page.getByRole('button', { name: '稍后设置', exact: true }).click()
    await page.getByRole('button', { name: 'AI简历题', exact: true }).click()
    await page.getByRole('dialog', { name: 'AI简历题 参考' }).waitFor()
  }
  const dialog = page.getByRole('dialog', { name: 'AI简历题 参考' })
  const input = dialog.getByLabel('新题目或讨论要求')
  const send = async text => { await input.fill(text); await dialog.getByRole('button', { name: '发送', exact: true }).click() }
  await open()
  await dialog.getByText('隔离验收：左侧题库生成失败', { exact: false }).waitFor()
  check('左侧失败且空题库时右侧输入可用', await input.isEnabled())
  await send('请结合简历给我三个协作问题')
  await dialog.getByText('独立对话回复：请结合简历说明项目中的协作分工。', { exact: true }).waitFor()
  check('右侧成功后左侧失败提示仍保留', await dialog.getByText('隔离验收：左侧题库生成失败', { exact: false }).count() > 0)
  check('右侧成功不写入左侧题库', !(await dialog.locator('.reference-bank-panel').innerText()).includes('独立对话回复'))
  await page.screenshot({ path: join(output, 'failed-left-working-chat-desktop.png'), fullPage: true })
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 })
    check(width + ' 无页面横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    check(width + ' 右侧输入仍可用', await input.isEnabled())
    await input.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(output, 'working-chat-' + width + '.png'), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  preparation = 'generating'
  await open()
  check('左侧生成期间右侧输入可用', await input.isEnabled())
  await send('左侧生成中也请独立出题')
  await dialog.getByText('独立对话回复：请结合简历说明项目中的协作分工。', { exact: true }).waitFor()
  check('右侧回复时左侧等待未结束', await dialog.getByRole('button', { name: /停止等待/ }).count() > 0)
  await page.screenshot({ path: join(output, 'pending-left-working-chat.png'), fullPage: true })
  await dialog.getByRole('button', { name: /停止等待/ }).click()
  holdDiscussion = true
  await send('保持对话生成期间重试左侧')
  await dialog.getByRole('button', { name: '取消生成', exact: true }).waitFor()
  const retryLeft = dialog.getByRole('button', { name: /重试准备|重新生成/ }).first()
  check('右侧生成时左侧重试按钮可用', await retryLeft.isEnabled())
  await retryLeft.click()
  await dialog.getByRole('button', { name: /停止等待/ }).waitFor()
  await dialog.getByRole('button', { name: /停止等待/ }).click()
  check('取消左侧不会取消右侧', await dialog.getByRole('button', { name: '取消生成', exact: true }).isVisible())
  releaseDiscussion()
  await dialog.getByRole('button', { name: '发送', exact: true }).waitFor()
  check('两侧独立请求均可完成', discussionCalls === 3)
  check('无运行时错误和错误遮罩', errors.length === 0 && await page.locator('vite-error-overlay').count() === 0)
  check('全部API请求均被隔离', unknown.length === 0)
} finally {
  releaseDiscussion?.()
  await browser?.close()
  await server?.close()
  await writeFile(join(output, 'report.json'), JSON.stringify({ checks, errors, unknown }, null, 2))
  console.log(JSON.stringify({ output, checks, errors, unknown }, null, 2))
}
