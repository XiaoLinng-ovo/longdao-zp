import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export interface DingTalkCallbackCryptoConfig { token: string; aesKey: string; corpId: string }

export class DingTalkCallbackCrypto {
  private readonly key: Buffer
  constructor(private readonly config: DingTalkCallbackCryptoConfig) {
    this.key = Buffer.from(`${config.aesKey}=`, 'base64')
    if (this.key.length !== 32) throw new Error('DingTalk callback AES key must decode to 32 bytes')
  }

  verify(signature: string, timestamp: string, nonce: string, encrypted: string): boolean {
    const expected = Buffer.from(this.signature(timestamp, nonce, encrypted))
    const actual = Buffer.from(signature)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  decrypt(encrypted: string): string {
    const decipher = createDecipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16))
    decipher.setAutoPadding(false)
    const padded = Buffer.concat([decipher.update(encrypted, 'base64'), decipher.final()])
    const pad = padded[padded.length - 1] ?? 0
    if (pad < 1 || pad > 32) throw new Error('Invalid callback padding')
    const plain = padded.subarray(0, padded.length - pad)
    const length = plain.readUInt32BE(16)
    const message = plain.subarray(20, 20 + length).toString('utf8')
    const corpId = plain.subarray(20 + length).toString('utf8')
    if (corpId !== this.config.corpId) throw new Error('Callback CorpId/AppKey mismatch')
    return message
  }

  encrypt(message: string, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(8).toString('hex')) {
    const content = Buffer.from(message)
    const length = Buffer.alloc(4); length.writeUInt32BE(content.length)
    const plain = Buffer.concat([randomBytes(16), length, content, Buffer.from(this.config.corpId)])
    const padLength = 32 - (plain.length % 32)
    const padded = Buffer.concat([plain, Buffer.alloc(padLength, padLength)])
    const cipher = createCipheriv('aes-256-cbc', this.key, this.key.subarray(0, 16)); cipher.setAutoPadding(false)
    const encrypt = Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64')
    return { encrypt, msg_signature: this.signature(timestamp, nonce, encrypt), timeStamp: timestamp, nonce }
  }

  private signature(timestamp: string, nonce: string, encrypted: string): string {
    return createHash('sha1').update([this.config.token, timestamp, nonce, encrypted].sort().join('')).digest('hex')
  }
}
