import assert from 'node:assert/strict'
import { it } from 'node:test'
import { lastOfferEmail, offerConfirmation } from './offer-confirmation.js'
import type { OfferRecord, OfferVersionRecord } from './types.js'

it('restores the latest successful recipient and subject without using revisions as email data', () => {
  const events = [
    { action: 'send', createdAt: '2026-11-01', metadata: { recipient: 'first@example.test', subject: '首次主题' } },
    { action: 'revise', createdAt: '2026-11-04', metadata: { recipient: 'not-an-email-event', subject: '不应读取' } },
    { action: 'resend_cancelled', createdAt: '2026-11-03', metadata: { recipient: 'last@example.test', subject: '重新发送主题' } },
  ]
  assert.deepEqual(lastOfferEmail(events), { to: 'last@example.test', subject: '重新发送主题' })
  assert.deepEqual(lastOfferEmail([...events].reverse()), lastOfferEmail(events))
  assert.equal(lastOfferEmail([]), undefined)
  assert.equal(lastOfferEmail([{ action: 'send', createdAt: '2026-11-01' }]), undefined)
})

it('assigns legacy acceptance to the version active at acceptance, never the latest revision', () => {
  const versions = [{ id: 'v1', version: 1, createdAt: '2026-10-01' }, { id: 'v2', version: 2, createdAt: '2026-10-20' }] as OfferVersionRecord[]
  const offer = { status: 'accepted', currentVersionId: 'v2', respondedAt: '2026-10-10' } as OfferRecord
  for (const events of [[], [{ action: 'accept', createdAt: '2026-10-10' }]]) {
    const summary = offerConfirmation(offer, versions, events)
    assert.equal(summary.currentVersionStatus, 'pending')
    assert.equal(summary.confirmations[0]!.versionId, 'v1')
  }
  const summary = offerConfirmation(offer, versions, [{ action: 'accept', createdAt: '2026-10-10', metadata: { versionId: 'v1' } }, { action: 'confirm_revision', createdAt: '2026-10-22', reason: '已邮件确认', metadata: { versionId: 'v2' } }])
  assert.equal(summary.currentVersionStatus, 'confirmed')
  assert.equal(summary.confirmations.length, 2)
})

