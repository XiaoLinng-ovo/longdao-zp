import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startLocalSmtpBoundary, verificationCodeFromMime } from '../local-smtp-boundary.mjs'

test('本机邮件验证码提取支持 MIME 多部分、折行、QP 与 base64', () => {
  const plain = '**938251**'
  const messages = [
    'Content-Type: text/plain\r\n\r\n' + plain,
    'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + Buffer.from(plain).toString('base64'),
    'Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=2A=2A938=\r\n251=2A=2A',
    'Content-Type: multipart/alternative;\r\n boundary="local-test"\r\n\r\n--local-test\r\nContent-Type: text/plain\r\n\r\n' + plain + '\r\n--local-test\r\nContent-Type: text/html\r\n\r\n<strong>938251</strong>\r\n--local-test--\r\n',
  ]
  for (const message of messages) assert.equal(verificationCodeFromMime(message), '938251')
  assert.throws(() => verificationCodeFromMime('Content-Type: text/plain\r\n\r\n没有验证码'))
  assert.throws(() => verificationCodeFromMime('Content-Type: text/plain\r\n\r\n**123456** **654321**'))
})

test('本机 SMTP 边界要求合成认证、记录实际 MIME 并支持拒收', { timeout: 10000 }, async () => {
  const { createRequire } = await import('node:module')
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url))
  const nodemailer = require('nodemailer')
  const smtp = await startLocalSmtpBoundary({ user: 'synthetic@example.invalid', password: 'only-local-test' })
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.port, secure: false, auth: { user: 'synthetic@example.invalid', pass: 'only-local-test' } })
  try {
    await transport.sendMail({ from: 'synthetic@example.invalid', to: 'recipient@example.invalid', subject: '合成本地验证码', text: '**718426**' })
    assert.equal(smtp.authenticated, 1)
    assert.deepEqual(smtp.messages[0].recipients, ['recipient@example.invalid'])
    assert.equal(verificationCodeFromMime(smtp.messages[0].raw), '718426')
    smtp.rejectRecipient = true
    await assert.rejects(transport.sendMail({ from: 'synthetic@example.invalid', to: 'recipient@example.invalid', subject: '拒收', text: '**718426**' }), /550/)
    assert.equal(smtp.messages.length, 1)
    const wrong = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.port, secure: false, auth: { user: 'synthetic@example.invalid', pass: 'wrong' } })
    try { await assert.rejects(wrong.verify(), /535/) } finally { wrong.close() }
  } finally { transport.close(); await smtp.close() }
})

