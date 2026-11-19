import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { OfferEmailDeliveryStore } from './delivery-store.js'

function fixture(rows: unknown[][], fail?: string) {
  const calls: Array<{sql: string; values: unknown[]}> = []
  let released = false
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({sql, values})
    if (fail && sql.includes(fail)) throw new Error('database unavailable')
    return { rows: rows.shift() ?? [] }
  }
  const pool = {query, connect: async () => ({query, release() { released = true }})} as unknown as Pool
  return {store: new OfferEmailDeliveryStore(pool), calls, released: () => released}
}
test('sending reserves a stable message ID after locking the exact company and version', async () => {
  const f = fixture([[], [{current_version_id: 'v1', version: 2}], [{id: 'reserved'}], []])
  const delivery = await f.store.begin('company', 'offer', 'v1', 2)
  assert.equal(delivery.messageId, '<' + delivery.id + '@smartrecruit.local>')
  assert.ok(f.calls[1]!.sql.includes("organization_id=$2 FOR UPDATE"))
  assert.deepEqual(f.calls[1]!.values, ['offer', 'company'])
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT')
  assert.equal(f.released(), true)
})
test('stale versions, cross-company offers and duplicate sends roll back before SMTP', async () => {
  for (const [offer, reservation, code] of [
    [[], [], 'NOT_FOUND'], [[{current_version_id: 'v2', version: 2}], [], 'OFFER_VERSION_CONFLICT'],
    [[{current_version_id: 'v1', version: 2}], [], 'OFFER_EMAIL_STATUS_UNKNOWN'],
  ] as const) {
    const f = fixture([[], [...offer], [...reservation]])
    await assert.rejects(f.store.begin('company', 'offer', 'v1', 2), {code})
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
    assert.equal(f.released(), true)
  }
})
test('unknown results cannot be silently overwritten and active sends cannot be resolved immediately', async () => {
  const f = fixture([[], []])
  await assert.rejects(f.store.setStatus('delivery', 'accepted'), {code: 'OFFER_EMAIL_STATUS_UNKNOWN'})
  await assert.rejects(f.store.resolve('delivery', 'not_sent', 'actor', 'verified by provider'), {code: 'EMAIL_RESOLUTION_CONFLICT'})
  assert.ok(f.calls[0]!.sql.includes("status IN ('sending','accepted')"))
  assert.match(f.calls.find(call => call.sql.includes("interval '10 minutes'"))!.sql, /UPDATE public.offer_email_deliveries/)
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(f.released(), true)
})

test('confirming not sent requires an atomic administrator audit', async () => {
  const success=fixture([[],[{offer_id:'offer',organization_id:'company'}],[],[]])
  assert.equal(await success.store.resolve('delivery','not_sent','actor','verified by provider'),'offer')
  assert.ok(success.calls[2]!.sql.includes('platform_audit_logs'))
  assert.equal(success.calls.at(-1)?.sql,'COMMIT')
  const failed=fixture([[],[{offer_id:'offer',organization_id:'company'}]],'platform_audit_logs')
  await assert.rejects(failed.store.resolve('delivery','not_sent','actor','verified by provider'),/database unavailable/)
  assert.equal(failed.calls.at(-1)?.sql,'ROLLBACK')
  assert.equal(failed.released(),true)
})
