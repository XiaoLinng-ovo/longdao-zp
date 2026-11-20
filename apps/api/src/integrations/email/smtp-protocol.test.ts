import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sendSmtpMail, testSmtpConnection } from './smtp.js'

test('local SMTP verifies authentication, MIME attachments, stable IDs and rejection without external delivery', {timeout: 10_000}, async () => {
  const sockets = new Set<Socket>(), messages: string[] = []
  let rejectRecipient = false, authenticated = 0
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.setEncoding('utf8'); socket.write('220 local.fixture ESMTP ready\r\n')
    let buffer = '', data = false, message = ''
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const end = buffer.indexOf('\r\n')
        if (end < 0) break
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (data) {
          if (line === '.') { data = false; messages.push(message); message = ''; socket.write('250 queued locally\r\n') }
          else message += line + '\r\n'
        } else if (/^EHLO|^HELO/.test(line)) socket.write('250-local.fixture\r\n250 AUTH PLAIN\r\n')
        else if (line.startsWith('AUTH PLAIN ')) { authenticated++; socket.write('235 authenticated\r\n') }
        else if (line.startsWith('MAIL FROM:')) socket.write('250 sender accepted\r\n')
        else if (line.startsWith('RCPT TO:')) socket.write(rejectRecipient ? '550 recipient rejected\r\n' : '250 recipient accepted\r\n')
        else if (line === 'DATA') { data = true; socket.write('354 send message\r\n') }
        else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  const directory = await mkdtemp(join(tmpdir(), 'smtp-protocol-'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as {port: number}
  const env = {SMTP_HOST: '127.0.0.1', SMTP_PORT: String(address.port), SMTP_SECURE: 'false', SMTP_USER: 'sender@example.invalid', SMTP_PASSWORD: 'local-only', SMTP_FROM: 'sender@example.invalid'}
  const missingFile = join(directory, '.env')
  try {
    assert.equal((await testSmtpConnection({}, env, missingFile)).ok, true)
    await sendSmtpMail({to: 'candidate@example.invalid', subject: 'Offer', markdown: 'Local fixture', messageId: '<stable-id@smartrecruit.local>', attachment: {filename: 'offer.pdf', content: Buffer.from('%PDF-1.7\nfixture')}}, env, missingFile)
    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /Message-ID: <stable-id@smartrecruit.local>/i)
    assert.match(messages[0]!, /Content-Type: application\/pdf/i)
    assert.match(messages[0]!, /filename=offer.pdf/i)
    rejectRecipient = true
    await assert.rejects(sendSmtpMail({to: 'candidate@example.invalid', subject: 'Rejected', markdown: 'fixture'}, env, missingFile), /550|recipient rejected/i)
    assert.equal(messages.length, 1)
    assert.ok(authenticated >= 3)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(directory, {recursive: true, force: true})
  }
})
