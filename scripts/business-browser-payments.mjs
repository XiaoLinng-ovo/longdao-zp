import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { browserAction } from './browser-action.mjs'

export function paymentFlows({ pool, instance, json, responseAfter, origin, boundary, boundaryHeaders = {}, activate }) {
  let provider, subscription, addon, paidSubscription, initialEntitlements, billOrder
  const enterprisePath = member => '/payments/workspaces/' + member.id
  const entitlement = async member => (await pool.query(`SELECT plan_version_id,paid_subscription_expires_at,service_status,trial_ends_at,
    entitlement_version,active_payment_order_id FROM public.organizations WHERE id=$1`, [member.id])).rows[0]
  const row = async id => (await pool.query('SELECT * FROM public.payment_orders WHERE id=$1', [id])).rows[0]
  const grants = async id => (await pool.query('SELECT resource,total,remaining,valid_from,expires_at,revoked_at FROM public.billing_grants WHERE order_id=$1 ORDER BY resource', [id])).rows
  async function adminModule(owner, module) {
    const page = owner.page; activate(page)
    await page.goto(origin + '/platform/payments')
    await page.locator(`[role="tab"][data-module="${module}"]`).click()
    return page
  }
  async function prompted(page, method, path, button, expected = 200) {
    page.once('dialog', dialog => dialog.accept('本机隔离合成验收'))
    return responseAfter(page, method, path, () => button.click(), expected)
  }
  async function publish(page, kind, name, options = {}) {
    const form = page.locator('.product-form')
    await form.getByLabel('商品类型').selectOption(kind)
    await form.getByLabel('商品名称', { exact: true }).fill(name)
    await form.getByLabel('售价（元）', { exact: true }).fill('12.34')
    if (kind === 'subscription') {
      if (options.months) {
        await form.getByLabel(/^计费期限/).selectOption('months')
        await form.getByLabel('有效月数', { exact: true }).fill(String(options.months))
      } else await form.getByLabel('有效天数', { exact: true }).fill(String(options.days ?? 30))
      await form.getByLabel('席位数', { exact: true }).fill('5')
      await form.getByLabel('岗位数', { exact: true }).fill('10')
      await form.getByLabel('额度发放').selectOption(options.monthly ? 'monthly' : 'once')
      if (options.monthly) await form.getByLabel('未用额度结转至商品期限结束', { exact: true }).setChecked(options.rollover ?? false)
    } else await form.getByLabel('长期有效（一次到账）', { exact: true }).check()
    for (const [label, value] of [['AI 点数', '100'], ['转写分钟数', '5'], ['OCR 页数', '20'], ['发布原因', '合成商品浏览器验收']]) await form.getByLabel(label, { exact: true }).fill(value)
    const created = await responseAfter(page, 'POST', '/platform/payments/products', () => form.getByRole('button', { name: '创建新商品', exact: true }).click(), 201)
    assert.equal(created.active, false, '新建商品必须先审核再上架')
    await prompted(page, 'PATCH', '/platform/payments/products/' + created.id, page.locator('tbody tr').filter({ hasText: name }).getByRole('button', { name: '上架', exact: true }))
    return created
  }
  async function createOrder(member, product) {
    const page = member.page; activate(page)
    await page.goto(origin + '/enterprise/payments?workspace=' + member.id)
    await page.getByRole('button', { name: product.billingKind === 'addon' ? '算力充值' : '服务订阅', exact: true }).click()
    await page.locator('.products button').filter({ hasText: product.name }).click()
    await page.getByLabel('收款渠道').selectOption(provider.id)
    const request = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1' + enterprisePath(member) + '/orders')
    const [sent, order] = await Promise.all([request,
      responseAfter(page, 'POST', enterprisePath(member) + '/orders', () => page.getByRole('button', { name: '创建订单并付款', exact: true }).click(), 201)])
    await page.waitForURL(new RegExp('/enterprise/payments/' + order.id))
    const link = page.getByRole('link', { name: '前往支付平台付款', exact: true })
    await link.waitFor()
    assert.equal(sent.postDataJSON().mode, 'redirect'); assert.equal(order.mode, 'redirect')
    assert.equal(await page.getByRole('img', { name: '订单付款二维码', exact: true }).count(), 0)
    assert.equal(boundary.requests.filter(item => item.outTradeNo === order.outTradeNo).length, 0, '本地签名建单不能伪造渠道交易')
    assert.equal(await link.getAttribute('href'), order.payURL)
    const orderPage = page.url()
    await link.click()
    await page.locator('#synthetic-payment-handoff').waitFor()
    const handoffs = boundary.requests.filter(item => item.method === 'alipay.trade.page.pay' && item.outTradeNo === order.outTradeNo)
    assert.equal(handoffs.length, 1); assert.equal(handoffs[0].verifiedMerchantSignature, true)
    assert.ok(Math.abs(Date.parse(handoffs[0].expiresAt) - Date.parse(order.expiresAt)) < 1000)
    await page.goto(orderPage)
    await page.getByRole('link', { name: '前往支付平台付款', exact: true }).waitFor()
    assert.equal(order.status, 'pending'); assert.equal(order.amountFen, product.amountFen)
    return { ...order, input: sent.postDataJSON(), key: sent.headers()['idempotency-key'] }
  }
  async function notification(order, raw = boundary.notification(order.outTradeNo)) {
    const response = await fetch(origin + '/api/v1/payments/webhook/' + provider.id, { method: 'POST',
      headers: { ...boundaryHeaders, 'content-type': 'application/x-www-form-urlencoded' }, body: raw, signal: AbortSignal.timeout(10000) })
    return { status: response.status, text: await response.text() }
  }
  async function configure(owner, member) {
    const page = await adminModule(owner, 'products')
    subscription = await publish(page, 'subscription', '本机合成订阅')
    addon = await publish(page, 'addon', '本机合成长效算力')
    await page.getByRole('tab', { name: '收款渠道', exact: true }).click()
    await page.getByText('新增收款渠道', { exact: true }).click()
    const form = page.locator('.channel-form')
    await form.getByLabel('渠道名称', { exact: true }).fill('本机合成支付宝')
    await form.getByLabel('接口类型').selectOption('alipay')
    await form.getByLabel('支付宝环境').selectOption('production')
    for (const label of ['应用 RSA 私钥（PEM）', '支付宝公钥（PEM）']) await form.getByRole('button', { name: '显示' + label, exact: true }).click()
    for (const [label, value] of [['应用 App ID', boundary.config.appId], ['收款方 seller_id', boundary.config.sellerId], ['应用 RSA 私钥（PEM）', boundary.config.privateKey], ['支付宝公钥（PEM）', boundary.config.publicKey], ['操作原因', '仅本机合成支付验收']]) await form.getByLabel(label, { exact: true }).fill(value)
    provider = await responseAfter(page, 'POST', '/platform/payments/providers', () => form.getByRole('button', { name: '加密保存渠道', exact: true }).click(), 201)
    assert.equal(provider.enabled, false)
    const stored = (await pool.query('SELECT config_ciphertext FROM public.payment_providers WHERE id=$1', [provider.id])).rows[0].config_ciphertext
    assert.ok(!JSON.stringify(stored).includes('PRIVATE KEY'))
    const overview = (await json(page, 'GET', '/platform/payments')).body.data
    assert.ok(!JSON.stringify(overview).includes(boundary.config.privateKey))
    await prompted(page, 'PATCH', '/platform/payments/providers/' + provider.id, page.locator('.channels article').filter({ hasText: '本机合成支付宝' }).getByRole('button', { name: '启用', exact: true }))
    assert.equal((await json(member.page, 'POST', '/platform/payments/products', { name: '无权发布' })).status, 403)
    assert.equal((await json(member.page, 'PATCH', '/platform/payments/providers/' + provider.id, { enabled: false, reason: '无权停用' })).status, 403)
    return { providerId: provider.id, productIds: [subscription.id, addon.id], encryptionAndNoSecretEcho: true, externalPayment: false }
  }
  async function subscribe(owner, member) {
    initialEntitlements = await entitlement(member)
    const isolatedBefore = await entitlement(owner)
    const order = await createOrder(member, subscription); paidSubscription = order
    const replay = await json(member.page, 'POST', enterprisePath(member) + '/orders', order.input, { 'Idempotency-Key': order.key })
    assert.equal(replay.status, 201); assert.equal(replay.body.data.id, order.id)
    assert.equal(boundary.requests.filter(item => item.method === 'alipay.trade.page.pay' && item.outTradeNo === order.outTradeNo).length, 1)
    assert.equal(boundary.requests.filter(item => item.method === 'alipay.trade.precreate').length, 0)
    const otherCompany = enterprisePath(owner) + '/orders/' + order.id
    for (const [method, path, body] of [['GET', otherCompany, undefined], ['POST', otherCompany + '/cancel', {}]]) assert.equal((await json(owner.page, method, path, body)).status, 404)
    assert.equal((await json(member.page, 'POST', '/platform/payments/orders/' + order.id + '/refund', { reason: '普通用户无权退款' })).status, 403)
    boundary.markPaid(order.outTradeNo)
    const raw = boundary.notification(order.outTradeNo)
    assert.equal((await notification(order, raw.replace('total_amount=12.34', 'total_amount=22.34'))).status, 400)
    assert.equal((await notification(order, boundary.notification(order.outTradeNo, { total_amount: '22.34' }))).status, 409)
    assert.equal((await row(order.id)).paid_at, null); assert.equal((await grants(order.id)).length, 0)
    const callbacks = await Promise.all(Array.from({ length: 8 }, () => notification(order)))
    assert.ok(callbacks.every(item => item.status === 200 && item.text === 'success'))
    assert.equal((await row(order.id)).status, 'fulfilled')
    assert.equal((await pool.query('SELECT count(*)::int n FROM public.payment_events WHERE order_id=$1', [order.id])).rows[0].n, 1)
    const issued = await grants(order.id)
    assert.deepEqual(issued.map(item => [item.resource, Number(item.total), Number(item.remaining)]), [['ai_points', 100, 100], ['interview_seconds', 300, 300], ['ocr_pages', 20, 20]])
    const after = await entitlement(member)
    assert.equal(after.entitlement_version, initialEntitlements.entitlement_version + 1)
    assert.equal(after.active_payment_order_id, order.id)
    assert.deepEqual(await entitlement(owner), isolatedBefore)
    await member.page.reload()
    await member.page.getByText('已确认到账，企业套餐已经开通。', { exact: true }).waitFor()
    await member.page.screenshot({ path: join(instance.directory, 'subscription-fulfilled.png'), fullPage: true })
    return { orderId: order.id, realBrowserRedirectHandoff: true, merchantSignatureAndAbsoluteExpiryVerified: true, requestReplaySameOrder: true, invalidSignatureAndWrongAmountRejected: true, concurrentCallbacks: 8, paymentEvents: 1, grants: 3, otherCompanyUnchanged: true }
  }
  async function cancellation(owner, member) {
    const before = await entitlement(member), order = await createOrder(member, subscription)
    const duplicate = await json(member.page, 'POST', enterprisePath(member) + '/orders', order.input, { 'Idempotency-Key': 'another-' + order.key })
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'PAYMENT_ORDER_ALREADY_PENDING')
    const cancelled = await prompted(member.page, 'POST', enterprisePath(member) + '/orders/' + order.id + '/cancel', member.page.getByRole('button', { name: '取消订单', exact: true }))
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.channelClosePending, false)
    assert.equal((await json(member.page, 'POST', enterprisePath(member) + '/orders/' + order.id + '/cancel', {})).body.data.status, 'cancelled')
    assert.equal(boundary.requests.filter(item => item.method === 'alipay.trade.close' && item.outTradeNo === order.outTradeNo).length, 1)
    assert.equal((await grants(order.id)).length, 0)
    assert.deepEqual(await entitlement(member), before)
    return { orderId: order.id, duplicatePendingRejected: true, channelCloseCount: 1, repeatedCancelNoExtraCall: true, entitlementUnchanged: true }
  }
  async function addonAndRecovery(owner, member) {
    const before = await entitlement(member), order = await createOrder(member, addon)
    boundary.markPaid(order.outTradeNo)
    const settled = await responseAfter(member.page, 'POST', enterprisePath(member) + '/orders/' + order.id + '/verify', () => member.page.getByRole('button', { name: '查询支付结果', exact: true }).click())
    assert.equal(settled.status, 'fulfilled')
    await member.page.getByText('已确认到账，算力额度已发放至企业共享余额。', { exact: true }).waitFor()
    const issued = await grants(order.id)
    assert.equal(issued.length, 3); assert.ok(issued.every(item => item.expires_at === null && item.revoked_at === null))
    assert.deepEqual(await entitlement(member), before, '增购包不能改变订阅和席位')
    boundary.deferRefund(order.outTradeNo)
    const page = await adminModule(owner, 'orders')
    const pending = await prompted(page, 'POST', '/platform/payments/orders/' + order.id + '/refund', page.locator('tbody tr').filter({ hasText: order.outTradeNo }).getByRole('button', { name: '全额退款', exact: true }))
    assert.equal(pending.status, 'refund_pending')
    const refund = await row(order.id)
    const duplicate = await json(page, 'POST', '/platform/payments/orders/' + order.id + '/refund', { reason: '重复退款必须拒绝' })
    assert.equal(duplicate.status, 409); assert.equal(duplicate.body.error.code, 'REFUND_PENDING')
    assert.ok((await grants(order.id)).every(item => item.revoked_at !== null))
    boundary.confirmRefund(order.outTradeNo, refund.refund_id)
    // Real background cadence and elapsed time: do not mutate dates or run reconcile manually.
    const started = Date.now(), deadline = started + 130000
    while ((await row(order.id)).status !== 'refunded') {
      assert.ok(Date.now() < deadline, '真实60秒后台支付核对未恢复未知退款')
      await delay(500)
    }
    const recovered = await row(order.id)
    assert.equal(recovered.refund_id, refund.refund_id)
    assert.equal(boundary.requests.filter(item => item.method === 'alipay.trade.refund' && item.outTradeNo === order.outTradeNo).length, 1)
    assert.ok(boundary.requests.some(item => item.method === 'alipay.trade.fastpay.refund.query' && item.outTradeNo === order.outTradeNo && item.refundId === refund.refund_id))
    assert.deepEqual(await entitlement(member), before)
    await page.reload()
    await page.getByRole('tab', { name: '最新订单', exact: true }).click()
    await page.locator('tbody tr').filter({ hasText: order.outTradeNo }).getByText('已退款', { exact: true }).waitFor()
    await page.screenshot({ path: join(instance.directory, 'refund-background-recovered.png'), fullPage: true })
    return { orderId: order.id, permanentGrants: 3, duplicateRefundRejected: true, originalRefundIdPreserved: true, backgroundWaitMs: Date.now() - started, realBackgroundIntervalMs: 60000, manualReconcileInvoked: false, subscriptionUnchanged: true }
  }
  async function subscriptionRefund(owner, member) {
    const order = paidSubscription, page = await adminModule(owner, 'orders')
    const refunded = await prompted(page, 'POST', '/platform/payments/orders/' + order.id + '/refund', page.locator('tbody tr').filter({ hasText: order.outTradeNo }).getByRole('button', { name: '全额退款', exact: true }))
    assert.equal(refunded.status, 'refunded')
    const after = await entitlement(member)
    assert.deepEqual({ ...after, entitlement_version: initialEntitlements.entitlement_version }, initialEntitlements)
    assert.equal(after.entitlement_version, initialEntitlements.entitlement_version + 2)
    assert.ok((await grants(order.id)).every(item => item.revoked_at !== null))
    const repeat = await json(page, 'POST', '/platform/payments/orders/' + order.id + '/refund', { reason: '已退款重复请求不应再退款' })
    assert.equal(repeat.status, 200); assert.equal(repeat.body.data.status, 'refunded')
    assert.equal(boundary.requests.filter(item => item.method === 'alipay.trade.refund' && item.outTradeNo === order.outTradeNo).length, 1)
    assert.deepEqual(boundary.failures, [])
    return { orderId: order.id, previousSubscriptionRestored: true, grantsRevoked: true, repeatedRefundNoExtraCall: true }
  }
  async function revision(page, current, changes, restore = false) {
    const form = page.locator('.product-form')
    if (!restore) await page.locator('tbody tr').filter({ hasText: current.name }).getByRole('button', { name: '编辑并上架', exact: true }).click()
    for (const [label, value] of Object.entries(changes)) await form.getByLabel(label, { exact: true }).fill(String(value))
    await form.getByLabel('发布原因', { exact: true }).fill('合成商品版本兼容验收')
    await form.getByRole('button', { name: '预览修改并上架', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '确认修改并上架', exact: true })
    await dialog.waitFor()
    const path = '/platform/payments/products/' + current.id + '/revisions'
    const request = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1' + path)
    const [sent, result] = await Promise.all([request, responseAfter(page, 'POST', path, () => dialog.getByRole('button', { name: '确认修改并上架', exact: true }).click(), 201)])
    await dialog.waitFor({ state: 'hidden' })
    return { result, input: sent.postDataJSON(), path }
  }
  async function pay(order, overrides) {
    boundary.markPaid(order.outTradeNo)
    assert.deepEqual(await notification(order, boundary.notification(order.outTradeNo, overrides)), { status: 200, text: 'success' })
    assert.equal((await row(order.id)).status, 'fulfilled')
  }
  async function versionAndRenewal(owner, member) {
    const otherBefore = await entitlement(owner), original = subscription
    const pending = await createOrder(member, original), snapshot = await row(pending.id)
    const page = await adminModule(owner, 'products')
    const edit = await revision(page, original, { '售价（元）': '23.45', '有效天数': '45', '商品说明': '只调整售价与期限，不改变权益' })
    subscription = edit.result
    assert.equal(subscription.catalogId, original.catalogId); assert.equal(subscription.versionNumber, 2)
    assert.equal(subscription.amountFen, 2345); assert.equal(subscription.durationDays, 45)
    assert.deepEqual(await row(pending.id), snapshot, '商品改版不能改写待付订单快照')
    const replay = await json(page, 'POST', edit.path, edit.input)
    assert.equal(replay.status, 201); assert.equal(replay.body.data.id, subscription.id)
    const conflict = await json(page, 'POST', edit.path, { ...edit.input, amountFen: 2346 })
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT')
    const stale = await json(page, 'POST', edit.path, { ...edit.input, requestId: randomUUID() })
    assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'VERSION_CONFLICT')
    assert.equal((await json(member.page, 'POST', edit.path, edit.input)).status, 403)
    const yesterday = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10)
    await pay(pending, { gmt_payment: yesterday + ' 12:00:00' })
    billOrder = { ...pending, billDate: yesterday }
    const oldRights = await entitlement(member)
    assert.equal(oldRights.plan_version_id, snapshot.plan_version_id)
    assert.equal((await row(pending.id)).amount_fen, 1234)
    const issuedOld = await grants(pending.id)
    assert.equal(issuedOld.length, 3)
    const renewed = await createOrder(member, subscription)
    await pay(renewed)
    const renewedRights = await entitlement(member), renewedGrants = await grants(renewed.id)
    assert.equal(renewedRights.paid_subscription_expires_at.getTime() - oldRights.paid_subscription_expires_at.getTime(), 45 * 86400000)
    assert.equal(renewedRights.entitlement_version, oldRights.entitlement_version + 1)
    assert.equal(renewedRights.active_payment_order_id, renewed.id)
    assert.equal(renewedGrants.length, 3)
    assert.ok(renewedGrants.every(g => g.valid_from.getTime() === oldRights.paid_subscription_expires_at.getTime() && g.expires_at.getTime() === renewedRights.paid_subscription_expires_at.getTime()))
    assert.deepEqual(await grants(pending.id), issuedOld)
    await adminModule(owner, 'products')
    const changed = await revision(page, subscription, { '席位数': '6' })
    subscription = changed.result
    const switched = await createOrder(member, subscription), beforePay = Date.now()
    await pay(switched)
    const changedRights = await entitlement(member), end = changedRights.paid_subscription_expires_at.getTime()
    assert.ok(end >= beforePay + 45 * 86400000 && end <= Date.now() + 45 * 86400000)
    assert.ok(end < renewedRights.paid_subscription_expires_at.getTime(), '权益变化必须从本次开通起算，不能错误续加旧期限')
    assert.deepEqual(await grants(renewed.id), renewedGrants)
    assert.deepEqual(await entitlement(owner), otherBefore)
    await member.page.reload()
    await member.page.getByText('已确认到账，企业套餐已经开通。', { exact: true }).waitFor()
    await member.page.screenshot({ path: join(instance.directory, 'subscription-version-renewal.png'), fullPage: true })
    return { oldOrderId: pending.id, renewalOrderId: renewed.id, changedRightsOrderId: switched.id, immutableOrderSnapshot: true,
      versionReplaySameId: true, conflictingReplayRejected: true, staleVersionRejected: true, renewalDaysAdded: 45, changedRightsStartNow: true, otherCompanyUnchanged: true }
  }
  async function catalogRecovery(owner, member) {
    const rights = await entitlement(member), beforeOrders = (await pool.query('SELECT * FROM public.payment_orders ORDER BY id')).rows
    const beforeGrants = (await pool.query('SELECT * FROM public.billing_grants WHERE order_id IS NOT NULL ORDER BY id')).rows
    const page = await adminModule(owner, 'products')
    const current = subscription
    await page.locator('tbody tr').filter({ hasText: current.name }).getByRole('button', { name: '历史版本', exact: true }).click()
    const history = page.getByRole('dialog', { name: '商品历史版本', exact: true })
    await history.locator('.product-history-row').nth(2).waitFor()
    assert.equal(await history.locator('.product-history-row').count(), 3)
    await history.locator('.product-history-row').filter({ hasText: '第 1 版' }).getByRole('button', { name: '以此版本恢复', exact: true }).click()
    const restored = await revision(page, current, {}, true)
    subscription = restored.result
    assert.equal(subscription.versionNumber, 4); assert.equal(subscription.amountFen, 1234)
    assert.equal(subscription.durationDays, 30); assert.equal(subscription.seatLimit, 5)
    const historicalToggle = await json(page, 'PATCH', '/platform/payments/products/' + current.id, { active: true, reason: '历史版本不能直接上架' })
    assert.equal(historicalToggle.status, 409)
    const currentRow = page.locator('tbody tr').filter({ hasText: subscription.name })
    await currentRow.getByText('更多操作', { exact: true }).click()
    await currentRow.getByRole('button', { name: '复制为新商品', exact: true }).click()
    const form = page.locator('.product-form')
    await form.getByLabel('商品名称', { exact: true }).fill('本机合成归并副本')
    await form.getByLabel('发布原因', { exact: true }).fill('合成复制和归并验收')
    const copy = await responseAfter(page, 'POST', '/platform/payments/products', () => form.getByRole('button', { name: '创建新商品', exact: true }).click(), 201)
    assert.notEqual(copy.catalogId, subscription.catalogId); assert.equal(copy.active, false)
    for (const product of [subscription, copy]) await page.getByLabel('选择归并 ' + product.name, { exact: true }).check()
    await page.getByRole('button', { name: '归并所选商品', exact: true }).click()
    const merge = page.getByRole('dialog', { name: '归并商品', exact: true })
    await merge.locator('input[type=radio][value="' + subscription.id + '"]').check()
    await merge.getByLabel('归并后上架所选版本', { exact: true }).check()
    await merge.getByLabel('归并原因', { exact: true }).fill('合成归并保留原商品与所有订单')
    const path = '/platform/payments/products/merge'
    const request = page.waitForRequest(req => req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1' + path)
    const [sent, merged] = await Promise.all([request, responseAfter(page, 'POST', path, () => merge.getByRole('button', { name: '确认归并', exact: true }).click())])
    const input = sent.postDataJSON()
    assert.equal(merged.id, subscription.id); assert.equal(merged.active, true)
    assert.equal((await json(page, 'POST', path, input)).body.data.id, merged.id)
    assert.equal((await json(member.page, 'POST', path, input)).status, 403)
    const versions = (await json(page, 'GET', '/platform/payments/products/' + merged.id + '/history')).body.data
    assert.equal(versions.versions.length, 5); assert.equal(versions.currentVersionId, merged.id)
    assert.equal(versions.versions.filter(v => v.active).length, 1)
    assert.deepEqual((await pool.query('SELECT * FROM public.payment_orders ORDER BY id')).rows, beforeOrders)
    assert.deepEqual((await pool.query('SELECT * FROM public.billing_grants WHERE order_id IS NOT NULL ORDER BY id')).rows, beforeGrants)
    assert.deepEqual(await entitlement(member), rights)
    await merge.waitFor({ state: 'hidden' })
    await page.locator('tbody tr').filter({ hasText: subscription.name }).getByRole('button', { name: '历史版本', exact: true }).click()
    await page.getByRole('dialog', { name: '商品历史版本', exact: true }).locator('.product-history-row').nth(4).waitFor()
    await page.screenshot({ path: join(instance.directory, 'product-restored-and-merged.png'), fullPage: true })
    return { restoredAsNewVersion: true, immutableHistoricalVersion: true, copyIndependentCatalog: true, mergedVersions: 5, replaySameId: true, ordersAndGrantsUnchanged: true }
  }
  async function billReconciliation(owner, member) {
    const rights = await entitlement(member), beforeOrders = (await pool.query('SELECT * FROM public.payment_orders ORDER BY id')).rows
    const beforeGrants = (await pool.query('SELECT * FROM public.billing_grants WHERE order_id IS NOT NULL ORDER BY id')).rows
    const page = await adminModule(owner, 'reconciliation'), date = billOrder.billDate, order = await row(billOrder.id)
    const entry = { outTradeNo: order.out_trade_no, transactionId: order.transaction_id, type: 'payment', amountFen: order.amount_fen }
    const panel = page.locator('.bill-panel')
    await panel.getByLabel(/^支付宝正式渠道/).selectOption(provider.id)
    await panel.getByLabel('账单日期（北京时间）', { exact: true }).fill(date)
    await panel.getByLabel('核对原因', { exact: true }).fill('合成账单ZIP真实解析与差异核对')
    const input = { providerId: provider.id, billDate: date, reason: '普通用户无权核对账单' }
    assert.equal((await json(member.page, 'GET', '/platform/payments/bills')).status, 403)
    assert.equal((await json(member.page, 'POST', '/platform/payments/bills', input)).status, 403)
    const auditCount = async () => (await pool.query("SELECT count(*)::int n FROM public.platform_audit_logs WHERE action='payment.bill.reconcile'")).rows[0].n
    const initialAudit = await auditCount()
    const run = async () => {
      const reports = await responseAfter(page, 'POST', '/platform/payments/bills', () => panel.getByRole('button', { name: '下载账单并对账', exact: true }).click())
      return reports.find(r => r.providerId === provider.id && r.billDate === date)
    }
    boundary.setBill(date, [entry])
    const good = await run()
    assert.equal(good.status, 'succeeded'); assert.equal(good.entryCount, 1); assert.equal(good.differenceCount, 0)
    assert.match(good.fileSha256, /^[a-f0-9]{64}$/)
    await panel.locator('article').filter({ hasText: date }).filter({ hasText: '一致' }).waitFor()
    await page.screenshot({ path: join(instance.directory, 'bill-reconciled.png'), fullPage: true })
    const refundEntry = { ...entry, type: 'refund', refundId: 'synthetic-unconfirmed-refund' }
    boundary.setBill(date, [{ ...entry, amountFen: entry.amountFen + 1 }, refundEntry,
      { ...entry, outTradeNo: 'synthetic-bill-only' }])
    const differences = await run()
    assert.equal(differences.status, 'differences')
    assert.deepEqual(differences.differences.map(d => d.type).sort(), ['amount_mismatch', 'bill_only', 'refund_not_recorded'])
    const article = panel.locator('article').filter({ hasText: date })
    assert.equal(await article.locator('details').getAttribute('open'), '', '存在差异时明细应默认展开')
    await article.getByText('金额不符', { exact: true }).waitFor()
    await article.getByText('本地未确认退款', { exact: true }).waitFor()
    await page.screenshot({ path: join(instance.directory, 'bill-differences.png'), fullPage: true })
    boundary.setBill(date, [])
    const missing = await run()
    assert.equal(missing.status, 'differences'); assert.deepEqual(missing.differences.map(d => d.type), ['local_payment_only'])
    boundary.setInvalidBill(date)
    const invalid = await run()
    assert.equal(invalid.status, 'failed'); assert.equal(invalid.errorCode, 'PAYMENT_BILL_INVALID')
    assert.equal(invalid.fileSha256, null)
    boundary.setBill(date, [entry])
    const recovered = await run()
    assert.equal(recovered.status, 'succeeded'); assert.equal(recovered.fileSha256, good.fileSha256)
    assert.equal(recovered.attempts, good.attempts + 4)
    assert.equal(await auditCount(), initialAudit + 5)
    assert.deepEqual((await pool.query('SELECT * FROM public.payment_orders ORDER BY id')).rows, beforeOrders)
    assert.deepEqual((await pool.query('SELECT * FROM public.billing_grants WHERE order_id IS NOT NULL ORDER BY id')).rows, beforeGrants)
    assert.deepEqual(await entitlement(member), rights)
    assert.deepEqual(boundary.failures, [])
    return { billDate: date, signedExternalURL: true, actualZipDownloads: 5, succeededEntries: 1,
      differenceTypes: ['amount_mismatch', 'bill_only', 'refund_not_recorded', 'local_payment_only'], corruptedZipRejected: true,
      manualAudits: 5, repairedByReDownload: true, ordersAndGrantsUnchanged: true }
  }
  async function setResumeRule(owner, enabled, rule) {
    const page = await adminModule(owner, 'billing'), panel = page.getByRole('region', { name: '算力计费规则', exact: true })
    await panel.getByLabel('启用额度扣减', { exact: true }).setChecked(enabled)
    await panel.getByLabel('简历分析计费开关', { exact: true }).setChecked(rule.enabled)
    await panel.getByLabel('简历分析额度类型', { exact: true }).selectOption(rule.resource)
    await panel.getByLabel('简历分析扣除数量', { exact: true }).fill(String(rule.resource === 'interview_seconds' ? rule.quantity / 60 : rule.quantity))
    await panel.getByLabel('简历分析单位大小', { exact: true }).fill(String(rule.unitSize))
    await panel.getByLabel('发布原因', { exact: true }).fill('隔离浏览器验证真实额度扣减')
    await responseAfter(page, 'POST', '/platform/payments/billing-policy', () => panel.getByRole('button', { name: '发布新规则', exact: true }).click(), 201)
  }
  async function consumedRefund(owner, member, consume) {
    const otherRights = await entitlement(owner)
    const original = (await pool.query('SELECT config FROM public.billing_policy_versions ORDER BY id DESC LIMIT 1')).rows[0].config
    await setResumeRule(owner, true, { enabled: true, resource: 'ai_points', quantity: 1, unitSize: 1 })
    try {
      const product = await publish(await adminModule(owner, 'products'), 'subscription', '合成已消费退款边界', { days: 1 })
      const order = await createOrder(member, product)
      await pay(order)
      const before = await grants(order.id)
      await consume()
      const consumed = await grants(order.id), credit = consumed.find(item => item.resource === 'ai_points')
      assert.equal(Number(credit.total) - Number(credit.remaining), 1, '必须由真实业务消耗本订单，而不是试用或历史额度')
      assert.ok(consumed.every(item => item.revoked_at === null))
      const allocations = (await pool.query(`SELECT t.id,t.state,t.units,t.allocations FROM public.billing_tasks t
        WHERE t.organization_id=$1 AND t.operation='resume_analysis' AND t.state='settled'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.allocations) a JOIN public.billing_grants g ON g.id=(a->>'id')::uuid WHERE g.order_id=$2)` , [member.id, order.id])).rows
      assert.equal(allocations.length, 1); assert.equal(Number(allocations[0].units), 1)
      const rights = await entitlement(member), snapshot = await row(order.id)
      const refundsBefore = boundary.requests.filter(item => item.method === 'alipay.trade.refund').length
      const page = await adminModule(owner, 'orders'), path = '/platform/payments/orders/' + order.id + '/refund'
      const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/v1' + path && result.request().method() === 'POST')
      page.once('dialog', dialog => dialog.accept('已消费订单必须拒绝直接退款'))
      const denied = await browserAction(response, () => page.locator('tbody tr').filter({ hasText: order.outTradeNo }).getByRole('button', { name: '全额退款', exact: true }).click())
      assert.equal(denied.status(), 409); assert.equal((await denied.json()).error.code, 'BILLING_QUOTA_ALREADY_USED')
      await page.getByRole('alert').filter({ hasText: '此订单额度已使用或已预占' }).waitFor()
      assert.deepEqual(await row(order.id), snapshot)
      assert.deepEqual(await grants(order.id), consumed)
      assert.deepEqual(await entitlement(member), rights)
      assert.deepEqual(await entitlement(owner), otherRights)
      assert.equal(boundary.requests.filter(item => item.method === 'alipay.trade.refund').length, refundsBefore)
      await page.screenshot({ path: join(instance.directory, 'consumed-refund-rejected.png'), fullPage: true })
      return { orderId: order.id, realBrowserImportAndWorkerConsumption: true, settledBillingTaskId: allocations[0].id,
        aiPointsBefore: Number(before.find(item => item.resource === 'ai_points').remaining), aiPointsAfter: Number(credit.remaining),
        refundStatus: 409, externalRefundCalls: 0, orderAndGrantsUnchanged: true, otherCompanyUnchanged: true }
    } finally { await setResumeRule(owner, original.enabled, original.rules.resume_analysis) }
  }
  async function calendarBoundaries(owner, member) {
    const otherRights = await entitlement(owner)
    const product = await publish(await adminModule(owner, 'products'), 'subscription', '合成自然月边界', { months: 1, monthly: true })
    const initial = await createOrder(member, product); await pay(initial)
    const cases = []
    for (const [start, end] of [['2027-01-31T04:05:06.789Z', '2027-02-28T04:05:06.789Z'], ['2028-01-31T04:05:06.789Z', '2028-02-29T04:05:06.789Z']]) {
      // Only seed the boundary date in this disposable company; payment and fulfilment remain real.
      await pool.query('UPDATE public.organizations SET paid_subscription_expires_at=$2 WHERE id=$1', [member.id, start])
      const before = await entitlement(member), order = await createOrder(member, product)
      await pay(order)
      const after = await entitlement(member), issued = await grants(order.id)
      assert.equal(after.paid_subscription_expires_at.toISOString(), end)
      assert.equal(after.entitlement_version, before.entitlement_version + 1)
      assert.equal(after.active_payment_order_id, order.id)
      assert.equal(issued.length, 3)
      assert.ok(issued.every(item => item.valid_from.toISOString() === start && item.expires_at.toISOString() === end && item.revoked_at === null))
      cases.push({ orderId: order.id, seededExpiry: start, actualExpiry: end, grants: issued.length })
    }
    const rollover = await publish(await adminModule(owner, 'products'), 'subscription', '合成三月额度结转', { months: 3, monthly: true, rollover: true })
    const order = await createOrder(member, rollover); await pay(order)
    const after = await entitlement(member), issued = await grants(order.id)
    assert.equal(issued.length, 9)
    assert.equal(new Set(issued.map(item => item.valid_from.toISOString())).size, 3)
    assert.ok(issued.every(item => item.expires_at.getTime() === after.paid_subscription_expires_at.getTime()))
    assert.equal(issued.filter(item => item.valid_from.getTime() <= Date.now()).length, 3, '未来月份额度不能提前可用')
    assert.deepEqual(await entitlement(owner), otherRights)
    await member.page.reload()
    await member.page.getByText('已确认到账，企业套餐已经开通。', { exact: true }).waitFor()
    await member.page.screenshot({ path: join(instance.directory, 'calendar-month-boundaries.png'), fullPage: true })
    return { cases, timezone: 'Asia/Shanghai', boundaryExpirySeededViaSql: true, systemClockChanged: false,
      realWallClockMonthElapsed: false, rolloverOrderId: order.id, monthlyGrants: 9, immediatelyAvailableGrants: 3, otherCompanyUnchanged: true }
  }
  async function sustainedAddon(member, outsider, rejectWrongAmount) {
    const isolatedBefore = await entitlement(outsider)
    const before = await entitlement(member)
    const order = await createOrder(member, addon)
    boundary.markPaid(order.outTradeNo)
    if (rejectWrongAmount) {
      assert.equal((await notification(order, boundary.notification(order.outTradeNo, { total_amount: '22.34' }))).status, 409)
      assert.equal((await row(order.id)).paid_at, null)
      assert.deepEqual(await grants(order.id), [])
    }
    const raw = boundary.notification(order.outTradeNo)
    const callbacks = await Promise.all(Array.from({ length: 8 }, () => notification(order, raw)))
    assert.ok(callbacks.every(item => item.status === 200 && item.text === 'success'))
    assert.equal((await row(order.id)).status, 'fulfilled')
    assert.equal((await pool.query('SELECT count(*)::int n FROM public.payment_events WHERE order_id=$1', [order.id])).rows[0].n, 1)
    assert.deepEqual((await grants(order.id)).map(item => [item.resource, Number(item.total), item.expires_at, item.revoked_at]),
      [['ai_points', 100, null, null], ['interview_seconds', 300, null, null], ['ocr_pages', 20, null, null]])
    const after = await entitlement(member)
    assert.equal(after.active_payment_order_id, before.active_payment_order_id)
    assert.deepEqual(await entitlement(outsider), isolatedBefore)
    assert.equal((await json(outsider.page, 'GET', enterprisePath(outsider) + '/orders/' + order.id)).status, 404)
    return { orderId: order.id, callbacks: callbacks.length, paymentEvents: 1, grants: 3, rejectedWrongAmount: rejectWrongAmount }
  }
  return { configure, subscribe, cancellation, addonAndRecovery, subscriptionRefund, versionAndRenewal, catalogRecovery, billReconciliation, consumedRefund, calendarBoundaries, sustainedAddon, setResumeRule }
}
