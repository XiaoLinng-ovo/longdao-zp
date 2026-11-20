import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const root = resolve(import.meta.dirname, '..');
const preview = process.argv.includes('--preview');
const requireWeb = createRequire(join(root, 'web/package.json'));
const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href);
const { default: vue } = await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-vue')).href);
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const now = new Date().toISOString();
const quotas = { ai_points: 5000, interview_seconds: 7200, ocr_pages: 0 };
const products = [
  { id: 'credits', name: '标准算力包', description: '企业共享，购买后长期有效', amountFen: 9900, durationDays: null, billingKind: 'addon', seatLimit: 0, jobLimit: 0, active: true, billingEntitlements: { quotas, grantPeriod: 'once', rollover: false } },
  { id: 'team', planVersionId: 'plan', name: '协作服务', description: '按月订阅，满足团队招聘需求', amountFen: 29900, durationDays: null, durationMonths: 1, billingKind: 'subscription', seatLimit: 12, jobLimit: 40, active: true, billingEntitlements: { quotas: { ai_points: 1000, interview_seconds: 3600, ocr_pages: 50 }, grantPeriod: 'monthly', rollover: false } },
  { id: 'small', planVersionId: 'small-plan', name: '小型服务', amountFen: 9900, durationDays: 30, billingKind: 'subscription', seatLimit: 1, jobLimit: 1, active: true },
];
const rules = Object.fromEntries(['resume_analysis', 'job_spec', 'jd', 'interview_questions', 'answer_analysis', 'interview_summary', 'transcript_processing', 'interview_audio', 'ocr'].map(key => [key, { enabled: true, resource: key === 'interview_audio' ? 'interview_seconds' : key === 'ocr' ? 'ocr_pages' : 'ai_points', quantity: key === 'interview_audio' ? 60 : 1, unitSize: key === 'interview_audio' ? 60 : 1 }]));
const billing = { enabled: false, serviceAvailable: true, rules, resources: [
  { resource: 'ai_points', available: '5000', permanent: '4000', reserved: '20', next_expiry: null },
  { resource: 'interview_seconds', available: '7200', permanent: '3600', reserved: '60', next_expiry: null },
  { resource: 'ocr_pages', available: '50', permanent: '0', reserved: '0', next_expiry: null },
], tasks: [], grants: [{ id: 'grant', resource: 'ai_points', remaining: '4000', total: '5000', valid_from: now, expires_at: null, source: 'paid_addon', name: '标准算力包' }] };
const checkout = { products, billing, providers: [{ id: 'ali', name: '支付宝隔离渠道', kind: 'alipay', environment: 'sandbox' }], orders: [
  { id: 'addon-order', outTradeNo: 'ISOLATED_CREDITS', name: '算力历史订单', billingKind: 'addon', status: 'fulfilled', amountFen: 9900, createdAt: now },
  { id: 'sub-order', outTradeNo: 'ISOLATED_SERVICE', name: '订阅历史订单', billingKind: 'subscription', status: 'fulfilled', amountFen: 29900, createdAt: now },
], pendingOrder: null, canPurchase: true, organization: { id: 'fixture-org', name: '隔离验收企业', planVersionId: 'plan', planName: '协作服务', entitlementVersion: 3, seatUsage: 3, jobUsage: 5, seatLimit: 12, jobLimit: 40, serviceAvailable: true, expiresAt: '2099-01-01T00:00:00Z' } };
const policy = { version: 'fixture-policy', history: [], tasks: [], config: { enabled: false, rules, limits: { maxConcurrent: 2, dailyAiPoints: 1000, maxInputChars: 10000, maxOutputTokens: 2000 }, trial: { durationDays: 14, seatLimit: 5, jobLimit: 20, resumeUploads: 3, interviews: 3, aiGenerations: 3, aiPoints: 100, interviewSeconds: 3600, ocrPages: 20 } } };
const requests = [], unexpected = [], errors = [], results = [];
let expired = false;
const previewNavigation = preview ? '<nav style="padding:12px 16px;background:#fff3cd;color:#493c12;line-height:1.8">隔离预览：示例数据，不保存更改或产生订单。 <a href="/enterprise/payments">充值与订阅</a> · <a href="/platform/payments">平台配置</a> · <a href="/enterprise/billing">共享余额</a></nav>' : '';
const html = `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">${previewNavigation}<div id="app"></div><script type="module" src="/__qa-entry.js"></script></html>`;
const entry = `import {createApp} from 'vue';import {createRouter,createWebHistory,RouterView} from 'vue-router';import Enterprise from '/src/modules/platform/pages/EnterprisePaymentsPage.vue';import Platform from '/src/modules/platform/pages/PlatformPaymentsPage.vue';import Billing from '/src/modules/platform/components/EnterpriseBillingPanel.vue';import {authSession} from '/src/modules/auth/session.ts';import '/src/shared/styles/base.css';authSession.ready=true;authSession.sessionId='isolated-fixture';authSession.user={id:'fixture-user',name:'隔离验收',role:'recruiter',isSystemAdmin:true,workspaceId:'fixture-org'};const router=createRouter({history:createWebHistory(),routes:[{path:'/enterprise/payments',name:'enterprise-payments',component:Enterprise},{path:'/enterprise/payments/:id',name:'enterprise-payment-order',component:Enterprise},{path:'/platform/payments',component:Platform},{path:'/enterprise/billing',component:Billing},{path:'/workspaces',component:{template:'<p>企业工作空间</p>'}}]});createApp(RouterView).use(router).mount('#app');`;
const server = await createServer({ root: join(root, 'web'), configFile: false, cacheDir: join(root, 'node_modules/.vite-permanent-credits'), optimizeDeps: { include: ['vue', 'vue-router'] }, server: { host: '127.0.0.1', port: preview ? 15480 : 0, strictPort: preview }, plugins: [vue(), {
  name: 'isolated-permanent-credits',
  resolveId(id) { if (id === '/__qa-entry.js') return '\0credits-entry'; },
  load(id) { if (id === '\0credits-entry') return entry; },
  configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const path = new URL(req.url, 'http://localhost').pathname;
      const send = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: true, data })); };
      if (!path.includes('.') && !path.startsWith('/api/') && !path.startsWith('/@')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(await vite.transformIndexHtml(path, html));
      }
      if (!path.startsWith('/api/')) return next();
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = body ? JSON.parse(body) : null;
      if (req.method !== 'GET') requests.push({ path, input });
      if (path === '/api/v1/auth/csrf') return send({ token: 'isolated-csrf' });
      if (preview && req.method !== 'GET') {
        res.statusCode = 409;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ ok: false, error: { code: 'ISOLATED_PREVIEW', message: '当前为隔离预览，不保存更改、不创建真实订单。' } }));
      }
      if (path === '/api/v1/payments/workspaces/fixture-org') return send({ ...checkout, organization: { ...checkout.organization, serviceAvailable: !expired } });
      if (path.endsWith('/usage')) return send(billing);
      if (path === '/api/v1/platform/payments') return send({ plans: [], products, providers: [], orders: [], keyConfigured: true, publicBaseURL: 'https://isolated.invalid' });
      if (path === '/api/v1/platform/customers') return send({ items: [{ id: 'fixture-org', name: '隔离验收企业' }], total: 1, page: 1, pageSize: 20 });
      if (path === '/api/v1/platform/payments/billing-policy') return send(policy);
      if (path === '/api/v1/platform/payments/products') return send({ ...products[0], ...input, id: 'published' });
      if (path === '/api/v1/platform/payments/quota-grants') return send({ id: 'manual-grant' });
      if (path === '/api/v1/platform/payments/credit-conversions/legacy-order') return send({ orderId: 'legacy-order', digest: 'isolated-digest', grants: [{ id: 'legacy-grant', resource: 'ai_points', total: '100', remaining: '80', expires_at: '2099-01-01T00:00:00Z', blockedReason: null }] });
      if (path === '/api/v1/platform/payments/credit-conversions') return send({ converted: 1 });
      unexpected.push({ path, method: req.method }); res.statusCode = 500; send({ error: '未模拟的隔离接口' });
    });
  },
}] });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  if (preview) {
    console.log(`隔离预览已启动：${origin}/enterprise/payments`);
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } else {
  browser = await chromium.launch({ headless: true });
  const reportDir = join(root, 'reports/payments/permanent-credits');
  await mkdir(reportDir, { recursive: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', dialog => dialog.accept());
    const checkLayout = async name => {
      assert.equal(await page.locator('vite-error-overlay').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}不得整页横向溢出`);
      await page.screenshot({ path: join(reportDir, `${name}-${width}.png`), fullPage: true });
    };
    expired = false;
    await page.goto(origin + '/enterprise/payments');
    await page.getByRole('button', { name: '标准算力包', exact: false }).waitFor();
    assert.equal(await page.locator('.product').count(), 1);
    assert.match(await page.locator('.product').innerText(), /120.*分钟/);
    assert.match(await page.locator('.product').innerText(), /长期有效/);
    assert.doesNotMatch(await page.locator('.product').innerText(), /OCR|个席位/);
    await checkLayout('credits');
    await page.getByRole('button', { name: '服务订阅', exact: true }).click();
    await page.getByRole('region', { name: '当前订阅' }).waitFor();
    assert.equal(await page.locator('.product').count(), 2);
    assert.match(await page.locator('.product').first().innerText(), /12 个席位/);
    await page.getByRole('button', { name: '小型服务', exact: false }).click();
    assert.equal(await page.locator('button[type=submit]').isDisabled(), true);
    await checkLayout('subscription');
    await page.locator('.history-filter select').selectOption('addon');
    assert.equal(await page.locator('.history tbody tr').count(), 1);
    assert.match(await page.locator('.history tbody').innerText(), /算力历史订单/);
    expired = true;
    await page.getByRole('button', { name: '刷新余额和商品' }).click();
    await page.getByText('企业服务已到期或暂停，已有付费余额保留。', { exact: false }).waitFor();
    await page.getByRole('button', { name: '算力充值', exact: true }).click();
    assert.equal(await page.locator('button[type=submit]').isDisabled(), true);
    await page.getByRole('button', { name: '开通或续费服务' }).click();
    await page.getByRole('button', { name: '协作服务', exact: false }).click();
    assert.equal(await page.locator('button[type=submit]').isDisabled(), false);
    await page.goto(origin + '/platform/payments');
    await page.getByRole('heading', { name: '商品与定价', exact: true }).waitFor();
    const form = page.locator('.product-form');
    await form.getByLabel(/^商品类型/).selectOption('addon');
    assert.equal(await form.getByLabel('长期有效（一次到账）').isChecked(), true);
    assert.equal(await form.getByLabel('有效天数').count(), 0);
    await form.getByLabel('商品名称', { exact: true }).fill('验收长期算力包');
    await form.getByLabel('售价（元）', { exact: true }).fill('59.00');
    await form.getByLabel('转写分钟数', { exact: true }).fill('90');
    await form.getByLabel('商品说明', { exact: true }).fill('购买后长期有效，所有成员共享');
    await form.getByLabel('发布原因', { exact: true }).fill('隔离验收发布');
    await checkLayout('admin-product');
    await form.getByRole('button', { name: '发布售价版本' }).click();
    await page.getByRole('status').waitFor();
    const published = requests.findLast(r => r.path.endsWith('/products')).input;
    assert.equal(published.durationDays, null); assert.equal(published.durationMonths, null);
    assert.equal(published.billingEntitlements.quotas.interview_seconds, 5400);
    const conversion = page.getByRole('region', { name: '历史付费额度转换' });
    await conversion.getByLabel('增购订单 ID').fill('legacy-order');
    await conversion.getByRole('button', { name: '预览剩余额度' }).click();
    await conversion.getByText('可转换为长期有效', { exact: true }).waitFor();
    await conversion.getByLabel('转换原因').fill('根据原购买记录确认调整');
    await conversion.getByRole('button', { name: '确认转换 1 个批次' }).click();
    await conversion.getByText('已转换 1 个额度批次').waitFor();
    assert.equal(requests.findLast(r => r.path.endsWith('/credit-conversions')).input.expectedDigest, 'isolated-digest');
    await page.getByRole('tab', { name: '算力与试用规则', exact: true }).click();
    await page.getByLabel('长期有效额度').check();
    await page.getByLabel(/^发放企业/).selectOption('fixture-org');
    await page.getByLabel('发放数量（点）', { exact: true }).fill('88');
    await page.getByLabel('发放原因', { exact: true }).fill('隔离补发长期额度');
    assert.equal(await page.getByLabel('到期时间', { exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '发放额度', exact: true }).click();
    await page.getByText('企业额度已发放', { exact: true }).waitFor();
    assert.equal(requests.findLast(r => r.path.endsWith('/quota-grants')).input.expiresAt, null);
    await checkLayout('admin-billing');
    await page.goto(origin + '/enterprise/billing');
    await page.getByText('额度来源与有效期', { exact: true }).click();
    await page.getByRole('cell', { name: '标准算力包', exact: true }).waitFor();
    await checkLayout('balance-sources');
    results.push({ width, tabs: true, minuteDisplay: true, capacityGuard: true, expiredServiceGuard: true, permanentPublish: true, auditedConversion: true, permanentGrant: true, noOverflow: true });
    await page.close();
  }
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
  await writeFile(join(reportDir, 'results.json'), JSON.stringify({ results, errors, unexpected, mutationCount: requests.length }, null, 2));
  console.log(JSON.stringify({ results, errors, unexpected, mutationCount: requests.length }, null, 2));
  }
} finally {
  await browser?.close();
  await server.close();
}
