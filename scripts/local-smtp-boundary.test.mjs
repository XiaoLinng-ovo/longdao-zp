import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { startLocalSmtpBoundary } from './local-smtp-boundary.mjs'

const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const nodemailer = require('nodemailer')

test('本机SMTP真实协议：正常接受、DATA后断连不重投、收件人拒绝', async () => {
  const smtp = await startLocalSmtpBoundary({ user: 'fixture@example.invalid', password: 'synthetic-only' })
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.port, secure: false,
    auth: { user: 'fixture@example.invalid', pass: 'synthetic-only' }, socketTimeout: 2000 })
  const mail = { from: 'fixture@example.invalid', to: 'candidate@example.invalid', subject: '合成本机邮件', text: '仅本机接收', messageId: '<synthetic@example.invalid>' }
  try {
    const accepted = await transport.sendMail(mail)
    assert.deepEqual(accepted.accepted, ['candidate@example.invalid'])
    smtp.disconnectAfterNextData()
    await assert.rejects(transport.sendMail(mail), { code: 'ECONNECTION' })
    assert.equal(smtp.messages.length, 2)
    assert.ok(smtp.messages[1].raw.includes(mail.messageId))
    await transport.sendMail(mail)
    assert.equal(smtp.messages.length, 3, '断连故障必须只作用一次')
    smtp.rejectRecipient = true
    await assert.rejects(transport.sendMail(mail), { code: 'EENVELOPE' })
    assert.equal(smtp.messages.length, 3, 'RCPT拒绝不能收下DATA')
  } finally { transport.close(); await smtp.close() }
})
