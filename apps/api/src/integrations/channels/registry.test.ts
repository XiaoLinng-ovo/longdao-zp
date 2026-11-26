import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createChannelConnector } from './registry.js'
import { signOfficialSiteWebhook } from './official-site-connector.js'

const emptyInput = {
  enabled: true,
  baseUrl: '',
  appKey: '',
  appSecret: '',
  webhookToken: '',
  signingSecret: '',
}

describe('channel connector registry', () => {
  it('fails closed when credentials are absent', async () => {
    const result = await createChannelConnector('boss').test(emptyInput)
    assert.equal(result.status, 'not_configured')
    assert.match(result.message, /BASE_URL|APP_KEY|APP_SECRET/u)
  })

  it('does not pretend a platform protocol is implemented before official API onboarding', async () => {
    const result = await createChannelConnector('boss').test({
      ...emptyInput,
      baseUrl: 'https://open.example.com',
      appKey: 'app-key',
      appSecret: 'app-secret',
    })
    assert.equal(result.status, 'not_implemented')
  })

  it('accepts an official-site inbound webhook only with a valid HMAC signature', async () => {
    const connector = createChannelConnector('official_site')
    const body = Buffer.from('{"name":"张三"}')
    const timestamp = '1789927200'
    const signature = signOfficialSiteWebhook('secret', timestamp, body)

    const accepted = await connector.verifyWebhook({
      body,
      timestamp,
      signature,
      secret: 'secret',
      nowMs: Number(timestamp) * 1000,
    })
    const rejected = await connector.verifyWebhook({
      body,
      timestamp,
      signature: 'bad',
      secret: 'secret',
      nowMs: Number(timestamp) * 1000,
    })

    assert.equal(accepted.ok, true)
    assert.equal(rejected.ok, false)
  })
})
