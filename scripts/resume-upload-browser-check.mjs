import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function verifyResumeUploadBrowser({ root, baseUrl, token, csrf, jobId, reportDirectory, loseResponse = false }) {
  const require = createRequire(join(root, 'web/package.json'))
  const runtime = createRequire(join(process.env.CODEX_NODE_MODULES || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'), 'playwright/package.json'))
  const { chromium } = process.env.RESUME_LOAD_PLAYWRIGHT ? require(process.env.RESUME_LOAD_PLAYWRIGHT) : runtime('playwright')
  const { createServer } = await import(pathToFileURL(join(root, 'web/node_modules/vite/dist/node/index.js')).href)
  const { default: vue } = await import(pathToFileURL(require.resolve('@vitejs/plugin-vue')).href)
  assert.equal(new URL(baseUrl).hostname, '127.0.0.1', '浏览器验收只能代理独立本机接口')
  const vite = await createServer({ root: join(root, 'web'), configFile: false, plugins: [vue()],
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: baseUrl,
      configure(proxy) { proxy.on('proxyReq', request => request.setHeader('origin', 'http://127.0.0.1:5173')) },
    } } } })
  let browser
  try {
    await vite.listen()
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await context.addCookies([
      { name: 'smartrecruit_session', value: token, url: origin, httpOnly: true },
      { name: 'smartrecruit_csrf', value: csrf, url: origin },
    ])
    const page = await context.newPage()
    const errors = [], uploads = [], failures = []
    let batchId, acceptedBeforeDisconnect = 0
    page.on('pageerror', error => errors.push(error.message))
    page.on('requestfailed', request => failures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }))
    page.on('response', response => {
      if (new URL(response.url()).pathname.endsWith('/content')) uploads.push({ status: response.status(), path: new URL(response.url()).pathname })
    })
    if (loseResponse) {
      await page.route('**/resume-import-batches/*/items/*/content', async route => {
        const response = await route.fetch()
        assert.equal(response.status(), 200)
        batchId = new URL(route.request().url()).pathname.split('/')[4]
        acceptedBeforeDisconnect++
        await route.abort('failed')
      })
    }
    await page.goto(`${origin}/candidates`)
    await page.getByRole('button', { name: '上传简历并建档', exact: true }).click()
    const content = Buffer.from('姓名：浏览器合成候选人\n学历：本科\n经验：五年软件研发，Java、PostgreSQL、Vue。\n'.repeat(20))
    await page.locator('#candidate-resume-file').setInputFiles({ name: '浏览器合成候选人.txt', mimeType: 'text/plain', buffer: content })
    await page.locator('#candidate-resume-job').selectOption(jobId)
    await page.locator('.resume-submit').click()
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-status="queued"], [data-status="processing"], [data-status="completed"]').length === 1, null, { timeout: 15000 })
    } catch (error) {
      console.error(JSON.stringify({ uploads, failures, errors, dialog: await page.locator('.resume-dialog').innerText() }))
      throw error
    }
    await page.screenshot({ path: join(reportDirectory, loseResponse ? 'real-http-browser-response-recovery.png' : 'real-http-browser-upload.png'), fullPage: true })
    assert.deepEqual(errors, [])
    if (loseResponse) assert.equal(acceptedBeforeDisconnect, 1, 'A lost response must not resend the file')
    else assert.deepEqual(uploads.map(upload => upload.status), [200])
    batchId ??= uploads[0].path.split('/')[4]
    return { bytes: content.length, batchId, uploads, errors, failures, queued: 1, mocks: false, acceptedBeforeDisconnect }
  } finally {
    await browser?.close()
    await vite.close()
  }
}
