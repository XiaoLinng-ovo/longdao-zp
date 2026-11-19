const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');

const root = resolve(__dirname, '..');
const runtime = process.env.PLAYWRIGHT_MODULE_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { chromium } = createRequire(join(root, 'package.json'))(runtime);
const origin = process.env.PRODUCT_VERSION_WEB_URL || 'http://127.0.0.1:5174';
const reportDir = join(root, 'reports/payments/product-versions');
mkdirSync(reportDir, { recursive: true });

async function checkViewport(browser, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [], unexpected = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const first = { id: randomUUID(), catalogId: randomUUID(), versionNumber: 1, planVersionId: randomUUID(), name: '算力补充包', description: '按实际业务需要使用，长期有效。', amountFen: 9900, currency: 'CNY', durationDays: null, durationMonths: null, active: true, seatLimit: 0, jobLimit: 0, billingKind: 'addon', billingEntitlements: { quotas: { ai_points: 100, interview_seconds: 600, ocr_pages: 20 }, grantPeriod: 'once', rollover: false }, createdAt: '2026-11-12T01:00:00Z', operatorName: '测试管理员', versionReason: '首次发布' };
  const other = { ...structuredClone(first), id: randomUUID(), catalogId: randomUUID(), name: '历史算力包', active: false };
  let products = [first, other], versions = [structuredClone(first)], conflict = false;
  // Every API request is intercepted; this check never writes to a business database.
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1', '');
    let data, status = 200;
    if (path === '/me') data = { user: { id: 'qa-only', name: '测试管理员', email: 'qa@example.invalid', role: 'recruiter', isSystemAdmin: true }, method: 'session', sessionId: 'qa-only', workspaces: [] };
    else if (path === '/system/features') data = { recruitmentReportsEnabled: false };
    else if (path === '/auth/csrf') data = { token: 'qa-only-csrf' };
    else if (path === '/platform/payments' && request.method() === 'GET') data = { productVersioning: true, products, plans: [], providers: [], orders: [], keyConfigured: true, publicBaseURL: 'https://example.invalid' };
    else if (path.endsWith('/history')) data = { catalogId: first.catalogId, currentVersionId: products[0].id, versions: [...versions].reverse() };
    else if (path.endsWith('/revisions')) {
      const input = request.postDataJSON(); writes.push({ path, input });
      if (conflict) status = 409;
      else {
        versions.forEach(version => { version.active = false; });
        data = { ...products[0], ...input, id: randomUUID(), active: true, versionNumber: products[0].versionNumber + 1, versionReason: input.reason };
        products[0] = data; versions.push(structuredClone(data));
      }
    } else if (path.endsWith('/products/merge')) {
      const input = request.postDataJSON(); writes.push({ path, input });
      products = products.filter(product => product.id === input.keepVersionId);
      products[0].active = input.active; data = products[0];
    } else { unexpected.push({ path, method: request.method() }); status = 500; }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? { ok: true, data, requestId: 'qa-only' } : { ok: false, error: { code: 'VERSION_CONFLICT', message: '商品已有新版本，请刷新后重新编辑' }, requestId: 'qa-only' }) });
  });
  const screenshot = async name => {
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const dialog = page.getByRole('dialog');
    if (await dialog.count()) {
      const bounds = await dialog.boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 901);
      await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
      assert(await dialog.getByRole('button').last().isVisible());
    }
    await page.screenshot({ path: join(reportDir, `${name}-${width}.png`) });
  };
  try {
    await page.goto(origin + '/platform/payments');
    await page.locator('.product-form').waitFor();
    await page.getByRole('button', { name: '编辑并上架', exact: true }).first().click();
    await page.getByLabel('售价（元）', { exact: true }).fill('129.50');
    await page.getByLabel('AI 点数', { exact: true }).fill('300');
    await page.getByLabel('发布原因', { exact: true }).fill('优化容量及定价');
    await page.getByRole('button', { name: '预览修改并上架', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /¥99.00/); assert.match(await dialog.innerText(), /¥129.50/);
    assert.equal(writes.length, 0);
    await screenshot('diff');
    await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
    assert.equal(await page.getByLabel('售价（元）', { exact: true }).inputValue(), '129.50');
    await page.getByRole('button', { name: '预览修改并上架', exact: true }).click();
    await dialog.getByRole('button', { name: '确认修改并上架', exact: true }).click();
    await page.getByText('原商品已更新并上架，旧版本及历史订单已保留', { exact: true }).waitFor();
    assert.equal(products.length, 2); assert.equal(products[0].catalogId, first.catalogId); assert.equal(products[0].versionNumber, 2);
    await page.getByRole('button', { name: '历史版本', exact: true }).first().click();
    await dialog.waitFor(); await screenshot('history');
    await dialog.getByRole('button', { name: '以此版本恢复', exact: true }).click();
    assert.equal(await page.getByLabel('售价（元）', { exact: true }).inputValue(), '99.00'); assert.equal(writes.length, 1);
    conflict = true;
    await page.getByRole('button', { name: '预览修改并上架', exact: true }).click();
    await dialog.getByRole('button', { name: '确认修改并上架', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    assert.match(await dialog.getByRole('alert').innerText(), /已有新版本/);
    await screenshot('conflict');
    await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
    await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    await page.getByRole('checkbox', { name: '选择归并 算力补充包', exact: true }).check();
    await page.getByRole('checkbox', { name: '选择归并 历史算力包', exact: true }).check();
    await page.getByRole('button', { name: '归并所选商品', exact: true }).click();
    assert(await dialog.getByRole('button', { name: '确认归并', exact: true }).isDisabled());
    await dialog.getByRole('radio').first().check();
    await dialog.getByLabel('归并原因', { exact: true }).fill('人工确认归并重复商品');
    await screenshot('merge');
    await dialog.getByRole('button', { name: '确认归并', exact: true }).click();
    await page.getByText('商品已归并，历史版本和原订单已保留', { exact: true }).waitFor();
    assert.equal(products.length, 1); assert.equal(products[0].active, false);
    assert.equal(writes.at(-1).input.keepVersionId, products[0].id);
    assert.deepEqual(unexpected, []);
    // A deliberately rejected HTTP request is expected for the conflict check.
    assert.deepEqual(errors.filter(message => !message.includes('409 (Conflict)')), []);
    console.log(`浏览器验收通过：${width}px，编辑确认、取消保留、历史恢复、冲突提示、人工归并。`);
  } catch (error) {
    await page.screenshot({ path: join(reportDir, `failure-${width}.png`) }).catch(() => {});
    console.error(await page.locator('body').innerText()); throw error;
  } finally { await page.close(); }
}

async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  try { for (const width of [1440, 390]) await checkViewport(browser, width); }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
