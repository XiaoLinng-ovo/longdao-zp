export type ChannelProvider = 'boss' | 'liepin' | '51job' | 'official_site'

export type ChannelCapability = 'publish_job' | 'pull_resumes' | 'webhook'

export type ChannelEnvKey =
  | `CHANNEL_${string}_ENABLED`
  | `CHANNEL_${string}_BASE_URL`
  | `CHANNEL_${string}_APP_KEY`
  | `CHANNEL_${string}_APP_SECRET`
  | `CHANNEL_${string}_WEBHOOK_TOKEN`
  | `CHANNEL_${string}_SIGNING_SECRET`

export type ChannelConnectionFieldKey =
  | 'enabled'
  | 'baseUrl'
  | 'appKey'
  | 'appSecret'
  | 'webhookToken'
  | 'signingSecret'

export interface ChannelConnectionInput {
  enabled: boolean
  baseUrl: string
  appKey: string
  appSecret: string
  webhookToken: string
  signingSecret: string
}

export interface ChannelFieldDefinition {
  key: ChannelEnvKey
  connectionKey: ChannelConnectionFieldKey
  label: string
  secret: boolean
  required: boolean
  placeholder?: string
  help: string
}

export interface ChannelProviderDefinition {
  id: ChannelProvider
  name: string
  prefix: string
  description: string
  capabilities: readonly ChannelCapability[]
  fields: readonly ChannelFieldDefinition[]
}
