import assert from 'node:assert/strict'
import { join } from 'node:path'

export function emailRecoveryFlow({ pool, instance, json, responseAfter, origin, boundary, activate }) {
  return async function recovery(owner, ordinary) {
    const page = owner.page; activate(page)
    const offerPath = '/offers/' + owner.offerId, schema = '"' + owner.schema + '"'
    const snapshot = async () => ({
      offer: (await pool.query('SELECT status,version,current_version_id FROM ' + schema + '.offers WHERE id=$1', [owner.offerId])).rows[0],
      application: (await pool.query('SELECT status FROM ' + schema + '.applications WHERE id=$1', [owner.applicationId])).rows[0],
      onboarding: (await pool.query('SELECT status FROM ' + schema + '.onboarding_records WHERE id=$1', [owner.onboardingId])).rows[0],
    })
    const original = await snapshot(), baseline = boundary.messages.length
    assert.equal(original.offer.status, 'accepted'); assert.equal(original.onboarding.status, 'completed')
    const body = { to: 'candidate@example.invalid', subject: '合成补发核对', markdown: '合成录用通知补发，仅用于本机恢复验收。', versionId: original.offer.current_version_id }
    const deliveries = async () => (await pool.query('SELECT id,status,message_id,resolved_by,resolution_note FROM public.offer_email_deliveries WHERE offer_id=$1 ORDER BY created_at,id', [owner.offerId])).rows
    async function resolveInPage(delivery, status, note) {
      const endpoint = '/admin/email-deliveries/' + delivery.id + '/resolve'
      assert.equal((await json(ordinary.page, 'GET', '/admin/email-deliveries')).status, 403)
      assert.equal((await json(ordinary.page, 'POST', endpoint, { status, note })).status, 403)
      assert.equal((await json(page, 'POST', endpoint, { status, note: '短' })).status, 400)
      await page.goto(origin + '/administration?module=smtp')
      const panel = page.getByRole('region', { name: '异常任务核对', exact: true })
      const row = panel.locator('tbody tr').filter({ hasText: delivery.message_id })
      await row.getByRole('button', { name: status === 'completed' ? '已接受' : '未发送', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: status === 'completed' ? '确认 SMTP 已接受并同步业务状态' : '确认未发送，解除发送预留', exact: true })
      assert.equal(await dialog.getByRole('button', { name: '记录核对结果', exact: true }).isDisabled(), true)
      await dialog.getByLabel('核对依据', { exact: true }).fill(note)
      await dialog.getByRole('checkbox', { name: /已核实服务日志及业务记录/ }).check()
      await responseAfter(page, 'POST', endpoint, () => dialog.getByRole('button', { name: '记录核对结果', exact: true }).click())
      await panel.getByText('核对结果已记录', { exact: true }).waitFor()
      assert.equal((await json(page, 'POST', endpoint, { status, note })).status, 409)
      const audit = (await pool.query("SELECT actor_user_id,organization_id,metadata FROM public.platform_audit_logs WHERE action='email.delivery.resolve' AND metadata->>'deliveryId'=$1", [delivery.id])).rows
      assert.equal(audit.length, 1); assert.equal(audit[0].actor_user_id, owner.userId); assert.equal(audit[0].organization_id, owner.id)
      assert.equal(audit[0].metadata.status, status); assert.equal(audit[0].metadata.note, note)
      assert.equal((await deliveries()).find(row => row.id === delivery.id).status, status)
    }
    boundary.disconnectAfterNextData()
    const uncertain = await json(page, 'POST', offerPath + '/send-email', body)
    assert.equal(uncertain.status, 502); assert.equal(uncertain.body.error.code, 'OFFER_EMAIL_STATUS_UNKNOWN')
    assert.equal(boundary.messages.length, baseline + 1)
    const accepted = (await deliveries()).find(row => row.status === 'unknown')
    assert.ok(accepted); assert.ok(boundary.messages.at(-1).raw.includes(accepted.message_id))
    assert.deepEqual(await snapshot(), original, '未确认SMTP结果前不能更新Offer或入职状态')
    const blocked = await json(page, 'POST', offerPath + '/send-email', body)
    assert.equal(blocked.status, 409); assert.equal(boundary.messages.length, baseline + 1)
    await resolveInPage(accepted, 'completed', '已核对本机SMTP收下DATA及对应Message-ID，连接断在最终确认之前')
    const recovered = await snapshot()
    assert.equal(recovered.offer.status, 'accepted'); assert.equal(recovered.offer.version, original.offer.version + 1)
    assert.deepEqual(recovered.application, original.application); assert.deepEqual(recovered.onboarding, original.onboarding)
    assert.equal(boundary.messages.length, baseline + 1, '管理员核对不能再次发信')
    boundary.rejectRecipient = true
    try {
      const rejected = await json(page, 'POST', offerPath + '/send-email', body)
      assert.equal(rejected.status, 502); assert.equal(rejected.body.error.code, 'OFFER_EMAIL_STATUS_UNKNOWN')
    } finally { boundary.rejectRecipient = false }
    assert.equal(boundary.messages.length, baseline + 1)
    const notSent = (await deliveries()).find(row => row.status === 'unknown')
    assert.ok(notSent)
    await resolveInPage(notSent, 'not_sent', '已核对本机SMTP在RCPT阶段拒绝，未接受邮件正文，允许用户重新发送')
    assert.deepEqual(await snapshot(), recovered)
    const retried = await json(page, 'POST', offerPath + '/send-email', body)
    assert.equal(retried.status, 200)
    assert.equal(boundary.messages.length, baseline + 2)
    const final = await snapshot(), ledger = await deliveries()
    assert.equal(final.offer.status, 'accepted'); assert.equal(final.offer.version, recovered.offer.version + 1)
    assert.deepEqual(final.application, original.application); assert.deepEqual(final.onboarding, original.onboarding)
    assert.equal(ledger.filter(row => row.status === 'unknown').length, 0)
    assert.equal(ledger.filter(row => row.status === 'not_sent').length, 1)
    await page.screenshot({ path: join(instance.directory, 'email-recovery-verified.png'), fullPage: true })
    return { dataAcknowledgementLost: true, recipientRejected: true, businessStateNotFaked: true, unknownBlockedDuplicate: true, administratorUiDecisions: 2, ordinaryUserDenied: 4, invalidNotesRejected: 2, replayRejected: 2, auditedOncePerDecision: true, retriedAfterVerifiedNotSent: true, acceptedOfferAndOnboardingPreserved: true, locallyAcceptedMessages: 2, externalDelivery: false }
  }
}
