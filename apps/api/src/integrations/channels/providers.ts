import type {
  ChannelCapability,
  ChannelEnvKey,
  ChannelFieldDefinition,
  ChannelProvider,
  ChannelProviderDefinition,
} from './types.js'

function field(
  prefix: string,
  key: ChannelFieldDefinition['connectionKey'],
  label: string,
  options: {
    secret?: boolean
    required?: boolean
    placeholder?: string
    help: string
  },
): ChannelFieldDefinition {
  const suffix = {
    enabled: 'ENABLED',
    baseUrl: 'BASE_URL',
    appKey: 'APP_KEY',
    appSecret: 'APP_SECRET',
    webhookToken: 'WEBHOOK_TOKEN',
    signingSecret: 'SIGNING_SECRET',
  }[key]
  return {
    key: `CHANNEL_${prefix}_${suffix}` as ChannelEnvKey,
    connectionKey: key,
    label,
    secret: options.secret ?? false,
    required: options.required ?? false,
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
    help: options.help,
  }
}

function platformFields(prefix: string): readonly ChannelFieldDefinition[] {
  return [
    field(prefix, 'enabled', '启用渠道', { help: '关闭后不会执行岗位发布、简历拉取或回调处理。' }),
    field(prefix, 'baseUrl', '接口地址', { required: true, placeholder: 'https://open.example.com', help: '使用平台开放文档给出的 API 根地址。' }),
    field(prefix, 'appKey', 'AppKey / 企业 ID', { required: true, help: '由平台开放平台或客户成功经理提供。' }),
    field(prefix, 'appSecret', 'AppSecret', { secret: true, required: true, help: '仅保存在服务端，页面不会回显原文。' }),
    field(prefix, 'webhookToken', '回调 Token', { secret: true, help: '用于验证平台推送的回调请求。' }),
    field(prefix, 'signingSecret', '签名密钥', { secret: true, help: '接口签名或 Webhook 验签使用。' }),
  ]
}

export const CHANNEL_PROVIDERS: readonly ChannelProviderDefinition[] = [
  {
    id: 'boss',
    name: 'BOSS直聘',
    prefix: 'BOSS',
    description: '企业开放平台岗位发布与简历回流。',
    capabilities: ['publish_job', 'pull_resumes', 'webhook'],
    fields: platformFields('BOSS'),
  },
  {
    id: 'liepin',
    name: '猎聘',
    prefix: 'LIEPIN',
    description: '猎聘企业 API 岗位同步与候选人回流。',
    capabilities: ['publish_job', 'pull_resumes', 'webhook'],
    fields: platformFields('LIEPIN'),
  },
  {
    id: '51job',
    name: '前程无忧',
    prefix: '51JOB',
    description: '前程无忧开放接口岗位同步与简历接收。',
    capabilities: ['publish_job', 'pull_resumes', 'webhook'],
    fields: platformFields('51JOB'),
  },
  {
    id: 'official_site',
    name: '公司官网',
    prefix: 'OFFICIAL_SITE',
    description: '公司官网岗位投递与签名 Webhook 回流。',
    capabilities: ['publish_job', 'webhook'],
    fields: [
      field('OFFICIAL_SITE', 'enabled', '启用渠道', { help: '启用后允许官网投递和 Webhook 回流。' }),
      field('OFFICIAL_SITE', 'baseUrl', '官网地址', { placeholder: 'https://careers.example.com', help: '招聘官网或投递页面的公开地址。' }),
      field('OFFICIAL_SITE', 'webhookToken', 'Webhook Token', { secret: true, required: true, help: '官网投递服务调用本平台时使用的 Bearer Token。' }),
      field('OFFICIAL_SITE', 'signingSecret', '签名密钥', { secret: true, required: true, help: '用于校验时间戳与请求正文的 HMAC-SHA256 签名。' }),
    ],
  },
] as const

const providerMap = new Map<ChannelProvider, ChannelProviderDefinition>(
  CHANNEL_PROVIDERS.map((provider) => [provider.id, provider]),
)

export function channelProviderDefinition(provider: ChannelProvider): ChannelProviderDefinition {
  const definition = providerMap.get(provider)
  if (!definition) throw new Error(`未知招聘渠道：${provider}`)
  return definition
}

export function channelEnvKeys(provider: ChannelProvider): readonly ChannelEnvKey[] {
  return channelProviderDefinition(provider).fields.map((item) => item.key)
}

export function channelCapabilityLabel(capability: ChannelCapability): string {
  return {
    publish_job: '岗位发布',
    pull_resumes: '简历拉取',
    webhook: '回调接收',
  }[capability]
}
