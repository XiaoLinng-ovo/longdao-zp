import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CHANNEL_PROVIDERS, channelEnvKeys, channelProviderDefinition } from './providers.js'

describe('channel provider definitions', () => {
  it('defines exactly the approved channels in display order', () => {
    assert.deepEqual(CHANNEL_PROVIDERS.map((item) => item.id), ['boss', 'liepin', '51job', 'official_site'])
  })

  it('marks secrets and emits a stable environment key set', () => {
    const boss = channelProviderDefinition('boss')
    assert.equal(boss.fields.find((field) => field.key.endsWith('_APP_SECRET'))?.secret, true)
    assert.deepEqual(channelEnvKeys('boss').slice(0, 5), [
      'CHANNEL_BOSS_ENABLED',
      'CHANNEL_BOSS_BASE_URL',
      'CHANNEL_BOSS_APP_KEY',
      'CHANNEL_BOSS_APP_SECRET',
      'CHANNEL_BOSS_WEBHOOK_TOKEN',
    ])
  })
})
