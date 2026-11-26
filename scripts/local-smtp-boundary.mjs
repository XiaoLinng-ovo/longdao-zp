import assert from 'node:assert/strict'
import { createServer } from 'node:net'

function headersAndBody(value) {
  const index = value.indexOf('\r\n\r\n')
  assert.ok(index >= 0, 'MIME 消息缺少头部边界')
  const headers = new Map()
  for (const line of value.slice(0, index).replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':')
    assert.ok(colon > 0, 'MIME 头部格式错误')
    headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim())
  }
  return { headers, body: value.slice(index + 4) }
}

export function verificationCodeFromMime(raw) {
  function plainText(value) {
    const { headers, body } = headersAndBody(value)
    const type = headers.get('content-type') || 'text/plain'
    if (/^multipart\//i.test(type)) {
      const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type)
      assert.ok(boundary, 'MIME 多部分消息缺少 boundary')
      return body.split('--' + (boundary[1] || boundary[2])).slice(1)
        .filter(part => !part.startsWith('--')).map(part => plainText(part.replace(/^\r\n/, ''))).join('\n')
    }
    if (!/^text\/plain(?:;|$)/i.test(type)) return ''
    const encoding = (headers.get('content-transfer-encoding') || '7bit').toLowerCase()
    if (encoding === 'base64') return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')
    if (encoding === 'quoted-printable') {
      const bytes = body.replace(/=\r\n/g, '').replace(/=([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      return Buffer.from(bytes, 'latin1').toString('utf8')
    }
    assert.ok(['7bit', '8bit'].includes(encoding), '不支持的 MIME 传输编码')
    return body
  }
  const codes = [...plainText(raw).matchAll(/\*\*(\d{6})\*\*/g)].map(match => match[1])
  assert.equal(codes.length, 1, '邮件必须包含一个真实生成的验证码')
  return codes[0]
}

export async function startLocalSmtpBoundary({ user, password }) {
  const sockets = new Set(), messages = []
  let rejectRecipient = false, authenticated = 0, disconnectAfterData = false
  const server = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => undefined); socket.setTimeout(15000, () => socket.destroy())
    socket.setEncoding('utf8'); socket.write('220 local.fixture ESMTP ready\r\n')
    let buffer = '', message = '', data = false, authorized = false, recipients = []
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length + message.length > 2 * 1024 * 1024) { socket.destroy(); return }
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index < 0) return
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2)
        if (data) {
          if (line === '.') {
            data = false; messages.push({ recipients: [...recipients], raw: message }); message = ''
            if (disconnectAfterData) { disconnectAfterData = false; socket.destroy(); return }
            socket.write('250 accepted locally only\r\n')
          } else message += line.replace(/^\.\./, '.') + '\r\n'
        } else if (/^(EHLO|HELO) /.test(line)) socket.write('250-local.fixture\r\n250 AUTH PLAIN\r\n')
        else if (line.startsWith('AUTH PLAIN ')) {
          const fields = Buffer.from(line.slice(11), 'base64').toString().split('\0')
          authorized = fields[1] === user && fields[2] === password
          if (authorized) authenticated++
          socket.write(authorized ? '235 authenticated\r\n' : '535 invalid local credentials\r\n')
        } else if (!authorized && !line.startsWith('QUIT')) socket.write('530 authenticate first\r\n')
        else if (line.startsWith('MAIL FROM:')) { recipients = []; socket.write('250 sender accepted\r\n') }
        else if (line.startsWith('RCPT TO:')) {
          if (rejectRecipient) socket.write('550 synthetic recipient rejection\r\n')
          else { recipients.push(line.slice(8).replace(/[<>]/g, '').trim()); socket.write('250 recipient accepted\r\n') }
        } else if (line === 'DATA') {
          if (!recipients.length) socket.write('554 no recipients\r\n')
          else { data = true; message = ''; socket.write('354 send message\r\n') }
        } else if (line === 'QUIT') socket.end('221 bye\r\n')
        else if (line === 'RSET') { recipients = []; socket.write('250 reset\r\n') }
        else socket.write('250 ok\r\n')
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    port: server.address().port, messages,
    get authenticated() { return authenticated },
    set rejectRecipient(value) { rejectRecipient = Boolean(value) },
    disconnectAfterNextData() { disconnectAfterData = true },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}

