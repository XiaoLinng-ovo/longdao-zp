import '../apps/api/dist/src/env.js'
import { parseArgs } from 'node:util'
import { loadDatabaseConfig, createDatabasePool } from '../apps/api/dist/src/db/index.js'
import { PaymentService } from '../apps/api/dist/src/payments/service.js'

const { values } = parseArgs({ options: {
  actor: { type: 'string' },
  'confirm-prices': { type: 'boolean', default: false },
  activate: { type: 'boolean', default: false },
} })
if (!values.actor || !values['confirm-prices']) {
  console.error('Usage: node scripts/publish-payment-catalog.mjs --actor <platform-admin-id> --confirm-prices [--activate]')
  console.error('CNY pricing: 2500 / 12 calendar months; 1300 / 6 calendar months; 258 / calendar month. 100 seats, 2000 jobs.')
  process.exit(1)
}

const pool = createDatabasePool(loadDatabaseConfig())
const service = new PaymentService(pool)
let lock
try {
  lock = await pool.connect()
  await service.adminOverview(values.actor)
  await lock.query("SELECT pg_advisory_lock(hashtext('smartrecruit:standard-payment-catalog'))")
  const plan = (await pool.query(
    "SELECT id FROM subscription_plan_versions WHERE code='growth' AND version=1 AND seat_limit=100 AND job_limit=2000",
  )).rows[0]
  if (!plan) throw new Error('The expected growth capacity version (100 seats / 2000 jobs) is missing; no products were published.')
  for (const [name, amountFen, durationMonths] of [
    ['全功能年付套餐', 250000, 12],
    ['全功能半年套餐', 130000, 6],
    ['全功能月付套餐', 25800, 1],
  ]) {
    const existing = (await pool.query('SELECT id FROM payment_products WHERE name=$1 LIMIT 1', [name])).rows[0]
    // Never override an operator's price changes or intentional delisting on a rerun.
    if (existing) { console.log('Preserved existing product: ' + name); continue }
    const product = await service.publishProduct(values.actor, {
      planVersionId: plan.id, name, amountFen, durationMonths, allModules: true,
      reason: '补齐正式套餐目录，按已确认的年付、半年付及月付定价独立发布',
    })
    if (values.activate) await service.toggleProduct(values.actor, product.id, {
      active: true, reason: '正式套餐目录上架；不启用支付渠道，不创建付款订单',
    })
    console.log((values.activate ? 'Published: ' : 'Draft: ') + name + ' / CNY ' + amountFen / 100 + ' / ' + durationMonths + ' months')
  }
  console.log('Payment providers, customer entitlements and orders were not changed.')
} finally {
  if (lock) {
    await lock.query("SELECT pg_advisory_unlock(hashtext('smartrecruit:standard-payment-catalog'))").catch(() => {})
    lock.release()
  }
  await pool.end()
}
