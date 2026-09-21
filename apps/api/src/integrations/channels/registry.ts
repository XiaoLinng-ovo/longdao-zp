import type {
  ChannelConnector,
  ChannelOperationResult,
  ChannelPublishJobInput,
  ChannelPullResumesInput,
  ChannelWebhookInput,
  ChannelWebhookResult,
} from './connector.js'
import { OfficialSiteConnector } from './official-site-connector.js'
import { channelProviderDefinition } from './providers.js'
import type { ChannelConnectionInput, ChannelProvider } from './types.js'

function missingRequiredFields(provider: ChannelProvider, input: ChannelConnectionInput): string[] {
  return channelProviderDefinition(provider).fields
    .filter((field) => field.required && field.connectionKey !== 'enabled' && !input[field.connectionKey].trim())
    .map((field) => field.key)
}

class PlaceholderPlatformConnector implements ChannelConnector {
  constructor(readonly provider: Exclude<ChannelProvider, 'official_site'>) {}

  async test(input: ChannelConnectionInput): Promise<ChannelOperationResult> {
    if (!input.enabled) return { status: 'not_configured', message: '渠道尚未启用' }
    const missing = missingRequiredFields(this.provider, input)
    if (missing.length) return { status: 'not_configured', message: `缺少配置：${missing.join('、')}` }
    return {
      status: 'not_implemented',
      message: '配置已保存；平台官方协议适配器需在取得接口文档后接入',
    }
  }

  async publishJob(_input: ChannelPublishJobInput): Promise<ChannelOperationResult> {
    return { status: 'not_implemented', message: '岗位发布适配器尚未接入' }
  }

  async pullResumes(_input: ChannelPullResumesInput): Promise<ChannelOperationResult> {
    return { status: 'not_implemented', message: '简历拉取适配器尚未接入' }
  }

  async verifyWebhook(_input: ChannelWebhookInput): Promise<ChannelWebhookResult> {
    return { ok: false, message: '平台回调验签协议尚未接入' }
  }
}

const connectors: Record<ChannelProvider, ChannelConnector> = {
  boss: new PlaceholderPlatformConnector('boss'),
  liepin: new PlaceholderPlatformConnector('liepin'),
  '51job': new PlaceholderPlatformConnector('51job'),
  official_site: new OfficialSiteConnector(),
}

export function createChannelConnector(provider: ChannelProvider): ChannelConnector {
  return connectors[provider]
}
