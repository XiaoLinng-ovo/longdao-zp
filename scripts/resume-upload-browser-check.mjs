import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function verifyResumeUploadBrowser({ root, baseUrl, token, csrf, jobId, reportDirectory, loseResponse = false }) {
  const require = createRequire(join(root, 'web/package.json'))
  const { chromium } = require(process.env.RESUME_LOAD_PLAYWRIGHT || 'playwright')
  const { createServer } = await import(pathToFileURL(join(root, 'web/node_modules/vite/dist/node/index.js')).href)
  const vite = await createServer({ root: join(root, 'web'), configFile: join(root, 'web/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': baseUrl } } })
  let browser
  try {
    await vite.listen()
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
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
    await page.locator('#candidate-resume-file').setInputFiles({ name: '合成测试_AI工程师_782KB.pdf', mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7\n% Synthetic upload fixture, not a personal resume.\n'.padEnd(782 * 1024, ' ')) })
    await page.locator('#candidate-resume-job').selectOption(jobId)
    await page.locator('.resume-submit').click()
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-status="queued"]').length === 1, null, { timeout: 15000 })
    } catch (error) {
      console.error(JSON.stringify({ uploads, failures, errors, dialog: await page.locator('.resume-dialog').innerText() }))
      throw error
    }
    await page.screenshot({ path: join(reportDirectory, loseResponse ? 'real-http-browser-response-recovery.png' : 'real-http-browser-upload.png'), fullPage: true })
    assert.deepEqual(errors, [])
    if (loseResponse) assert.equal(acceptedBeforeDisconnect, 1, 'A lost response must not resend the file')
    else assert.deepEqual(uploads.map(upload => upload.status), [200])
    batchId ??= uploads[0].path.split('/')[4]
    return { bytes: 782 * 1024, batchId, uploads, errors, failures, queued: 1, mocks: false, acceptedBeforeDisconnect }
  } finally {
    await browser?.close()
    await vite.close()
  }
}
