import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AdminService } from './service.js'

describe('AdminService channel settings', () => {
  it('returns masked channel settings without exposing app secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'admin-channel-settings-'))
    const file = join(directory, '.env')
    const pool = { query: async () => ({ rows: [] }) } as never
    const service = new AdminService(pool, file)
    try {
      await service.updateChannelSettings({
        CHANNEL_BOSS_ENABLED: 'true',
        CHANNEL_BOSS_BASE_URL: 'https://open.example.com',
        CHANNEL_BOSS_APP_KEY: 'app-key',
        CHANNEL_BOSS_APP_SECRET: 'app-secret',
      }, 'admin-1', 'req-1')

      const settings = await service.getChannelSettings()

      assert.equal(settings.boss.configured, true)
      assert.equal(settings.boss.values.CHANNEL_BOSS_APP_KEY!.value, 'app-key')
      assert.equal(settings.boss.values.CHANNEL_BOSS_APP_SECRET!.value, 'ap••••et')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports a complete platform configuration as not implemented instead of connected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'admin-channel-settings-'))
    const file = join(directory, '.env')
    const pool = { query: async () => ({ rows: [] }) } as never
    const service = new AdminService(pool, file)
    try {
      await service.updateChannelSettings({
        CHANNEL_BOSS_ENABLED: 'true',
        CHANNEL_BOSS_BASE_URL: 'https://open.example.com',
        CHANNEL_BOSS_APP_KEY: 'app-key',
        CHANNEL_BOSS_APP_SECRET: 'app-secret',
      }, 'admin-1')

      const result = await service.testChannelConnection('boss')

      assert.equal(result.status, 'not_implemented')
      assert.match(result.message, /接口文档/u)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
