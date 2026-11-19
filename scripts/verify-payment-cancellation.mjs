import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const requireWeb = createRequire(join(root, 'web/package.json'))
const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href)
const { default: vue } = await import(pathToFileURL(requireWeb.resolve('@vitejs/plugin-vue')).href)
const playwright = process.env.PLAYWRIGHT_MODULE_PATH || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')
const { chromium } = await import(pathToFileURL(playwright).href)
const initialOrder = {
  id: 'fixture-order', outTradeNo: 'isolated-cancellation-fixture', organizationId: 'fixture-org',
  name: '取消流程验收套餐', amountFen: 25800, currency: 'CNY', durationDays: 30,
  method: 'alipay', mode: 'qrcode', status: 'pending', payURL: 'https://pay.example.invalid/fixture',
  qrCode: 'isolated-fixture-no-real-payment', createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1800000).toISOString(), paidAt: null, refundedAt: null, reviewReason: null,
}
let order = { ...initialOrder }, confirmClose = false, localOnly = false
const report = {
  products: [{ id: 'fixture-product', planVersionId: 'fixture-plan', name: '取消流程验收套餐', amountFen: 25800, currency: 'CNY', durationDays: 30, active: true, seatLimit: 20, jobLimit: 200 }],
  providers: [{ id: 'fixture-channel', name: '测试支付宝', kind: 'alipay' }], orders: [order], pendingOrder: order,
  organization: { id: 'fixture-org', name: '隔离验收企业', entitlementVersion: 1, expiresAt: null, seatUsage: 2, jobUsage: 3 }, canPurchase: true,
}
const requests = [], errors = [], unexpected = []
const preview = '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/__qa-entry.js"></script></html>'
const entry = `
import {createApp,h} from 'vue';
import {createRouter,createWebHistory,RouterView} from 'vue-router';
import Page from '/src/modules/platform/pages/EnterprisePaymentsPage.vue';
import {authSession} from '/src/modules/auth/session.ts';
import '/src/shared/styles/base.css';import '/src/shared/styles/components.css';
authSession.user={id:'fixture-user',name:'隔离测试',workspaceId:'fixture-org'};
const router=createRouter({history:createWebHistory(),routes:[{path:'/enterprise/payments',name:'enterprise-payments',component:Page},{path:'/enterprise/payments/:id',name:'enterprise-payment-order',component:Page},{path:'/workspaces',component:{template:'<main>测试返回入口</main>'}}]});
createApp({render:()=>h(RouterView)}).use(router).mount('#app');`
const server = await createServer({ root: join(root, 'web'), configFile: false, optimizeDeps: { include: ['vue', 'vue-router'] }, plugins: [{ name: 'isolated-cancellation-fixtures',
resolveId(id) { if (id === '/__qa-entry.js') return '\0payment-cancellation-entry' },
load(id) { if (id === '\0payment-cancellation-entry') return entry },
configureServer(vite) {
  vite.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (data, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ ok: status === 200, data })) }
    if (url.pathname.startsWith('/enterprise/payments')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(await vite.transformIndexHtml(url.pathname, preview)) }
    if (!url.pathname.startsWith('/api/')) return next()
    requests.push({ method: req.method, path: url.pathname })
    if (url.pathname === '/api/v1/auth/csrf') return send({ token: 'fixture-csrf' })
    const base = '/api/v1/payments/workspaces/fixture-org'
    if (req.method === 'GET' && url.pathname === base) return send(report)
    if (req.method === 'GET' && url.pathname === base + '/orders/fixture-order') return send(order)
    if (req.method === 'POST' && url.pathname === base + '/orders/fixture-order/cancel') {
      if (order.creationOutcome === 'not_created') {
        order = {...order,status:'cancelled',cancelRequestedAt:new Date().toISOString(),channelClosePending:false}
        report.orders = [order]; report.pendingOrder = null
        return send(order)
      }
      order = { ...order, cancelRequestedAt: new Date().toISOString(), cancellationMessage: '支付宝应用尚未上线，请联系平台管理员完成上线；系统会继续重试取消。', payURL: null, qrCode: null }
      report.orders = [order]; report.pendingOrder = order
      return send(order)
    }
    if (req.method === 'POST' && url.pathname === base + '/orders/fixture-order/verify') {
      if (confirmClose) { order = { ...order, status: 'cancelled', cancellationMessage: null, channelClosePending:localOnly }; report.orders = [order]; report.pendingOrder = null }
      return send(order)
    }
    unexpected.push({ method: req.method, path: url.pathname })
    return send({ message: '隔离验收禁止未定义请求' }, 501)
  })
} }, vue()], server: { host: '127.0.0.1', port: 0, proxy: {} } })
let browser
try {
  await server.listen()
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'zh-CN' })
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('dialog', dialog => dialog.accept())
  const output = join(root, 'reports/payments/cancellation-isolated')
  await mkdir(output, { recursive: true })
  for (const width of [390, 1440]) {
    order = { ...initialOrder }; report.orders = [order]; report.pendingOrder = order; confirmClose = false; localOnly = false
    await page.setViewportSize({ width, height: 1000 })
    await page.goto(origin + '/enterprise/payments/fixture-order?workspace=fixture-org')
    await page.getByRole('img', { name: '订单付款二维码' }).waitFor().catch(async error => {
      console.error(JSON.stringify({ errors, unexpected, requests, page: await page.locator('body').innerText() }))
      throw error
    })
    await page.getByRole('button', { name: '取消订单', exact: true }).click()
    await page.locator('.order-card h2', { hasText: '取消待确认' }).waitFor()
    assert((await page.locator('.order-card').innerText()).includes('支付宝应用尚未上线'))
    assert.equal(await page.getByRole('img', { name: '订单付款二维码' }).count(), 0)
    assert.equal(await page.locator('.pay-link').count(), 0)
    assert.equal(await page.getByRole('button', { name: '取消订单', exact: true }).count(), 0)
    assert((await page.locator('.history').innerText()).includes('取消待确认'))
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({ path: join(output, `cancel-pending-${width}.png`), fullPage: true })
    order.expiresAt = new Date(Date.now() - 60000).toISOString()
    await page.getByRole('link', { name: '返回套餐列表', exact: true }).click()
    await page.getByRole('heading', { name: '企业订单取消待确认', exact: true }).waitFor()
    assert(await page.getByRole('button', { name: '创建订单并付款', exact: true }).isDisabled())
    await page.getByRole('link', { name: '查看取消进度', exact: true }).click()
    await page.locator('.order-card h2', { hasText: '取消待确认' }).waitFor()
    confirmClose = true
    await page.getByRole('button', { name: '查询支付结果', exact: true }).click()
    await page.locator('.order-card h2', { hasText: '已取消' }).waitFor()
    assert(!(await page.locator('.history').innerText()).includes('取消待确认'))
    await page.screenshot({ path: join(output, `cancel-confirmed-${width}.png`), fullPage: true })
    await page.getByRole('link', { name: '返回套餐列表', exact: true }).click()
    await page.locator('.checkout-card').waitFor()
    assert(!(await page.getByRole('button', { name: '创建订单并付款', exact: true }).isDisabled()))
    console.log(`${width}px：取消申请、付款入口隐藏、过期防重付、关单确认与重新购买入口通过`)

    order = {...initialOrder,status:'uncertain',payURL:null,qrCode:null,creationOutcome:'not_created',creationMessage:'订单创建失败：支付宝应用尚未上线。可直接取消此订单，完成应用上线后重新下单。'}
    report.orders = [order]; report.pendingOrder = order
    await page.goto(origin + '/enterprise/payments/fixture-order?workspace=fixture-org')
    await page.locator('.order-card h2', {hasText:'创建失败'}).waitFor()
    assert(!(await page.locator('.order-card').innerText()).includes('付款剩余时间'))
    await page.screenshot({path:join(output,`creation-failed-${width}.png`),fullPage:true})
    await page.getByRole('button',{name:'取消订单',exact:true}).click()
    await page.locator('.order-card h2',{hasText:'已取消'}).waitFor()
    await page.getByRole('link',{name:'返回套餐列表',exact:true}).click()
    assert(!(await page.getByRole('button',{name:'创建订单并付款',exact:true}).isDisabled()))

    localOnly = true; confirmClose = true
    order = {...initialOrder,status:'uncertain',payURL:null,qrCode:null,expiresAt:new Date(Date.now()-60000).toISOString(),cancelRequestedAt:new Date().toISOString(),cancellationMessage:'支付宝应用尚未上线，系统会继续重试取消。'}
    report.orders = [order]; report.pendingOrder = order
    await page.goto(origin + '/enterprise/payments/fixture-order?workspace=fixture-org')
    await page.getByRole('button',{name:'查询支付结果',exact:true}).click()
    await page.getByRole('heading',{name:'已取消（本地）',exact:true}).waitFor()
    assert((await page.locator('.order-card').innerText()).includes('渠道关单尚未确认'))
    assert.equal(await page.locator('.pay-link,img').count(),0)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await page.screenshot({path:join(output,`cancel-local-${width}.png`),fullPage:true})
    await page.getByRole('link',{name:'返回套餐列表',exact:true}).click()
    assert(!(await page.getByRole('button',{name:'创建订单并付款',exact:true}).isDisabled()))
    console.log(`${width}px：明确创建失败直接取消、历史空单本地作废、风险提示与重新下单入口通过`)
  }
  assert.equal(requests.filter(request => request.path.endsWith('/cancel')).length, 4)
  assert.deepEqual(unexpected, [])
  assert.deepEqual(errors, [])
  console.log('隔离浏览器验收通过；未使用实际登录态、密钥或真实支付订单。截图：' + output)
} finally {
  await browser?.close()
  await server.close()
}
