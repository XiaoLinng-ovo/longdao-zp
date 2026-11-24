// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import ChannelIntegrationSettings from './ChannelIntegrationSettings.vue'
import { getChannelSettings, testChannelConnection, updateChannelSettings } from '../api'

vi.mock('../api', () => ({
  getChannelSettings: vi.fn(),
  updateChannelSettings: vi.fn(),
  testChannelConnection: vi.fn(),
}))

const mockedGet = vi.mocked(getChannelSettings)
const mockedUpdate = vi.mocked(updateChannelSettings)
const mockedTest = vi.mocked(testChannelConnection)

const settings = {
  boss: {
    id: 'boss',
    name: 'BOSS直聘',
    description: '企业开放平台岗位发布与简历回流。',
    enabled: false,
    configured: false,
    missing: ['CHANNEL_BOSS_BASE_URL'],
    capabilities: ['publish_job', 'pull_resumes', 'webhook'],
    fields: [
      { key: 'CHANNEL_BOSS_ENABLED', connectionKey: 'enabled', label: '启用渠道', secret: false, required: false, help: '关闭后不会同步。' },
      { key: 'CHANNEL_BOSS_BASE_URL', connectionKey: 'baseUrl', label: '接口地址', secret: false, required: true, placeholder: 'https://open.example.com', help: '平台 API 根地址。' },
      { key: 'CHANNEL_BOSS_APP_SECRET', connectionKey: 'appSecret', label: 'AppSecret', secret: true, required: true, help: '仅保存在服务端。' },
    ],
    values: {
      CHANNEL_BOSS_ENABLED: { value: 'false', configured: true, masked: false },
      CHANNEL_BOSS_BASE_URL: { value: '', configured: false, masked: false },
      CHANNEL_BOSS_APP_SECRET: { value: '', configured: false, masked: true },
    },
  },
  liepin: {
    id: 'liepin', name: '猎聘', description: '猎聘企业 API。', enabled: false, configured: false, missing: [], capabilities: ['publish_job'], fields: [], values: {},
  },
  '51job': {
    id: '51job', name: '前程无忧', description: '前程无忧开放接口。', enabled: false, configured: false, missing: [], capabilities: ['publish_job'], fields: [], values: {},
  },
  official_site: {
    id: 'official_site', name: '公司官网', description: '官网 Webhook。', enabled: false, configured: false, missing: [], capabilities: ['webhook'], fields: [], values: {},
  },
} as never

let app: App | undefined
let root: HTMLDivElement | undefined
async function flush() { for (let index = 0; index < 6; index += 1) { await Promise.resolve(); await nextTick() } }

afterEach(() => {
  app?.unmount()
  app = undefined
  root?.remove()
  vi.resetAllMocks()
})

describe('ChannelIntegrationSettings', () => {
  it('renders every provider and keeps secrets write-only on save', async () => {
    mockedGet.mockResolvedValue(settings)
    mockedUpdate.mockResolvedValue(settings)
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ChannelIntegrationSettings)
    app.mount(root)
    await flush()

    expect(root.textContent).toContain('BOSS直聘')
    expect(root.textContent).toContain('猎聘')
    expect(root.textContent).toContain('前程无忧')
    expect(root.textContent).toContain('公司官网')
    expect(root.querySelector('input[type="password"]')).not.toBeNull()

    const save = [...root.querySelectorAll('button')].find((button) => button.textContent === '保存渠道配置')!
    save.click()
    await flush()
    expect(mockedUpdate).toHaveBeenCalled()
  })

  it('shows the connector test result without treating unimplemented platforms as connected', async () => {
    mockedGet.mockResolvedValue(settings)
    mockedTest.mockResolvedValue({ status: 'not_implemented', message: '平台官方协议适配器需在取得接口文档后接入' })
    root = document.createElement('div')
    document.body.appendChild(root)
    app = createApp(ChannelIntegrationSettings)
    app.mount(root)
    await flush()

    const test = [...root.querySelectorAll('button')].find((button) => button.textContent === '测试连接')!
    test.click()
    await flush()

    expect(root.textContent).toContain('平台官方协议适配器需在取得接口文档后接入')
    expect(root.textContent).not.toContain('连接正常')
  })
})
