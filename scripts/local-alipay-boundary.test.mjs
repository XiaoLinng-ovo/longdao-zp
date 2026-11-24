import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sign } from 'node:crypto'
import { startLocalAlipayBoundary } from './local-alipay-boundary.mjs'
import { createProvider } from '../apps/api/dist/src/payments/providers.js'
import { parseBill } from '../apps/api/dist/src/payments/bill-format.js'

const request = no => ({ outTradeNo: no, amountFen: 1234, name: '合成套餐', method: 'alipay', mode: 'qrcode',
  notifyURL: 'https://isolated-payments.example.com/api/v1/payments/webhook/synthetic', returnURL: 'https://isolated-payments.example.com/enterprise/payments/synthetic', expiresAt: new Date(Date.now() + 60000).toISOString() })

function resign(url, privateKey, change) {
  const parsed = new URL(url), p = Object.fromEntries(parsed.searchParams)
  change(p)
  const canonical = Object.keys(p).filter(key => key !== 'sign' && p[key] !== '').sort().map(key => key + '=' + p[key]).join('&')
  p.sign = sign('RSA-SHA256', Buffer.from(canonical), privateKey).toString('base64')
  parsed.search = new URLSearchParams(p).toString()
  return parsed.href
}

test('跳转支付只本地签名，真实浏览器交接验签后才创建渠道交易且可查询关单', async () => {
  const boundary = await startLocalAlipayBoundary()
  try {
    const provider = createProvider('alipay', boundary.config, boundary.transport), no = 'sr' + 'c'.repeat(30)
    const result = await provider.create({ ...request(no), mode: 'redirect' })
    assert.equal(result.qrCode, null); assert.equal(boundary.requests.length, 0)
    assert.throws(() => boundary.markPaid(no))
    assert.match(await boundary.browserHandoff(result.payURL), /id="synthetic-payment-handoff"/)
    assert.equal(boundary.requests.length, 1)
    assert.equal(boundary.requests[0].method, 'alipay.trade.page.pay')
    assert.equal(boundary.requests[0].verifiedMerchantSignature, true)
    assert.equal((await provider.query(no)).paid, false)
    await provider.close(no)
    assert.throws(() => boundary.markPaid(no))
    assert.deepEqual(boundary.failures, [])
  } finally { await boundary.close() }
})

test('浏览器交接拒绝篡改签名、重复参数、陌生网关、过期及错误产品，不创建渠道订单', async () => {
  const boundary = await startLocalAlipayBoundary()
  try {
    const provider = createProvider('alipay', boundary.config, boundary.transport), no = 'sr' + 'd'.repeat(30)
    const { payURL } = await provider.create({ ...request(no), mode: 'redirect' })
    const invalid = [payURL.replace('app_id=2026000000000001', 'app_id=forged'), payURL + '&app_id=2026000000000001',
      payURL.replace('openapi.alipay.com', 'unknown.example.com'), payURL.replace('https:', 'http:'),
      payURL + '#unexpected',
      resign(payURL, boundary.config.privateKey, p => { const biz = JSON.parse(p.biz_content); biz.time_expire = '2020-01-01 00:00:00'; p.biz_content = JSON.stringify(biz) }),
      resign(payURL, boundary.config.privateKey, p => { const biz = JSON.parse(p.biz_content); biz.product_code = 'UNKNOWN'; p.biz_content = JSON.stringify(biz) }),
      resign(payURL, boundary.config.privateKey, p => { p.return_url = 'https://unknown.example.com/enterprise/payments/synthetic' })]
    for (const url of invalid) await assert.rejects(boundary.browserHandoff(url))
    assert.equal(boundary.requests.length, 0); assert.equal(boundary.failures.length, invalid.length)
    assert.throws(() => boundary.markPaid(no))
    await boundary.browserHandoff(payURL)
    await assert.rejects(boundary.browserHandoff(payURL))
    assert.equal(boundary.requests.length, 1, '重复交接不能重复创建渠道交易')
  } finally { await boundary.close() }
})

test('本机支付边界保留真实RSA请求、响应与通知验签，关闭可重复调用', async () => {
  const boundary = await startLocalAlipayBoundary()
  try {
    const provider = createProvider('alipay', boundary.config, boundary.transport), no = 'sr' + 'a'.repeat(30)
    assert.ok((await provider.create(request(no))).qrCode)
    assert.equal((await provider.query(no)).paid, false)
    boundary.markPaid(no)
    assert.equal((await provider.query(no)).amountFen, 1234)
    const raw = boundary.notification(no)
    assert.equal((await provider.notification(raw, {})).paid, true)
    await assert.rejects(provider.notification(raw.replace('total_amount=12.34', 'total_amount=22.34'), {}))
    boundary.deferRefund(no)
    const id = 'rf_' + '1'.repeat(32)
    assert.equal(await provider.refund(no, id, 1234, '合成退款'), false)
    assert.equal(await provider.queryRefund(no, id, 1234), false)
    boundary.confirmRefund(no, id)
    assert.equal(await provider.queryRefund(no, id, 1234), true)
    assert.deepEqual(boundary.failures, [])
    assert.ok(boundary.requests.every(item => item.verifiedMerchantSignature))
  } finally { await Promise.all([boundary.close(), boundary.close()]) }
})

test('本机边界可生成错误渠道签名，真实提供者必须拒绝，且禁止未知网关', async () => {
  const boundary = await startLocalAlipayBoundary()
  try {
    const provider = createProvider('alipay', boundary.config, boundary.transport), no = 'sr' + 'b'.repeat(30)
    boundary.invalidateNextResponse()
    await assert.rejects(provider.create(request(no)))
    await provider.close(no)
    await assert.rejects(boundary.transport('https://unknown.example.com/gateway', 'POST', ''))
    assert.deepEqual(boundary.failures, [])
  } finally { await boundary.close() }
})

test('本机渠道拒绝未经签名的请求', async () => {
  const boundary = await startLocalAlipayBoundary()
  try {
    const response = await fetch('http://127.0.0.1:' + boundary.port + '/gateway', { method: 'POST', body: 'app_id=forged' })
    assert.equal(response.status, 400)
    assert.equal(boundary.requests.length, 0)
    assert.equal(boundary.failures.length, 1)
  } finally { await boundary.close() }
})

test('本机账单查询返回带真实渠道签名的未就绪结果，不伪造账单成功', async () => {
  const boundary = await startLocalAlipayBoundary()
  try {
    const provider = createProvider('alipay', boundary.config, boundary.transport)
    await assert.rejects(provider.billURL('2026-11-12'), { code: 'PAYMENT_BILL_NOT_READY', status: 409 })
    assert.equal(boundary.requests.length, 1)
    assert.equal(boundary.requests[0].method, 'alipay.data.dataservice.bill.downloadurl.query')
    assert.deepEqual(boundary.failures, [])
  } finally { await boundary.close() }
})

test('合成账单由签名URL经本机HTTP下载，真实ZIP与CSV解析，禁止其他下载地址', async () => {
  const boundary = await startLocalAlipayBoundary()
  try {
    const provider = createProvider('alipay', boundary.config, boundary.transport), date = '2026-11-12'
    const entry = { outTradeNo: 'synthetic-order', transactionId: 'synthetic-trade', type: 'payment', amountFen: 1234, refundId: '' }
    boundary.setBill(date, [entry])
    const url = await provider.billURL(date)
    assert.deepEqual(parseBill(await boundary.downloadBill(url)), [entry])
    assert.equal(boundary.requests.filter(r => r.method === 'synthetic.bill.download').length, 1)
    for (const invalid of ['https://unknown.example.com/downloadBillFile.resource?synthetic_date=' + date,
      'http://127.0.0.1/downloadBillFile.resource?synthetic_date=' + date, url + '&extra=1']) await assert.rejects(boundary.downloadBill(invalid))
    boundary.setBill(date, [])
    assert.deepEqual(parseBill(await boundary.downloadBill(await provider.billURL(date))), [])
    assert.deepEqual(boundary.failures, [])
  } finally { await boundary.close() }
})

test('合成损坏账单仍通过真实渠道验签和HTTP，解析器必须拒绝ZIP', async () => {
  const boundary = await startLocalAlipayBoundary()
  try {
    const provider = createProvider('alipay', boundary.config, boundary.transport), date = '2026-11-12'
    boundary.setInvalidBill(date)
    const zip = await boundary.downloadBill(await provider.billURL(date))
    assert.throws(() => parseBill(zip), { code: 'PAYMENT_BILL_INVALID' })
    assert.deepEqual(boundary.failures, [])
  } finally { await boundary.close() }
})
