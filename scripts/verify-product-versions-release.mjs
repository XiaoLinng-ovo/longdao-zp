import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import '../apps/api/dist/src/env.js';
import { createDatabasePool, loadDatabaseConfig, inspectMigrations } from '../apps/api/dist/src/db/index.js';
import { PostgresSessionRepository } from '../apps/api/dist/src/auth/session-repository.js';

const root = resolve(import.meta.dirname, '..');
const reportDir = resolve(process.env.PRODUCT_RELEASE_DIR || join(root, 'tmp/releases/product-versions-20261112'));
const config = loadDatabaseConfig();
assert.equal(config.target, '127.0.0.1:5432/smartrecruit', '仅用于本机已确认的业务数据库');
const pool = createDatabasePool(config);
const checks = [];
const sessions = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function snapshot() {
  const product = (await pool.query('SELECT id,plan_version_id,name,amount_fen,currency,duration_days,duration_months,active,billing_kind,billing_entitlements,description,sort_order FROM payment_products ORDER BY id')).rows;
  const orders = (await pool.query('SELECT id,product_id,amount_fen,product_name,plan_version_id,duration_days,duration_months,billing_kind,billing_entitlements FROM payment_orders ORDER BY id')).rows;
  const grants = (await pool.query('SELECT id,organization_id,resource,total,remaining,valid_from,expires_at,revoked_at FROM billing_grants ORDER BY id')).rows;
  return { products: { count: product.length, digest: hash(product) }, orders: { count: orders.length, digest: hash(orders) }, grants: { count: grants.length, digest: hash(grants) } };
}
function run(executable, args, env = process.env) {
  return new Promise((ok, reject) => {
    const child = spawn(executable, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    child.once('error', () => reject(new Error('备份工具启动失败')));
    child.once('exit', code => code === 0 ? ok() : reject(new Error('备份工具执行失败，请检查数据库连接和工具版本')));
  });
}
async function check(name, task) {
  await task(); checks.push({ name, passed: true }); console.log('通过：' + name);
}
try {
  await mkdir(reportDir, { recursive: true });
  if (process.argv.includes('--backup')) {
    const credentials = config.connectionString ? new URL(config.connectionString) : undefined;
    const env = { ...process.env, PGHOST: credentials?.hostname || config.host, PGPORT: credentials?.port || String(config.port), PGDATABASE: credentials ? decodeURIComponent(credentials.pathname.slice(1)) : config.database, PGUSER: credentials ? decodeURIComponent(credentials.username) : config.user, PGPASSWORD: credentials ? decodeURIComponent(credentials.password) : config.password, PGCONNECT_TIMEOUT: '10' };
    await run('D:/software/pgsql/bin/pg_dump.exe', ['--format=custom', '--no-password', '--file=' + join(reportDir, 'smartrecruit.dump')], env);
    await run('D:/software/pgsql/bin/pg_restore.exe', ['--list', join(reportDir, 'smartrecruit.dump')]);
    await writeFile(join(reportDir, 'database-before.json'), JSON.stringify(await snapshot(), null, 2));
    console.log('数据库备份完成，备份目录可读取；已保存业务快照摘要。');
  } else {
    const api = 'http://127.0.0.1:3100';
    const web = 'http://127.0.0.1:5174';
    const admin = (await pool.query('SELECT id FROM users WHERE user_no=$1 AND is_active=true', [process.env.SYSTEM_ADMIN_USER_NO])).rows[0];
    const member = (await pool.query('SELECT id FROM users WHERE is_active=true AND user_no<>$1 ORDER BY created_at LIMIT 1', [process.env.SYSTEM_ADMIN_USER_NO])).rows[0];
    assert(admin && member, '缺少验收需要的启用账号');
    const repository = new PostgresSessionRepository(pool);
    async function session(user) {
      const result = await repository.createSession({ id: user.id, name: '发布验收', email: 'release-check@example.invalid', role: 'recruiter', departmentId: '' }, 10 * 60 * 1000, { userAgent: 'product-version-release-check' });
      sessions.push(result.session.sessionId);
      return result.token;
    }
    const token = await session(admin), memberToken = await session(member), csrf = randomUUID();
    const headers = auth => ({ cookie: `__Host-smartrecruit_session=${auth}; __Host-smartrecruit_csrf=${csrf}`, origin: web, 'x-csrf-token': csrf, 'content-type': 'application/json' });
    const request = (path, method = 'GET', input, auth = token, override = {}) => fetch(api + path, { method, headers: { ...headers(auth), ...override }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000) });
    await check('数据库迁移已全部应用', async () => { assert.equal((await inspectMigrations(pool, join(root, 'db/migrations'))).pending.length, 0); });
    await check('API 健康接口', async () => { assert.equal((await fetch(api + '/api/v1/health', { signal: AbortSignal.timeout(15000) })).status, 200); });
    await check('未登录不能访问商品后台', async () => { assert.equal((await fetch(api + '/api/v1/platform/payments')).status, 401); });
    await check('普通成员不能访问商品后台', async () => { assert.equal((await request('/api/v1/platform/payments', 'GET', undefined, memberToken)).status, 403); });
    let overview;
    await check('管理员可访问且 API 已支持商品版本', async () => {
      const response = await request('/api/v1/platform/payments'); assert.equal(response.status, 200);
      overview = (await response.json()).data; assert.equal(overview.productVersioning, true);
      assert.equal(new Set(overview.products.map(product => product.catalogId)).size, overview.products.length);
    });
    assert(overview.products.length > 0, '没有现有商品可做只读验收');
    const product = overview.products[0], historyPath = `/api/v1/platform/payments/products/${product.id}/history`;
    await check('正式商品历史接口可读取当前版本', async () => {
      const response = await request(historyPath); assert.equal(response.status, 200);
      const history = (await response.json()).data; assert.equal(history.currentVersionId, product.id); assert(history.versions.some(version => version.id === product.id));
    });
    await check('普通成员不能访问商品版本历史', async () => { assert.equal((await request(historyPath, 'GET', undefined, memberToken)).status, 403); });
    const revision = { planVersionId: product.planVersionId, name: product.name, amountFen: product.amountFen, durationDays: product.durationDays, durationMonths: product.durationMonths, billingKind: product.billingKind, billingEntitlements: product.billingEntitlements, allModules: product.allModules, description: product.description, sortOrder: product.sortOrder, expectedVersionId: product.id, requestId: randomUUID(), reason: '' };
    const revisionsPath = `/api/v1/platform/payments/products/${product.id}/revisions`;
    await check('修改接口明确提示缺少原因且不写商品', async () => {
      const response = await request(revisionsPath, 'POST', revision); assert.equal(response.status, 400);
      assert.match(JSON.stringify(await response.json()), /操作原因/);
    });
    await check('修改接口拒绝无效 CSRF', async () => { assert.equal((await request(revisionsPath, 'POST', revision, token, { 'x-csrf-token': 'invalid' })).status, 403); });
    await check('修改接口拒绝不可信来源', async () => { assert.equal((await request(revisionsPath, 'POST', revision, token, { origin: 'https://untrusted.example.invalid' })).status, 403); });
    await check('归并接口拒绝不完整提交且不改商品', async () => { const response = await request('/api/v1/platform/payments/products/merge', 'POST', { reason: '只读发布验收', versionIds: [], requestId: randomUUID() }); assert.equal(response.status, 400); });
    await check('升级前后商品、订单快照及额度保持一致', async () => { assert.deepEqual(await snapshot(), JSON.parse(await readFile(join(reportDir, 'database-before.json'), 'utf8'))); });
    await check('当前商品关联和在售约束一致', async () => {
      const result = await pool.query('SELECT count(*)::int AS invalid FROM payment_products p JOIN payment_catalog_products c ON c.id=p.catalog_id WHERE p.active AND (c.archived OR c.current_version_id IS DISTINCT FROM p.id)'); assert.equal(result.rows[0].invalid, 0);
    });
    if (process.argv.includes('--browser')) {
      const require = createRequire(import.meta.url);
      const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
      const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
      try {
        await check('真实页面可编辑、预览差异及查看历史，未提交商品修改', async () => {
          const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
          page.setDefaultTimeout(15000);
          const errors = [], writes = [];
          page.on('pageerror', error => errors.push(error.message));
          // Authentication is short-lived and stays in memory. Product writes are blocked during UI checks.
          await page.route('**/api/v1/**', async route => {
            const req = route.request(), path = new URL(req.url()).pathname;
            if (path.includes('/platform/payments/products') && !['GET','HEAD'].includes(req.method())) { writes.push(path); await route.abort(); return; }
            const h = { ...req.headers() }; delete h.cookie;
            h.cookie = `__Host-smartrecruit_session=${token}; __Host-smartrecruit_csrf=${csrf}`;
            const response = await route.fetch({ headers: h });
            await route.fulfill({ response });
          });
          await page.goto(web + '/platform/payments');
          await page.getByRole('heading', { name: '商品与定价', exact: true }).waitFor();
          const edit = page.getByRole('button', { name: '编辑并上架', exact: true }).first();
          await edit.waitFor(); await edit.click();
          await page.getByLabel('商品名称', { exact: true }).fill('发布验收：不提交');
          await page.getByLabel('发布原因', { exact: true }).fill('仅检查差异预览，不提交正式修改');
          await page.getByRole('button', { name: '预览修改并上架', exact: true }).click();
          const dialog = page.getByRole('dialog'); await dialog.waitFor();
          assert.match(await dialog.innerText(), /发布验收：不提交/);
          await page.screenshot({ path: join(reportDir, 'formal-version-diff.png'), fullPage: true });
          await dialog.getByRole('button', { name: '返回编辑', exact: true }).click();
          await page.getByRole('button', { name: '取消编辑', exact: true }).click();
          await page.getByRole('button', { name: '历史版本', exact: true }).first().click();
          await page.getByRole('dialog').waitFor();
          await page.screenshot({ path: join(reportDir, 'formal-version-history.png'), fullPage: true });
          assert.equal(await page.locator('vite-error-overlay').count(), 0);
          assert.deepEqual(errors, []); assert.deepEqual(writes, []);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
          await page.close();
        });
      } finally { await browser.close(); }
    }
    await writeFile(join(reportDir, 'verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, realProductWrites: false, realPaymentCalls: false }, null, 2));
    console.log(`正式验收完成：${checks.length} 项通过；未发布商品或调用支付。`);
  }
} finally {
  for (const id of sessions) await pool.query('DELETE FROM sessions WHERE id=$1', [id]);
  await pool.end();
}
