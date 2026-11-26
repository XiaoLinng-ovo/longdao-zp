import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { createServer } from 'node:http'
import { zipFixture, header } from '../apps/api/dist/tests/helpers/alipay-bill.js'

const canonical = (values, notification = false) => Object.keys(values)
  .filter(key => key !== 'sign' && (!notification || key !== 'sign_type') && values[key] !== '')
  .sort().map(key => key + '=' + values[key]).join('&')
const keys = () => generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })

// Only the external channel is synthetic. PaymentService and its database remain real.
export async function startLocalAlipayBoundary() {
  const merchant = keys(), channel = keys(), orders = new Map(), bills = new Map(), requests = [], failures = []
  const billURL = date => 'https://dwbillcenter.alipay.com/downloadBillFile.resource?synthetic_date=' + date
  const config = { environment: 'production', appId: '2026000000000001', sellerId: '2088000000000001', privateKey: merchant.privateKey, publicKey: channel.publicKey }
  const signedParams = form => {
    assert.equal(new Set(form.keys()).size, [...form.keys()].length)
    const p = Object.fromEntries(form)
    assert.equal(p.app_id, config.appId); assert.equal(p.sign_type, 'RSA2')
    assert.equal(verify('RSA-SHA256', Buffer.from(canonical(p)), merchant.publicKey, Buffer.from(p.sign ?? '', 'base64')), true)
    return p
  }
  const newOrder = biz => {
    const no = biz.out_trade_no
    assert.match(no, /^sr[a-f0-9]{30}$/); assert.match(biz.total_amount, /^\d+\.\d{2}$/)
    assert.ok(!orders.has(no), '渠道不能重复创建同一商户订单')
    const order = { no, amount: biz.total_amount, tradeNo: 'synthetic_' + no, paid: false, closed: false, refunds: new Map(), deferRefund: false }
    orders.set(no, order)
    return order
  }
  const handoff = raw => {
    const url = new URL(raw)
    assert.equal(url.origin, 'https://openapi.alipay.com'); assert.equal(url.pathname, '/gateway.do')
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.hash, '')
    const p = signedParams(url.searchParams), biz = JSON.parse(p.biz_content)
    assert.equal(p.method, 'alipay.trade.page.pay'); assert.equal(p.version, '1.0')
    assert.equal(p.charset, 'utf-8'); assert.equal(p.format, 'JSON')
    assert.equal(biz.product_code, 'FAST_INSTANT_TRADE_PAY'); assert.ok(biz.subject)
    assert.equal(Object.hasOwn(biz, 'timeout_express'), false)
    assert.match(biz.time_expire, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const expiresAt = Date.parse(biz.time_expire.replace(' ', 'T') + '+08:00')
    assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 31 * 60000, '必须使用有效且有界的绝对付款截止时间')
    for (const [value, prefix] of [[p.notify_url, '/api/v1/payments/webhook/'], [p.return_url, '/enterprise/payments/']]) {
      const target = new URL(value)
      assert.equal(target.origin, 'https://isolated-payments.example.com')
      assert.ok(target.pathname.startsWith(prefix)); assert.equal(target.username, ''); assert.equal(target.password, '')
    }
    const order = newOrder(biz)
    requests.push({ method: p.method, outTradeNo: order.no, verifiedMerchantSignature: true, browserHandoff: true, expiresAt: new Date(expiresAt).toISOString() })
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本机合成支付边界</title><p id="synthetic-payment-handoff">本机合成支付交接已验证</p></html>'
  }
  let corruptResponse = false, closing
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && /^\/bill\/\d{4}-\d{2}-\d{2}\.zip$/.test(req.url)) {
        const date = req.url.slice(6, 16), zip = bills.get(date)
        assert.ok(zip, '只能下载本边界配置的合成账单')
        requests.push({ method: 'synthetic.bill.download', billDate: date })
        res.setHeader('content-type', 'application/zip'); res.end(zip); return
      }
      assert.equal(req.method, 'POST'); assert.ok(['/gateway', '/browser-handoff'].includes(req.url))
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; assert.ok(size <= 65536); chunks.push(chunk) }
      const rawBody = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/browser-handoff') {
        const html = handoff(rawBody)
        res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(html); return
      }
      const p = signedParams(new URLSearchParams(rawBody))
      const biz = JSON.parse(p.biz_content), no = biz.out_trade_no
      requests.push({ method: p.method, outTradeNo: no, refundId: biz.out_request_no, verifiedMerchantSignature: true })
      let data = { code: '10000', msg: 'Success' }, order = orders.get(no)
      if (p.method === 'alipay.trade.precreate') {
        assert.equal(new URL(p.notify_url).hostname, 'isolated-payments.example.com')
        order = newOrder(biz)
        data.qr_code = 'https://qr.alipay.com/isolated_' + no
      } else if (p.method === 'alipay.data.dataservice.bill.downloadurl.query') {
        assert.equal(biz.bill_type, 'trade'); assert.match(biz.bill_date, /^\d{4}-\d{2}-\d{2}$/)
        if (bills.has(biz.bill_date)) data.bill_download_url = billURL(biz.bill_date)
        else data = { code: '40004', msg: 'Business Failed', sub_code: 'BILL_NOT_EXIST', sub_msg: 'Synthetic bill not ready' }
      } else {
        assert.ok(order, '仅允许查询本边界创建的订单')
        if (p.method === 'alipay.trade.query') Object.assign(data, { out_trade_no: no, trade_no: order.tradeNo, total_amount: order.amount, trade_status: order.paid ? 'TRADE_SUCCESS' : order.closed ? 'TRADE_CLOSED' : 'WAIT_BUYER_PAY' })
        else if (p.method === 'alipay.trade.close') { assert.ok(!order.paid); order.closed = true; Object.assign(data, { out_trade_no: no, trade_no: order.tradeNo }) }
        else if (p.method === 'alipay.trade.refund') {
          assert.ok(order.paid); assert.equal(biz.refund_amount, order.amount)
          assert.match(biz.out_request_no, /^rf_[a-f0-9]+$/)
          const previous = order.refunds.get(biz.out_request_no)
          assert.ok(!previous, '不得重新发送已接收退款')
          order.refunds.set(biz.out_request_no, { confirmed: !order.deferRefund, amount: biz.refund_amount })
          Object.assign(data, { out_trade_no: no, refund_fee: order.amount, fund_change: order.deferRefund ? 'N' : 'Y' })
        } else if (p.method === 'alipay.trade.fastpay.refund.query') {
          const refund = order.refunds.get(biz.out_request_no); assert.ok(refund)
          Object.assign(data, { out_trade_no: no, out_request_no: biz.out_request_no, refund_amount: refund.amount, refund_status: refund.confirmed ? 'REFUND_SUCCESS' : 'REFUND_PROCESSING' })
        } else throw new Error('未允许的合成支付渠道方法')
      }
      const raw = JSON.stringify(data), key = p.method.replaceAll('.', '_') + '_response'
      const signature = sign('RSA-SHA256', Buffer.from(raw), channel.privateKey).toString('base64')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ [key]: data, sign: corruptResponse ? Buffer.alloc(256).toString('base64') : signature }))
      corruptResponse = false
    } catch (error) {
      failures.push({ message: error.message })
      res.statusCode = 400; res.end('synthetic boundary rejected request')
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  const get = no => { const order = orders.get(no); assert.ok(order); return order }
  return {
    port, config, requests, failures,
    async browserHandoff(url) {
      assert.equal(typeof url, 'string'); assert.ok(Buffer.byteLength(url) <= 65536)
      const response = await fetch('http://127.0.0.1:' + port + '/browser-handoff', {
        method: 'POST', body: url, signal: AbortSignal.timeout(5000), redirect: 'error' })
      assert.equal(response.status, 200, '本机合成支付边界拒绝浏览器交接')
      return response.text()
    },
    setBill(date, entries) {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
      assert.ok(Array.isArray(entries) && entries.length <= 100)
      const cell = value => '"' + String(value).replaceAll('"', '""') + '"'
      const rows = entries.map(e => [e.transactionId, e.outTradeNo, e.type === 'refund' ? '退款' : '交易',
        (e.amountFen / 100).toFixed(2), e.refundId ?? '', '本机合成账单'].map(cell).join(','))
      bills.set(date, zipFixture(Buffer.from(header + '\r\n' + rows.join('\r\n') + '\r\n')))
    },
    setInvalidBill(date) { assert.match(date, /^\d{4}-\d{2}-\d{2}$/); bills.set(date, Buffer.from('invalid synthetic ZIP')) },
    async downloadBill(url) {
      const parsed = new URL(url), date = parsed.searchParams.get('synthetic_date')
      assert.ok(bills.has(date)); assert.equal(url, billURL(date), '不允许其他账单下载地址')
      const response = await fetch('http://127.0.0.1:' + port + '/bill/' + date + '.zip', { signal: AbortSignal.timeout(5000), redirect: 'error' })
      assert.equal(response.status, 200)
      return Buffer.from(await response.arrayBuffer())
    },
    async transport(url, method, body, headers) {
      assert.equal(url, 'https://openapi.alipay.com/gateway.do', '不允许其他外部支付地址')
      assert.equal(method, 'POST'); assert.equal(typeof body, 'string'); assert.ok(Buffer.byteLength(body) <= 65536)
      const response = await fetch('http://127.0.0.1:' + port + '/gateway', { method, body, headers, signal: AbortSignal.timeout(5000), redirect: 'error' })
      assert.equal(response.status, 200, '本机合成支付渠道拒绝请求')
      return { text: await response.text(), headers: Object.fromEntries(response.headers) }
    },
    markPaid(no) { const order = get(no); assert.ok(!order.closed); order.paid = true },
    deferRefund(no) { get(no).deferRefund = true },
    confirmRefund(no, id) { const refund = get(no).refunds.get(id); assert.ok(refund); refund.confirmed = true },
    notification(no, overrides = {}) {
      const order = get(no); assert.ok(order.paid)
      const p = { app_id: config.appId, seller_id: config.sellerId, out_trade_no: no, trade_no: order.tradeNo,
        total_amount: order.amount, trade_status: 'TRADE_SUCCESS', sign_type: 'RSA2', ...overrides }
      p.sign = sign('RSA-SHA256', Buffer.from(canonical(p, true)), channel.privateKey).toString('base64')
      return new URLSearchParams(p).toString()
    },
    invalidateNextResponse() { corruptResponse = true },
    close() { return closing ??= new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() }) },
  }
}
