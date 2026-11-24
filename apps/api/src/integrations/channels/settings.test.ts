import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { readChannelSettings, updateChannelSettings } from './settings.js'

describe('channel settings', () => {
  it('masks secrets and reports missing required values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-settings-'))
    const file = join(directory, '.env')
    await writeFile(file, [
      'CHANNEL_BOSS_ENABLED=true',
      'CHANNEL_BOSS_APP_KEY=key',
      'CHANNEL_BOSS_APP_SECRET=very-secret',
      '',
    ].join('\n'))

    const result = await readChannelSettings(file)

    assert.equal(result.boss.enabled, true)
    assert.equal(result.boss.configured, false)
    assert.deepEqual(result.boss.missing, ['CHANNEL_BOSS_BASE_URL'])
    assert.equal(result.boss.values.CHANNEL_BOSS_APP_KEY!.value, 'key')
    assert.equal(result.boss.values.CHANNEL_BOSS_APP_SECRET!.value, 've••••et')
    assert.equal(result.boss.values.CHANNEL_BOSS_APP_SECRET!.masked, true)
  })

  it('writes valid values and keeps secrets write-only in the read model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-settings-'))
    const file = join(directory, '.env')

    const result = await updateChannelSettings(file, {
      CHANNEL_OFFICIAL_SITE_ENABLED: 'true',
      CHANNEL_OFFICIAL_SITE_WEBHOOK_TOKEN: 'callback-token',
      CHANNEL_OFFICIAL_SITE_SIGNING_SECRET: 'signing-secret',
    })

    assert.equal(result.official_site.configured, true)
    assert.equal(result.official_site.values.CHANNEL_OFFICIAL_SITE_WEBHOOK_TOKEN!.value, 'ca••••en')
    assert.equal(result.official_site.values.CHANNEL_OFFICIAL_SITE_SIGNING_SECRET!.configured, true)
  })

  it('reports credentials as configured even while the channel is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-settings-'))
    const file = join(directory, '.env')
    await writeFile(file, [
      'CHANNEL_BOSS_ENABLED=false',
      'CHANNEL_BOSS_BASE_URL=https://open.example.com',
      'CHANNEL_BOSS_APP_KEY=key',
      'CHANNEL_BOSS_APP_SECRET=secret',
      '',
    ].join('\n'))

    const result = await readChannelSettings(file)

    assert.equal(result.boss.enabled, false)
    assert.equal(result.boss.configured, true)
  })

  it('rejects newlines and unsupported keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'channel-settings-'))
    const file = join(directory, '.env')

    await assert.rejects(
      () => updateChannelSettings(file, { CHANNEL_BOSS_APP_SECRET: 'x\ny' }),
      /不能包含换行/u,
    )
    await assert.rejects(
      () => updateChannelSettings(file, { UNKNOWN_CHANNEL_KEY: 'x' }),
      /不支持/u,
    )
  })
})
